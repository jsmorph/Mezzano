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
  (event (mezzano.supervisor:make-event :name 'debugger-command)))

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

(defstruct (service-command (:constructor %make-service-command))
  boot operation argument
  (state :pending)
  result)

(defvar *service-lock* (mezzano.supervisor:make-mutex 'debugger-service))
(defvar *service-stops* (make-hash-table))
(defvar *service-next-stop-id* 0)
(defvar *service-current-stop* nil)

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

(defun debugger-stop-information (handle)
  (with-service-lock
    (let ((stop (check-service-handle handle)))
      (list :id (service-stop-id stop)
            :state (service-stop-state stop)
            :thread (copy-service-result
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

(defun release-debugger-stop (lease)
  (with-service-lock
    (let ((stop (check-service-lease lease)))
      (unless (eq (service-stop-state stop) :closed)
        (service-error :stop-active))
      (remhash (service-stop-id stop) *service-stops*)
      (clrhash (service-stop-commands stop))
      (setf (service-stop-owner stop) nil
            (service-stop-thread stop) nil
            (service-stop-parent stop) nil)))
  (values))

(defun submit-debugger-command (lease id operation &optional argument)
  (with-service-lock
    (let* ((stop (check-service-lease lease))
           (previous (gethash id (service-stop-commands stop))))
      (when previous
        (unless (and (eq operation (service-command-operation previous))
                     (eql argument (service-command-argument previous))
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
        ((:frames :restarts :condition)
         (when argument (service-error :unexpected-argument)))
        (:locals (check-service-frame argument stop))
        (:invoke-restart
         (unless (and (integerp argument)
                      (<= 0 argument)
                      (< argument (length (service-stop-restarts stop))))
           (service-error :invalid-restart)))
        (otherwise (service-error :unknown-operation)))
      (let ((command (%make-service-command
                      :boot (mezzano.supervisor:current-boot-id)
                      :operation operation :argument argument)))
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

(defun execute-service-command (stop command)
  (ecase (service-command-operation command)
    (:condition (service-print (service-stop-condition stop) t))
    (:restarts
     (loop for restart in (service-stop-restarts stop)
           for index from 0
           collect (list :index index
                         :name (service-print (restart-name restart))
                         :description (service-print restart t))))
    (:frames
     (loop for frame across (service-stop-frames stop)
           for index from 0
           collect (list :frame (%make-service-frame
                                 (service-handle stop)
                                 (service-stop-generation stop) index)
                         :function (service-print (frame-function frame)))))
    (:locals
     (let ((frame (with-service-lock
                    (check-service-frame (service-command-argument command) stop))))
       (loop for local in (frame-local-variables frame)
             for index from 0
             collect (multiple-value-bind (value available-p)
                         (local-variable-value frame local)
                       (list :index index
                             :name (service-print (local-variable-name local))
                             :available-p available-p
                             :value (when available-p (service-print value)))))))
    (:invoke-restart
     (mapcar #'service-print
             (multiple-value-list
              (invoke-restart (nth (service-command-argument command)
                                   (service-stop-restarts stop))))))))

(defun run-service-command (stop command)
  (unwind-protect
       (let ((result (execute-service-command stop command)))
         (with-service-lock
           (setf (service-command-result command) result
                 (service-command-state command) :returned
                 (service-stop-active stop) nil)))
    (with-service-lock
      (when (eq (service-command-state command) :running)
        (setf (service-command-state command) :unwound))
      (setf (service-stop-active stop) nil))))

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
          (service-stop-active stop) nil
          (service-stop-pending stop) nil)))

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
