(in-package #:lispm-service-test)

(defvar *restore-thread* nil)
(defvar *restore-controller* nil)
(defvar *restore-handle* nil)
(defvar *restore-lease* nil)
(defvar *restore-frame* nil)
(defvar *restore-command-id* nil)

(defun prepare-restore-test ()
  (setf *cleanup-count* 0)
  (fmakunbound 'missing)
  (setf *restore-thread*
        (mezzano.supervisor:make-thread
         (lambda ()
           (call-with-debugger-service
            (lambda () (call-missing 111 222 nil))))
         :name "Debugger restore test")
        *restore-handle*
        (await (lambda () (stop-for-thread "Debugger restore test")))
        *restore-controller* (make-debugger-controller)
        *restore-lease* (attach-debugger-stop *restore-handle* *restore-controller*))
  (setf *restore-command-id*
        (getf (debugger-stop-information *restore-handle*) :next-command-id))
  (let ((frames (command *restore-handle* *restore-lease* :frames)))
    (setf *restore-frame*
          (getf (find-if (lambda (entry) (search "CALL-MISSING" (getf entry :function)))
                        frames)
                :frame)))
  (assert *restore-frame*)
  (assert (zerop *cleanup-count*))
  (format t "Prepared a retained stop and handles for snapshot restore.~%")
  (values))

(defun finish-restore-test ()
  (expect-error :expired-stop (lambda () (debugger-stop-information *restore-handle*)))
  (let* ((handle (stop-for-thread "Debugger restore test"))
         (controller (make-debugger-controller))
         (lease nil))
    (assert handle)
    (expect-error :expired-controller
                  (lambda () (attach-debugger-stop handle *restore-controller*)))
    (setf lease (attach-debugger-stop handle controller))
    (unwind-protect
         (progn
           (close-debugger-controller *restore-controller*)
           (let ((old-result (debugger-command-result handle *restore-command-id*)))
             (assert (eq (getf old-result :state) :returned))
             (assert (null (getf old-result :current-boot-p))))
           (expect-error :expired-stop
                         (lambda () (submit-debugger-command
                                     *restore-lease* 1 :locals *restore-frame*)))
           (expect-error :expired-stop
                         (lambda () (submit-debugger-command
                                     lease 1 :locals *restore-frame*)))
           (let* ((frames (command handle lease :frames))
                  (frame (getf (find-if (lambda (entry)
                                         (search "CALL-MISSING" (getf entry :function)))
                                       frames)
                               :frame)))
             (assert frame)
             (mezzano.extensions:gc :full t)
             (let ((locals (command handle lease :locals frame)))
               (assert (find "111" locals
                             :key (lambda (entry) (getf entry :value))
                             :test #'equal))
               (assert (find "222" locals
                             :key (lambda (entry) (getf entry :value))
                             :test #'equal))))
           (assert (zerop *cleanup-count*))
           (setf (symbol-function 'missing)
                 (compile nil '(lambda (a b object)
                                 (declare (ignore object))
                                 (values (+ a b) :restored))))
           (let ((continue (restart-index handle lease "CONTINUE"))
                 (id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id :invoke-restart continue)
             (assert (eq (getf (completed-command handle id) :state) :unwound)))
           (await (lambda () (nth-value 1 (mezzano.supervisor:thread-join *restore-thread* nil))))
           (assert (equal (mezzano.supervisor:thread-join *restore-thread*) '(333 :restored)))
           (assert (= *cleanup-count* 1))
           (release-debugger-stop lease)
           (format t "PASS restored stop, expired handles and controller, retained command outcome, locals after GC, restart, and cleanup~%"))
      (close-debugger-controller controller)))
  (values))

(in-package #:cl-user)
