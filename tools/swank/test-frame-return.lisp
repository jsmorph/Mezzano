(defpackage #:lispm-frame-return-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals)
                    (#:d #:mezzano.debug)
                    (#:s #:mezzano.supervisor)
                    (#:dc #:mezzano.delimited-continuations)
                    (#:sys.lap-x86 #:mezzano.lap.x86))
  (:export #:run))
(in-package #:lispm-frame-return-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *probe* 0)
(defvar *events* nil)

(defun invoke-return (function values)
  (let ((selected nil))
    (i::map-backtrace
     (lambda (frame)
       (when (eq (nth-value 1 (i::frame-function frame)) function)
         (assert (null selected))
         (setf selected frame))))
    (assert selected)
    (i::return-from-frame selected values)
    (error "Frame return fell through.")))

(defun target (action a b c d e f)
  (assert (equal (list a b c d e f) '(1 2 3 4 5 6)))
  (let ((*probe* 22))
    (unwind-protect
         (unwind-protect
              (progn (funcall action) (error "Target resumed."))
           (push (list :inner *probe*) *events*)
           (mezzano.extensions:gc :full t))
      (push (list :outer *probe*) *events*))))

(defun caller (action expected)
  (let ((*probe* 11))
    (let ((result (multiple-value-list (target action 1 2 3 4 5 6))))
      (assert (equalp result expected) () "~S /= ~S." result expected)
      (assert (= *probe* 11))
      (assert (equal (reverse *events*) '((:inner 22) (:outer 22))))
      :caller-continued)))

(defun with-prompts (depth thunk)
  (if (zerop depth)
      (funcall thunk)
      (dc:call-with-prompt
       (dc:make-prompt-tag "Owned frame Return")
       (lambda () (with-prompts (1- depth) thunk))
       (lambda (&rest values)
         (declare (ignore values))
         (error "Unexpected prompt handler.")))))

(defun run-direct ()
  (dolist (depth '(0 1 2))
    (dolist (values (list nil '(42)
                         (list (list :one) (vector :two) 3 4 5
                               (list :six) (vector :seven))))
      (let ((*events* nil))
        (assert (eq (caller
                     (lambda ()
                       (with-prompts depth
                         (lambda () (invoke-return #'target values))))
                     values)
                    :caller-continued)))
      (assert (= *probe* 0))))
  (let ((*events* nil))
    (assert
     (eq (catch 'superseding-return
           (target
            (lambda ()
              (unwind-protect
                   (invoke-return #'target '(42))
                (push :superseding *events*)
                (throw 'superseding-return :superseded)))
            1 2 3 4 5 6)
           :fell-through)
         :superseded))
    (assert (equal (reverse *events*)
                   '(:superseding (:inner 22) (:outer 22))))
    (assert (= *probe* 0)))
  :frame-return-primitive-passed)

(define-condition cleanup-note (condition) ())
(defvar *return-count* 0)

(defun stopped-target (state depth cleanup-error)
  (let ((*probe* 22))
    (unwind-protect
         (progn
           (with-prompts depth (lambda () (break "Owned selected-frame Return.")))
           (error "Stopped target resumed."))
      (incf (aref state 1))
      (assert (= *probe* 22))
      (signal 'cleanup-note)
      (when cleanup-error
        (cerror "Continue the owned cleanup." "Owned Return cleanup condition."))
      (mezzano.extensions:gc :full t))))

(defun run-retained-case (depth cleanup-error)
  (let* ((controller (d:make-debugger-controller))
         (name (symbol-name (gensym "Frame Return test ")))
         (state (make-array 4 :initial-element nil))
         (handle nil)
         (lease nil)
         (cleanup-handle nil)
         (cleanup-lease nil)
         (source
           "(progn (incf lispm-frame-return-test::*return-count*) (lispm-frame-return-test::invoke-return #'lispm-frame-return-test::stopped-target '(1 2 3 4 5 6 7)))")
         (thread
           (progn
             (setf (aref state 1) 0 (aref state 2) 0 *return-count* 0)
             (s:make-thread
              (lambda ()
                (d:call-with-debugger-service
                 (lambda ()
                   (with-simple-restart (abort "Abort the owned Return thread.")
                     (let ((*probe* 11))
                       (handler-bind
                           ((cleanup-note
                              (lambda (condition)
                                (declare (ignore condition))
                                (assert (= *probe* 22))
                                (incf (aref state 2)))))
                         (setf (aref state 0)
                               (multiple-value-list
                                (stopped-target state depth cleanup-error))))
                       (assert (= *probe* 11))
                       (setf (aref state 3) :continued))))))
              :name name))))
    (unwind-protect
         (progn
           (setf handle (lispm-service-test::await
                         (lambda () (lispm-service-test::stop-for-thread name)))
                 lease (d:attach-debugger-stop handle controller))
           (let* ((id (getf (d:debugger-stop-information handle) :next-command-id)))
             (d:submit-debugger-command lease id :evaluate source)
             (assert (eq (getf (lispm-service-test::completed-command handle id) :state)
                         :unwound))
             (lispm-service-test::await
              (lambda () (eq (getf (d:debugger-stop-information handle) :state) :closed)))
             (d:submit-debugger-command lease id :evaluate (copy-seq source))
             (assert (= *return-count* 1))
             (when cleanup-error
               (setf cleanup-handle
                     (lispm-service-test::await
                      (lambda () (lispm-service-test::stop-for-thread name)))
                     cleanup-lease (d:attach-debugger-stop cleanup-handle controller))
               (assert (null (getf (d:debugger-stop-information cleanup-handle) :parent)))
               (assert (search "Owned Return cleanup condition."
                               (lispm-service-test::command cleanup-handle cleanup-lease :condition)))
               (let ((proceed (getf (d:debugger-stop-information cleanup-handle) :next-command-id)))
                 (d:submit-debugger-command cleanup-lease proceed :proceed)
                 (assert (eq (getf (lispm-service-test::completed-command cleanup-handle proceed) :state)
                             :unwound))))
             (lispm-service-test::await
              (lambda () (nth-value 1 (s:thread-join thread nil))))
             (assert (equal (aref state 0) '(1 2 3 4 5 6 7)))
             (assert (= (aref state 1) 1))
             (assert (= (aref state 2) 1))
             (assert (eq (aref state 3) :continued))
             (assert (= *return-count* 1))))
      (when cleanup-handle
        (lispm-frame-evaluation-test::release-test-stop cleanup-handle controller))
      (when handle
        (lispm-frame-evaluation-test::release-test-stop handle controller))
      (d:close-debugger-controller controller))
    t))

(defun run-retained ()
  (run-retained-case 0 nil)
  (run-retained-case 2 nil)
  (run-retained-case 2 t)
  :retained-frame-return-passed)

#+x86-64
(i::define-lap-function frameless-guard ((callback))
  (:gc :no-frame :layout #*0)
  (sys.lap-x86:push :r8)
  (:gc :no-frame :layout #*10)
  (sys.lap-x86:mov64 :rbx :r8)
  (sys.lap-x86:xor32 :ecx :ecx)
  (sys.lap-x86:call (:object :rbx #.i::+function-entry-point+))
  (:gc :no-frame :layout #*10)
  (sys.lap-x86:add64 :rsp 8)
  (:gc :no-frame :layout #*0 :multiple-values 0)
  (sys.lap-x86:ret))

#+x86-64
(i::define-lap-function framed-guard ((callback))
  (:gc :no-frame :layout #*0)
  (sys.lap-x86:push :rbp)
  (:gc :no-frame :layout #*00)
  (sys.lap-x86:mov64 :rbp :rsp)
  (:gc :frame)
  (sys.lap-x86:mov64 :rbx :r8)
  (sys.lap-x86:xor32 :ecx :ecx)
  (sys.lap-x86:call (:object :rbx #.i::+function-entry-point+))
  (:gc :frame :multiple-values 0)
  (sys.lap-x86:leave)
  (:gc :no-frame :layout #*0 :multiple-values 0)
  (sys.lap-x86:ret))

(defun context-reason-for-function (function)
  (let ((selected nil))
    (i::map-backtrace
     (lambda (frame)
       (when (eq (nth-value 1 (i::frame-function frame)) function)
         (assert (null selected))
         (setf selected frame))))
    (assert selected)
    (multiple-value-bind (fp head reason) (i::frame-return-context selected)
      (assert (null fp))
      (assert (null head))
      reason)))

(defun interrupted-work (state)
  (setf (aref state 0) t)
  (loop until (aref state 1))
  :done)

(defun with-interrupted-flag-guards (function callback)
  (let ((selected nil) (interrupted nil))
    (i::map-backtrace
     (lambda (frame)
       (unless selected
         (when (i::frame-interrupted-p frame) (setf interrupted frame))
         (when (eq (nth-value 1 (i::frame-function frame)) function)
           (setf selected frame)))))
    (assert selected)
    (assert interrupted)
    (let* ((slot (i::frame-pc-slot interrupted))
           (flags (i::memref-unsigned-byte-64 slot 2)))
      (assert (logbitp 9 flags))
      (assert (not (logbitp 8 flags)))
      (dolist (unsupported (list (logandc2 flags #x200) (logior flags #x100)))
        (unwind-protect
             (progn
               (setf (i::memref-unsigned-byte-64 slot 2) unsupported)
               (funcall callback selected))
          (setf (i::memref-unsigned-byte-64 slot 2) flags))))))

(defun run-interruption-guard ()
  (let* ((name (symbol-name (gensym "Frame Return interruption guard ")))
         (controller (d:make-debugger-controller))
         (state (make-array 3 :initial-element nil))
         (thread
           (s:make-thread
            (lambda ()
              (d:call-with-debugger-service
               (lambda ()
                 (with-simple-restart (abort "Abort the owned interruption guard.")
                   (interrupted-work state)))))
            :name name)))
    (unwind-protect
         (progn
           (lispm-service-test::await (lambda () (aref state 0)))
           (s:establish-thread-foothold
            thread
            (lambda ()
              (with-interrupted-flag-guards
               #'interrupted-work
               (lambda (frame)
                 (declare (ignore frame))
                 (assert (eq (context-reason-for-function #'interrupted-work)
                             :interrupt-boundary))))
              (setf (aref state 2) t)))
           (lispm-service-test::await (lambda () (aref state 2))))
      (setf (aref state 1) t)
      (let ((stop (lispm-service-test::stop-for-thread name)))
        (when stop (lispm-frame-evaluation-test::release-test-stop stop controller)))
      (lispm-service-test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
      (d:close-debugger-controller controller)))
  t)

(defun run-guards ()
  (assert
   (eq (frameless-guard
        (lambda () (context-reason-for-function #'frameless-guard)))
       :frameless-frame))
  (assert
   (eq (framed-guard
        (lambda () (context-reason-for-function #'framed-guard)))
       :unavailable-source-scope))
  (assert (eq (nth-value 2
                        (i::frame-return-context (i::make-frame :fp 0 :pc-slot 0)))
              :inactive-frame))
  (run-interruption-guard)
  t)

(defun stress-target (values state a b c d e f)
  (assert (equal (list a b c d e f) '(1 2 3 4 5 6)))
  (unwind-protect
       (invoke-return #'stress-target values)
    (incf (aref state 2))))

(defun run-concurrent-gc ()
  (let* ((name (symbol-name (gensym "Frame Return GC test ")))
         (controller (d:make-debugger-controller))
         (state (vector 0 nil 0))
         (thread
           (s:make-thread
            (lambda ()
              (d:call-with-debugger-service
               (lambda ()
                 (with-simple-restart (abort "Abort the owned GC test.")
                   (loop until (aref state 1)
                         for count = (mod (aref state 0) 3)
                         for values = (loop for i below (ecase count (0 0) (1 1) (2 7))
                                            collect (vector i (aref state 0)))
                         for result = (multiple-value-list
                                       (stress-target values state 1 2 3 4 5 6))
                         do (assert (= (length result) (length values)))
                            (assert (every #'eq result values))
                            (incf (aref state 0)))))))
            :name name)))
    (unwind-protect
         (progn
           (lispm-service-test::await (lambda () (plusp (aref state 0))))
           (dotimes (i 8)
             (let ((before (aref state 0)))
               (mezzano.extensions:gc :full t)
               (lispm-service-test::await (lambda () (> (aref state 0) before))))))
      (setf (aref state 1) t)
      (let ((stop (lispm-service-test::stop-for-thread name)))
        (when stop (lispm-frame-evaluation-test::release-test-stop stop controller)))
      (lispm-service-test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
      (d:close-debugger-controller controller))
    (assert (= (aref state 0) (aref state 2)))
    (format t "Frame Return completed ~D transfers with eight concurrent full collections.~%"
            (aref state 0))
    t))


(defun invalid-values-target (values type)
  (handler-case
      (progn (invoke-return #'invalid-values-target values) nil)
    (error (condition)
      (assert (typep condition type))
      t)))

(defun run-value-conventions ()
  (let ((*events* nil) (*probe* 11))
    (assert (null (target (lambda () (invoke-return #'target nil)) 1 2 3 4 5 6)))
    (assert (= *probe* 11))
    (assert (equal (reverse *events*) '((:inner 22) (:outer 22)))))
  (let ((*events* nil) (*probe* 11) (continued nil))
    (target (lambda () (invoke-return #'target '(1 2 3 4 5 6 7))) 1 2 3 4 5 6)
    (setf continued t)
    (assert continued)
    (assert (= *probe* 11))
    (assert (equal (reverse *events*) '((:inner 22) (:outer 22)))))
  (dolist (depth '(1 2))
    (let ((*events* nil))
      (assert
       (eq (with-prompts depth
             (lambda ()
               (caller (lambda ()
                         (with-prompts 1
                           (lambda () (invoke-return #'target '(1 2 3 4 5 6 7)))))
                       '(1 2 3 4 5 6 7))))
           :caller-continued))))
  (assert (invalid-values-target '(1 . 2) 'type-error))
  (assert (invalid-values-target "not a list" 'type-error))
  (let ((cycle (list 1)))
    (setf (cdr cycle) cycle)
    (assert (invalid-values-target cycle 'simple-error)))
  (assert (invalid-values-target (make-list (1+ multiple-values-limit)) 'simple-error))
  t)
(defun run ()
  (run-guards)
  (run-direct)
  (run-value-conventions)
  (run-retained)
  (run-concurrent-gc)
  t)
