(in-package :mezzano.debug)

(define-condition debugger-service-error (error)
  ((reason :initarg :reason :reader debugger-service-error-reason))
  (:report (lambda (condition stream)
             (format stream "Debugger service request failed: ~S."
                     (debugger-service-error-reason condition)))))

(defstruct (service-controller (:constructor %make-service-controller))
  boot closed-p)

(defstruct (service-stop (:constructor %make-service-stop))
  id thread condition restarts frames parent child owner
  (state :stopped)
  (generation 0)
  (next-command-id 0)
  (commands (make-hash-table))
  pending active
  (event (mezzano.supervisor:make-event :name 'debugger-command))
  (current-frame 0)
  (evaluation-history (make-list 9))
  (inspection-values (make-hash-table))
  (inspection-identities (make-hash-table :test #'eq))
  (next-inspection-id 0))

(defstruct (service-handle (:constructor %make-service-handle (boot stop)))
  (boot nil :read-only t)
  (stop nil :read-only t))

(defstruct (service-lease (:constructor %make-service-lease (handle controller)))
  (handle nil :read-only t)
  (controller nil :read-only t))

(defstruct (service-frame (:constructor %make-service-frame (handle generation index)))
  (handle nil :read-only t)
  (generation 0 :read-only t)
  (index 0 :read-only t))

(defstruct (service-inspection-reference
             (:constructor %make-service-inspection-reference (handle generation kind id)))
  (handle nil :read-only t)
  (generation 0 :read-only t)
  (kind nil :read-only t)
  (id 0 :read-only t))

(defstruct (service-command (:constructor %make-service-command))
  boot operation argument
  (state :pending)
  result)

(defvar *service-lock* (mezzano.supervisor:make-mutex 'debugger-service))
(defvar *service-stops* (make-hash-table))
(defvar *service-next-stop-id* 0)
(defvar *service-current-stop* nil)
(defvar *service-current-command* nil)

(defmacro with-service-lock (&body body)
  `(handler-case
       (mezzano.supervisor:without-footholds
         (mezzano.supervisor:with-mutex (*service-lock*)
           ,@body))
     (error (condition) (error condition))))

(defun service-error (reason)
  (error 'debugger-service-error :reason reason))

(defun service-handle (stop)
  (%make-service-handle (mezzano.supervisor:current-boot-id) stop))

(defun check-service-handle (handle)
  (unless (and (service-handle-p handle)
               (eq (service-handle-boot handle)
                   (mezzano.supervisor:current-boot-id)))
    (service-error :expired-stop))
  (let ((stop (service-handle-stop handle)))
    (unless (eq (gethash (service-stop-id stop) *service-stops*) stop)
      (service-error :released-stop))
    stop))

(defun check-service-controller (controller)
  (unless (and (service-controller-p controller)
               (eq (service-controller-boot controller)
                   (mezzano.supervisor:current-boot-id))
               (not (service-controller-closed-p controller)))
    (service-error :expired-controller))
  controller)

(defun check-service-lease (lease)
  (unless (service-lease-p lease)
    (service-error :expired-control))
  (let ((stop (check-service-handle (service-lease-handle lease))))
    (check-service-controller (service-lease-controller lease))
    (unless (eq (service-stop-owner stop) lease)
      (service-error :expired-control))
    stop))

(defun check-service-frame (reference stop)
  (unless (and (service-frame-p reference)
               (eq (check-service-handle (service-frame-handle reference)) stop)
               (eql (service-frame-generation reference)
                    (service-stop-generation stop))
               (eq (service-stop-state stop) :stopped))
    (service-error :expired-frame))
  (aref (service-stop-frames stop) (service-frame-index reference)))

(defclass service-frame-variable (mezzano.full-eval::lexical-variable)
  ((reference :initarg :reference :reader service-variable-reference)
   (binding :initarg :binding :reader service-variable-binding)
   (type :initarg :type :reader service-variable-type)))

(defun service-frame-for-access (reference)
  (with-service-lock
    (let* ((stop (check-service-handle (service-frame-handle reference)))
           (frame (check-service-frame reference stop)))
      (unless (eq (mezzano.supervisor:current-thread) (service-stop-thread stop))
        (service-error :foreign-frame-thread))
      frame)))

(defun service-variable-location (variable)
  (let* ((frame (service-frame-for-access (service-variable-reference variable)))
         (raw (mezzano.internals::frame-raw-data frame))
         (local (find (service-variable-binding variable)
                      (mezzano.internals::frame-locals raw) :key #'fifth)))
    (unless local (service-error :unavailable-binding))
    (values raw local)))

(defmethod mezzano.full-eval::variable-value ((variable service-frame-variable))
  (multiple-value-bind (raw local) (service-variable-location variable)
    (multiple-value-bind (value available-p)
        (mezzano.internals::read-frame-slot raw (third local) (fourth local))
      (unless available-p (service-error :unavailable-binding))
      value)))

(defmethod (setf mezzano.full-eval::variable-value) (value (variable service-frame-variable))
  (multiple-value-bind (raw local) (service-variable-location variable)
    (unless (typep value (service-variable-type variable))
      (error 'type-error :datum value :expected-type (service-variable-type variable)))
    (mezzano.internals::write-frame-slot raw (third local) value (fourth local))
    value))

(defmethod make-load-form ((variable service-frame-variable) &optional environment)
  (declare (ignore environment))
  (service-error :live-frame-binding))

(defun service-frame-environment (reference)
  (let ((frame (service-frame-for-access reference)))
    (multiple-value-bind (function offset)
        (mezzano.internals::function-from-frame (mezzano.internals::frame-raw-data frame))
      (let ((scope (mezzano.internals::source-scope-at-offset function offset))
            (environment (make-instance 'mezzano.compiler::lexical-environment))
            (variables nil)
            (types nil))
        (when (eq scope :unknown) (service-error :unavailable-lexical-scope))
        (labels ((live (name binding type)
                   (make-instance 'service-frame-variable :name name :reference reference
                                  :binding binding :type type))
                 (control-target (entry)
                   (list (first entry)
                         (lambda (&rest arguments)
                           (declare (ignore arguments))
                           (service-frame-for-access reference)
                           (service-error :unavailable-control-target)))))
          (dolist (entry (getf scope :variables))
            (destructuring-bind (name kind data type) entry
              (let ((binding
                      (ecase kind
                        (:lexical (live name data type))
                        (:special
                         (make-instance 'mezzano.compiler::special-variable
                                        :name name :implicitly-declared data))
                        (:symbol-macro
                         (make-instance 'mezzano.compiler::symbol-macro
                                        :name name :expansion data)))))
                (push (list name binding) variables)
                (push (list binding type) types))))
          (setf (slot-value environment 'mezzano.compiler::%variables) (nreverse variables)
                (slot-value environment 'mezzano.compiler::%variable-type-decls) (nreverse types)
                (slot-value environment 'mezzano.compiler::%functions)
                (loop for (name kind data) in (getf scope :functions)
                      collect
                      (list name
                            (ecase kind
                              (:lexical (live name data 'function))
                              (:macro (check-type data function) data)
                              (:global
                               (make-instance 'mezzano.compiler::top-level-function :name name)))))
                (slot-value environment 'mezzano.compiler::%blocks)
                (mapcar #'control-target (getf scope :blocks))
                (slot-value environment 'mezzano.compiler::%go-tags)
                (mapcar #'control-target (getf scope :go-tags))
                (slot-value environment 'mezzano.compiler::%inline-decls)
                (copy-tree (getf scope :inline-declarations))
                (slot-value environment 'mezzano.compiler::%optimize)
                (copy-list (getf scope :optimize)))
          environment)))))

(defun read-service-expression ()
  (let ((read-p nil))
    (unwind-protect
         (prog1 (let ((*read-eval* nil)) (read *query-io*))
           (setf read-p t))
      (unless read-p (clear-input *query-io*)))))

(defun service-evaluate-input (stop reader &optional print-p)
  (let* ((reference (%make-service-frame (service-handle stop)
                                        (service-stop-generation stop)
                                        (service-stop-current-frame stop)))
         (environment (service-frame-environment reference))
         (history-symbols '(+ ++ +++ * ** *** / // ///))
         (mezzano.internals::*eval-hook* 'mezzano.full-eval:eval-in-lexenv))
    (progv history-symbols (service-stop-evaluation-history stop)
      (unwind-protect
           (let* ((form (funcall reader))
                  (- form)
                  (values (multiple-value-list
                           (mezzano.full-eval:eval-in-lexenv form environment))))
             (declare (special -))
             (setf +++ ++ ++ + + form
                   *** ** ** * * (first values)
                   /// // // / / values)
             (if print-p (mapcar #'service-print values) values))
        (setf (service-stop-evaluation-history stop)
              (mapcar #'symbol-value history-symbols))))))

(defun service-evaluate (stop source)
  (service-evaluate-input
   stop
   (lambda ()
     (with-input-from-string (stream source)
       (let* ((*read-eval* nil)
              (end (list :end))
              (form (read stream nil end)))
         (when (or (eq form end) (not (eq (read stream nil end) end)))
           (service-error :expected-one-form))
         form)))
   t))

(defun make-debugger-controller ()
  (%make-service-controller :boot (mezzano.supervisor:current-boot-id)))

(defun close-debugger-controller (controller)
  (with-service-lock
    (check-type controller service-controller)
    (setf (service-controller-closed-p controller) t)
    (maphash (lambda (id stop)
               (declare (ignore id))
               (let ((owner (service-stop-owner stop)))
                 (when (and owner
                            (eq (service-lease-controller owner) controller))
                   (setf (service-stop-owner stop) nil))))
             *service-stops*))
  (values))

(defun debugger-stops (&key include-closed)
  (with-service-lock
    (loop for stop being the hash-values of *service-stops*
          when (or include-closed (eq (service-stop-state stop) :stopped))
            collect (service-handle stop))))

(defun bounded-display-label (object)
  (let* ((remaining 32)
         (characters 0)
         (truncated nil)
         (text
           (with-output-to-string (stream)
             (block render
               (labels ((emit (text)
                          (loop for character across text
                                do (when (= characters 160)
                                     (setf truncated t)
                                     (return-from render))
                                   (write-char (if (or (< (char-code character) 32)
                                                       (= (char-code character) 127))
                                                   #\Space character)
                                               stream)
                                   (incf characters)))
                        (visit (value depth)
                          (when (or (zerop remaining) (= depth 4))
                            (setf truncated t)
                            (return-from render))
                          (decf remaining)
                          (typecase value
                            (string (emit value))
                            (symbol
                             (when (keywordp value) (emit ":"))
                             (emit (symbol-name value)))
                            (character (emit (string value)))
                            (fixnum (emit (format nil "~D" value)))
                            (cons
                             (emit "(")
                             (loop for tail = value then (cdr tail)
                                   do (visit (car tail) (1+ depth))
                                      (cond ((null (cdr tail)) (emit ")") (return))
                                            ((consp (cdr tail)) (emit " "))
                                            (t (emit " . ")
                                               (visit (cdr tail) (1+ depth))
                                               (emit ")")
                                               (return)))))
                            (t (emit "[object]")))))
                 (visit object 0))))))
    (if truncated
        (concatenate 'string (subseq text 0 (min (length text) 149)) "[truncated]")
        text)))

(defun service-stop-depth (stop)
  (loop for current = stop then (service-stop-parent current)
        while current count t))

(defun service-stop-prompt (stop)
  (concatenate 'string
               (make-string (service-stop-depth stop)
                            :initial-element (code-char #x2192))
               " "))

(defun service-thread-current-stop (thread)
  (loop for stop being the hash-values of *service-stops*
        when (and (eq (service-stop-thread stop) thread)
                  (eq (service-stop-state stop) :stopped)
                  (null (service-stop-child stop)))
          return stop))

(defun service-thread-debugger-information (thread)
  (let ((stop (service-thread-current-stop thread)))
    (when stop
      (list :stop (service-handle stop)
            :depth (service-stop-depth stop)
            :prompt (service-stop-prompt stop)))))

(defun debugger-stop-information (handle)
  (with-service-lock
    (let ((stop (check-service-handle handle)))
      (list :id (service-stop-id stop)
            :state (service-stop-state stop)
            :depth (service-stop-depth stop)
            :prompt (service-stop-prompt stop)
            :thread (bounded-display-label
                     (mezzano.supervisor:thread-name (service-stop-thread stop)))
            :parent-id (when (service-stop-parent stop)
                         (service-stop-id (service-stop-parent stop)))
            :parent (let ((parent (service-stop-parent stop)))
                      (when (and parent
                                 (eq (gethash (service-stop-id parent) *service-stops*)
                                     parent))
                        (service-handle parent)))
            :child (when (service-stop-child stop)
                     (service-handle (service-stop-child stop)))
            :generation (service-stop-generation stop)
            :current-frame (when (eq (service-stop-state stop) :stopped)
                             (service-stop-current-frame stop))
            :next-command-id (service-stop-next-command-id stop)))))

(defun attach-debugger-stop (handle controller)
  (with-service-lock
    (let* ((stop (check-service-handle handle))
           (owner (service-stop-owner stop)))
      (check-service-controller controller)
      (when (and owner
                 (eq (service-handle-boot (service-lease-handle owner))
                     (mezzano.supervisor:current-boot-id)))
        (service-error :already-controlled))
      (setf (service-stop-owner stop)
            (%make-service-lease handle controller)))))

(defun release-service-stop (stop)
  (unless (eq (service-stop-state stop) :closed)
    (service-error :stop-active))
  (remhash (service-stop-id stop) *service-stops*)
  (clrhash (service-stop-commands stop))
  (setf (service-stop-owner stop) nil
        (service-stop-thread stop) nil
        (service-stop-parent stop) nil))

(defun release-debugger-stop (lease)
  (with-service-lock
    (release-service-stop (check-service-lease lease)))
  (values))

(defun service-restart (stop index)
  (if (null index)
      (or (find 'continue (service-stop-restarts stop) :key #'restart-name)
          (service-error :no-continue-restart))
      (if (and (integerp index) (<= 0 index)
               (< index (length (service-stop-restarts stop))))
          (nth index (service-stop-restarts stop))
          (service-error :invalid-restart))))

(defun service-frame-target (stop operation argument)
  (case operation
    ((:current-frame :top-frame :bottom-frame)
     (when argument (service-error :unexpected-argument)))
    (otherwise
     (unless (and (integerp argument) (<= 0 argument))
       (service-error :invalid-frame))))
  (let ((index (ecase operation
                 (:current-frame (service-stop-current-frame stop))
                 (:select-frame argument)
                 (:next-frame (+ (service-stop-current-frame stop) argument))
                 (:previous-frame (- (service-stop-current-frame stop) argument))
                 (:top-frame 0)
                 (:bottom-frame (1- (length (service-stop-frames stop)))))))
    (unless (< -1 index (length (service-stop-frames stop)))
      (service-error :invalid-frame))
    index))

(defun submit-debugger-command (lease id operation &optional argument)
  (with-service-lock
    (let* ((stop (check-service-lease lease))
           (previous (gethash id (service-stop-commands stop))))
      (when previous
        (unless (and (eq operation (service-command-operation previous))
                     (if (member operation '(:evaluate :inspect :modify :bindings))
                         (equal argument (service-command-argument previous))
                         (eql argument (service-command-argument previous)))
                     (eq (service-command-boot previous)
                         (mezzano.supervisor:current-boot-id)))
          (service-error :request-conflict))
        (return-from submit-debugger-command id))
      (unless (eql id (service-stop-next-command-id stop))
        (service-error :request-order))
      (unless (eq (service-stop-state stop) :stopped)
        (service-error :stop-closed))
      (when (or (service-stop-pending stop) (service-stop-active stop)
                (service-stop-child stop))
        (service-error :stop-busy))
      (case operation
        ((:frames :restarts :condition :abort :help :clear-inspection :arglist)
         (when argument (service-error :unexpected-argument)))
        (:proceed
         (when argument (service-error :unexpected-argument))
         (service-restart stop nil))
        (:invoke-restart-with-arguments (service-restart stop argument))
        (:locals (check-service-frame argument stop))
        ((:inspect :modify :describe-object)
         (check-service-inspection-argument stop operation argument))
        (:bindings
         (unless (or (null argument)
                     (typep argument '(cons (member nil t) (cons string null))))
           (service-error :invalid-binding-options)))
        (:evaluate
         (unless (stringp argument) (service-error :invalid-source)))
        ((:current-frame :select-frame :next-frame :previous-frame :top-frame :bottom-frame)
         (service-frame-target stop operation argument))
        ((:invoke-restart :invoke-restart-interactively)
         (unless (and (integerp argument)
                      (<= 0 argument)
                      (< argument (length (service-stop-restarts stop))))
           (service-error :invalid-restart)))
        (otherwise (service-error :unknown-operation)))
      (let ((command (%make-service-command
                      :boot (mezzano.supervisor:current-boot-id)
                      :operation operation :argument (case operation
                                                       (:evaluate (copy-seq argument))
                                                       ((:inspect :modify) (copy-list argument))
                                                       (:bindings (when argument
                                                                    (list (first argument)
                                                                          (copy-seq (second argument)))))
                                                       (otherwise argument)))))
        (setf (gethash id (service-stop-commands stop)) command
              (service-stop-pending stop) command
              (mezzano.supervisor:event-state (service-stop-event stop)) t)
        (incf (service-stop-next-command-id stop)))
      id)))

(defun copy-service-result (value)
  (typecase value
    (cons (cons (copy-service-result (car value))
                (copy-service-result (cdr value))))
    (string (copy-seq value))
    (t value)))

(defun debugger-command-result (handle id)
  (with-service-lock
    (let* ((stop (check-service-handle handle))
           (command (gethash id (service-stop-commands stop))))
      (unless command (service-error :unknown-command))
      (list :state (service-command-state command)
            :operation (service-command-operation command)
            :current-boot-p (eq (service-command-boot command)
                               (mezzano.supervisor:current-boot-id))
            :result (copy-service-result (service-command-result command))))))

(defun service-print (object &optional aesthetic)
  (let ((*print-readably* nil)
        (*print-circle* t)
        (*print-level* 5)
        (*print-length* 20))
    (if aesthetic (princ-to-string object) (prin1-to-string object))))

(defun service-frame-locals (frame)
  (loop for local in (frame-local-variables frame)
        for index from 0
        collect (multiple-value-bind (value available-p)
                    (local-variable-value frame local)
                  (list :index index
                        :name (service-print (local-variable-name local))
                        :available-p available-p
                        :value (when available-p (service-print value))))))

(defun service-frame-bindings (frame)
  (declare (ignorable frame))
  #+x86-64
  (let ((raw (mezzano.internals::frame-raw-data frame)))
    (unless (and (mezzano.internals::frame-stack-available-p raw)
                 (not (mezzano.internals::frame-interrupted-p frame)))
      (return-from service-frame-bindings (values nil nil)))
    (let* ((lower (mezzano.internals::frame-fp frame))
           (upper (mezzano.internals::memref-unsigned-byte-64 lower)))
      (values
       (loop for cell = (mezzano.internals::%%special-stack-pointer)
               then (mezzano.internals::%object-ref-t cell 0)
             while cell
             when (and (mezzano.runtime::symbol-value-cell-p cell)
                       (< lower
                          (- (mezzano.internals::lisp-object-address cell)
                             mezzano.internals::+tag-object+)
                          upper))
               collect
               (let ((bound-p (mezzano.runtime::symbol-value-cell-boundp cell)))
                 (list (mezzano.runtime::symbol-value-cell-symbol cell) bound-p
                       (when bound-p (mezzano.runtime::symbol-value-cell-value cell)))))
       t)))
  #-x86-64
  (values nil nil))

(defun service-show-bindings (stop argument)
  (let ((all-p (first argument))
        (matching (if argument (second argument) ""))
        (found nil))
    (with-output-to-string (stream)
      (loop for frame across (service-stop-frames stop)
            for index from 0
            when (or all-p (= index (service-stop-current-frame stop)))
              do (multiple-value-bind (bindings available-p) (service-frame-bindings frame)
                   (setf bindings
                         (remove-if-not (lambda (binding)
                                          (search matching (symbol-name (first binding))))
                                        bindings))
                   (when (or bindings (not available-p) (not all-p))
                     (setf found t)
                     (format stream "Frame ~D ~A:~%" index (service-print (frame-function frame)))
                     (cond ((not available-p) (write-line "  Binding locations unavailable." stream))
                           ((null bindings) (write-line "  No matching bindings." stream))
                           (t (dolist (binding bindings)
                                (format stream "  ~A: ~A~%"
                                        (service-print (first binding))
                                        (if (second binding)
                                            (service-print (third binding))
                                            "[unbound]"))))))))
      (unless found (write-line "No matching bindings." stream)))))

(defun execute-service-command (stop command)
  (ecase (service-command-operation command)
    (:condition (service-print (service-stop-condition stop) t))
    (:evaluate (service-evaluate stop (service-command-argument command)))
    (:inspect (service-inspect stop (service-command-argument command)))
    (:modify (service-modify-inspection stop (service-command-argument command)))
    (:describe-object (service-describe-inspection stop (service-command-argument command)))
    (:clear-inspection (clear-service-inspection stop))
    (:help (mezzano.command-processor::debugger-help))
    (:abort
     (let ((restart (find 'abort (service-stop-restarts stop) :key #'restart-name)))
       (unless restart (service-error :no-abort-restart))
       (mapcar #'service-print (multiple-value-list (invoke-restart restart)))))
    (:proceed
     (mapcar #'service-print
             (multiple-value-list
              (invoke-restart-interactively (service-restart stop nil)))))
    (:invoke-restart-with-arguments
     (let ((restart (service-restart stop (service-command-argument command))))
       (write-string "Restart arguments (Lisp expression returning a list): " *query-io*)
       (finish-output *query-io*)
       (let* ((form (read-service-expression))
              (arguments (eval form)))
         (unless (list-length arguments)
           (error "Restart arguments must be a finite proper list."))
         (mapcar #'service-print
                 (multiple-value-list (apply #'invoke-restart restart arguments))))))
    (:restarts
     (loop with default = (find 'continue (service-stop-restarts stop) :key #'restart-name)
           for restart in (service-stop-restarts stop)
           for index from 0
           collect (list :index index
                         :name (service-print (restart-name restart))
                         :description (service-print restart t)
                         :default-p (eq restart default))))
    (:frames
     (loop for frame across (service-stop-frames stop)
           for index from 0
           collect (list :frame (%make-service-frame
                                 (service-handle stop)
                                 (service-stop-generation stop) index)
                         :function (service-print (frame-function frame)))))
    (:bindings (service-show-bindings stop (service-command-argument command)))
    (:arglist
     (multiple-value-bind (called function)
         (frame-function (aref (service-stop-frames stop) (service-stop-current-frame stop)))
       (let ((info (when (functionp function)
                     (mezzano.internals::function-debug-info function))))
         (if (nthcdr 7 info)
             (format nil "The argument list for ~A is ~A."
                     (service-print (mezzano.internals::function-name function))
                     (service-print (mezzano.internals::debug-info-lambda-list info)))
             (format nil "Argument list unavailable for ~A." (service-print called))))))
    (:locals
     (service-frame-locals
      (with-service-lock
        (check-service-frame (service-command-argument command) stop))))
    ((:current-frame :select-frame :next-frame :previous-frame :top-frame :bottom-frame)
     (multiple-value-bind (frame index)
         (with-service-lock
           (let ((index (service-frame-target stop (service-command-operation command)
                                              (service-command-argument command))))
             (setf (service-stop-current-frame stop) index)
             (values (aref (service-stop-frames stop) index) index)))
       (list :index index
             :function (service-print (frame-function frame))
             :locals (service-frame-locals frame))))
    ((:invoke-restart :invoke-restart-interactively)
     (mapcar #'service-print
             (multiple-value-list
              (funcall (if (eq (service-command-operation command) :invoke-restart-interactively)
                           #'invoke-restart-interactively
                           #'invoke-restart)
                       (nth (service-command-argument command)
                            (service-stop-restarts stop))))))))

(defun run-service-command (stop command)
  (let ((mezzano.internals::*active-handlers* nil))
    (with-simple-restart (abort "Abort this debugger command.")
      (unwind-protect
           (let ((result (let ((*service-current-command* command))
                           (execute-service-command stop command))))
             (with-service-lock
               (setf (service-command-result command) result
                     (service-command-state command) :returned
                     (service-stop-active stop) nil)))
        (with-service-lock
          (when (eq (service-command-state command) :running)
            (setf (service-command-state command) :unwound))
          (setf (service-stop-active stop) nil))))))

(defun service-command-loop (stop)
  (loop
    (mezzano.supervisor:event-wait (service-stop-event stop))
    (let ((command
            (with-service-lock
              (let ((command (service-stop-pending stop)))
                (setf (service-stop-pending stop) nil
                      (mezzano.supervisor:event-state (service-stop-event stop)) nil)
                (when command
                  (cond ((eq (service-command-boot command)
                             (mezzano.supervisor:current-boot-id))
                         (setf (service-command-state command) :running
                               (service-stop-active stop) command)
                         command)
                        (t
                         (setf (service-command-state command) :expired)
                         nil)))))))
      (when command (run-service-command stop command)))))

(defun close-service-stop (stop)
  (with-service-lock
    (dolist (command (list (service-stop-pending stop) (service-stop-active stop)))
      (when command
        (setf (service-command-state command)
              (if (eq (service-command-state command) :pending)
                  :cancelled
                  :unwound))))
    (when (service-stop-parent stop)
      (setf (service-stop-child (service-stop-parent stop)) nil))
    (incf (service-stop-generation stop))
    (setf (service-stop-state stop) :closed
          (service-stop-condition stop) nil
          (service-stop-restarts stop) nil
          (service-stop-frames stop) nil
          (service-stop-current-frame stop) nil
          (service-stop-evaluation-history stop) nil
          (service-stop-active stop) nil
          (service-stop-pending stop) nil)
    (clrhash (service-stop-inspection-values stop))
    (clrhash (service-stop-inspection-identities stop))))

(defun service-debugger (condition)
  (let* ((boundary (mezzano.internals::read-frame-pointer))
         (stop (%make-service-stop
                :thread (mezzano.supervisor:current-thread)
                :condition condition :restarts (compute-restarts condition)
                :parent *service-current-stop*))
         (*service-current-stop* stop)
         (*debugger-hook* #'service-debugger-hook)
         (*global-debugger* #'service-debugger))
    (unwind-protect
         (progn
           (let ((frames nil)
                 (found nil))
             (map-backtrace
              (lambda (frame)
                (when (= (mezzano.internals::frame-fp frame) boundary)
                  (setf found t))
                (when found (push frame frames))))
             (unless found (error "Debugger activation missing from backtrace."))
             (setf (service-stop-frames stop) (coerce (nreverse frames) 'vector)))
           (with-service-lock
             (when (service-stop-parent stop)
               (setf (service-stop-child (service-stop-parent stop)) stop))
             (setf (service-stop-id stop) (incf *service-next-stop-id*)
                   (gethash (service-stop-id stop) *service-stops*) stop))
           (service-command-loop stop))
      (close-service-stop stop))))

(defun service-debugger-hook (condition previous-hook)
  (declare (ignore previous-hook))
  (service-debugger condition))

(defun call-with-debugger-service (function)
  (let ((*debugger-hook* #'service-debugger-hook)
        (*global-debugger* #'service-debugger))
    (funcall function)))
