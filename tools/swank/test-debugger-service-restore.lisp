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

(defvar *running-restore-thread* nil)
(defvar *running-restore-controller* nil)
(defvar *running-restore-handle* nil)
(defvar *running-restore-lease* nil)
(defvar *running-restore-command-id* nil)
(defvar *running-restore-probe* nil)

(defun prepare-running-restore-test ()
  (assert (null (stop-for-thread "Debugger running-command restore test")))
  (setf *running-restore-thread*
        (start-test-thread "Debugger running-command restore test")
        *running-restore-handle*
        (await (lambda ()
                 (stop-for-thread "Debugger running-command restore test")))
        *running-restore-controller* (make-debugger-controller)
        *running-restore-lease*
        (attach-debugger-stop *running-restore-handle*
                              *running-restore-controller*)
        *running-restore-probe*
        (restart-index *running-restore-handle* *running-restore-lease*
                       "LISPM-SERVICE-TEST::PROBE")
        *running-restore-command-id*
        (getf (debugger-stop-information *running-restore-handle*)
              :next-command-id))
  (submit-debugger-command *running-restore-lease* *running-restore-command-id*
                          :invoke-restart *running-restore-probe*)
  (await (lambda () (= *probe-count* 1)))
  (let ((result (debugger-command-result *running-restore-handle*
                                        *running-restore-command-id*)))
    (assert (eq (getf result :state) :running))
    (assert (getf result :current-boot-p)))
  (assert (null (mezzano.supervisor:event-state *probe-gate*)))
  (assert (zerop *cleanup-count*))
  (format t "Prepared a running restart command waiting on an event.~%")
  (values))

(defun finish-running-restore-test ()
  (expect-error :expired-stop
                (lambda ()
                  (debugger-stop-information *running-restore-handle*)))
  (let* ((handle (stop-for-thread "Debugger running-command restore test"))
         (controller (make-debugger-controller))
         (lease nil))
    (assert handle)
    (setf lease (attach-debugger-stop handle controller))
    (unwind-protect
         (progn
           (close-debugger-controller *running-restore-controller*)
           (let ((result (debugger-command-result
                          handle *running-restore-command-id*)))
             (assert (eq (getf result :state) :running))
             (assert (null (getf result :current-boot-p))))
           (assert (= *probe-count* 1))
           (assert (zerop *cleanup-count*))
           (assert (null (mezzano.supervisor:event-state *probe-gate*)))
           (expect-error :expired-stop
                         (lambda ()
                           (submit-debugger-command
                            *running-restore-lease* *running-restore-command-id*
                            :invoke-restart *running-restore-probe*)))
           (expect-error :request-conflict
                         (lambda ()
                           (submit-debugger-command
                            lease *running-restore-command-id*
                            :invoke-restart *running-restore-probe*)))
           (expect-error :stop-busy
                         (lambda ()
                           (submit-debugger-command
                            lease
                            (getf (debugger-stop-information handle)
                                  :next-command-id)
                            :frames)))
           (mezzano.extensions:gc :full t)
           (setf (mezzano.supervisor:event-state *probe-gate*) t)
           (let ((result (completed-command handle *running-restore-command-id*)))
             (assert (eq (getf result :state) :returned))
             (assert (null (getf result :current-boot-p)))
             (assert (equal (getf result :result) '("42" ":PROBE"))))
           (assert (= *probe-count* 1))
           (assert (zerop *cleanup-count*))
           (setf (symbol-function 'missing)
                 (compile nil '(lambda (a b object)
                                 (declare (ignore object))
                                 (values (+ a b) :running-restored))))
           (let ((continue (restart-index handle lease "CONTINUE"))
                 (id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id :invoke-restart continue)
             (assert (eq (getf (completed-command handle id) :state) :unwound)))
           (await (lambda ()
                    (nth-value 1
                               (mezzano.supervisor:thread-join
                                *running-restore-thread* nil))))
           (assert (equal (mezzano.supervisor:thread-join *running-restore-thread*)
                          '(333 :running-restored)))
           (assert (= *cleanup-count* 1))
           (release-debugger-stop lease)
           (format t "PASS running command restore, expired control, rejected replay, GC, command values, application values, and cleanup~%"))
      (close-debugger-controller controller)))
  (values))

(in-package #:cl-user)
