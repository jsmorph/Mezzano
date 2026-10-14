(defpackage #:lispm-debugger-handlers-test
  (:use #:cl #:mezzano.debug)
  (:local-nicknames (#:d #:mezzano.debug) (#:test #:lispm-service-test)
                    (#:frame #:lispm-frame-evaluation-test))
  (:export #:run))
(in-package #:lispm-debugger-handlers-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *caught* 0)
(define-condition command-error (error) ())
(define-condition application-error (error) ())
(define-condition cleanup-error (error) ())
(defclass broken-printer () ())
(defmethod print-object ((object broken-printer) stream)
  (declare (ignore stream))
  (error 'command-error))

(defun returning-restart ()
  (error 'command-error))

(defun target (mode)
  (restart-bind ((owned-returning #'returning-restart))
    (break "Owned debugger handler-scope test.")
    (ecase mode
      (:continue (error 'application-error))
      (:cleanup :normal))))

(defun application (mode)
  (handler-case
      (unwind-protect (target mode)
        (when (eq mode :cleanup) (error 'cleanup-error)))
    ((or command-error application-error cleanup-error) (condition)
      (incf *caught*)
      (type-of condition))))

(defun command-error-case (handle lease controller operation argument)
  (let ((id (getf (debugger-stop-information handle) :next-command-id))
        (child nil))
    (unwind-protect
         (progn
           (submit-debugger-command lease id operation argument)
           (setf child
                 (test::await
                  (lambda ()
                    (let ((info (debugger-stop-information handle)))
                      (assert (eq (getf info :state) :stopped) ()
                              "Application handler escaped debugger command ~D." id)
                      (getf info :child)))))
           (assert (typep (d::service-stop-condition (d::service-handle-stop child))
                          'command-error))
           (test::command child (attach-debugger-stop child controller) :condition))
      (when child (frame::release-test-stop child controller)))
    (assert (eq (getf (test::completed-command handle id) :state) :unwound))
    (assert (zerop *caught*))))

(defun nested-evaluation (handle lease controller)
  (let ((id (getf (debugger-stop-information handle) :next-command-id))
        (child nil))
    (unwind-protect
         (progn
           (submit-debugger-command
            lease id :evaluate
            "(handler-case (progn (break \"Owned nested handler test.\") (error 'command-error)) (command-error () :inner-caught))")
           (setf child (test::await (lambda () (getf (debugger-stop-information handle) :child))))
           (let ((child-lease (attach-debugger-stop child controller)))
             (frame::select-function child child-lease #'target)
             (command-error-case child child-lease controller :evaluate "(error 'command-error)")
             (let ((next (getf (debugger-stop-information child) :next-command-id)))
               (submit-debugger-command child-lease next :proceed)
               (assert (eq (getf (test::completed-command child next) :state) :unwound)))
             (assert (equal (getf (test::completed-command handle id) :result) '(":INNER-CAUGHT")))))
      (when child (frame::release-test-stop child controller)))))

(defun run-case (mode)
  (setf *caught* 0)
  (let* ((controller (make-debugger-controller))
         (job (start-evaluation-job
               (string-downcase (format nil "~32,'0X~32,'0X" (get-universal-time)
                                        (random most-positive-fixnum)))
               (format nil "(application ~S)" mode) :package "LISPM-DEBUGGER-HANDLERS-TEST"))
         (handle nil) (lease nil))
    (unwind-protect
         (progn
           (setf handle (test::await (lambda () (first (getf (evaluation-job-information job) :stops))))
                 lease (attach-debugger-stop handle controller))
           (frame::select-function handle lease #'target)
           (when (eq mode :continue)
             (command-error-case handle lease controller :evaluate "(error 'command-error)")
             (command-error-case handle lease controller :evaluate "(make-instance 'broken-printer)")
             (frame::evaluate-source handle lease
                                     "(handler-case (error 'command-error) (command-error () :local-caught))"
                                     '(":LOCAL-CAUGHT"))
             (let* ((stop (d::service-handle-stop handle))
                    (index (position 'owned-returning (d::service-stop-restarts stop) :key #'restart-name)))
               (assert index)
               (command-error-case handle lease controller :invoke-restart index))
             (nested-evaluation handle lease controller))
           (assert (zerop *caught*))
           (let ((id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id (if (eq mode :continue) :proceed :abort))
             (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
           (let ((info (test::await
                        (lambda ()
                          (let ((info (evaluation-job-information job)))
                            (unless (eq (getf info :state) :running) info))))))
             (assert (eq (getf info :state) :returned))
             (assert (equal (getf info :values)
                            (list (if (eq mode :continue) "APPLICATION-ERROR" "CLEANUP-ERROR")))
                     () "~S" info))
           (assert (= *caught* 1))
           (release-debugger-stop lease)
           (setf handle nil)
           (release-evaluation-job job)
           (setf job nil))
      (when handle (frame::release-test-stop handle controller))
      (when job
        (test::await (lambda () (not (eq (getf (evaluation-job-information job) :state) :running))))
        (release-evaluation-job job))
      (close-debugger-controller controller))))

(defun run ()
  (run-case :continue)
  (run-case :cleanup)
  (format t "PASS debugger handler isolation, local handlers, nested debugger recovery, restart and printer errors, continuation, cleanup, and release.~%")
  t)
