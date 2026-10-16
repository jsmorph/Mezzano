(defpackage #:lispm-package-lock-debugger-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals)
                    (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug)
                    (#:test #:lispm-service-test)
                    (#:managed #:lispm-managed-step-test)))
(in-package #:lispm-package-lock-debugger-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun lock-case (condition abort-p)
  (let* ((lock i::*package-system-lock*)
         (state (vector 0 nil nil))
         (controller (d:make-debugger-controller))
         (stop nil) (lease nil) (thread nil) (probe nil))
    (unwind-protect
         (progn
           (setf thread
                 (s:make-thread
                  (lambda ()
                    (d:call-with-debugger-service
                     (lambda ()
                       (unwind-protect
                            (restart-case
                                (progn
                                  (i::call-with-package-system-lock
                                   (lambda ()
                                     (assert (s:mutex-held-p lock))
                                     (cerror "Resume package operation." condition)
                                     (setf (aref state 1) (s:mutex-held-p lock))))
                                  :continued)
                              (abort () :aborted))
                         (incf (aref state 0))))))
                  :name "Owned package condition target"))
           (setf stop (test::await (lambda () (managed::thread-stop thread)))
                 lease (d:attach-debugger-stop stop controller))
           (assert (eq (d::service-stop-condition (d::service-handle-stop stop)) condition))
           (setf probe
                 (s:make-thread
                  (lambda ()
                    (i::call-with-package-system-lock
                     (lambda () (setf (aref state 2) (s:mutex-held-p lock)))))
                  :name "Owned package lock observer"))
           (test::await (lambda () (nth-value 1 (s:thread-join probe nil))))
           (assert (aref state 2))
           (let ((id (getf (d:debugger-stop-information stop) :next-command-id)))
             (d:submit-debugger-command lease id (if abort-p :abort :proceed))
             (assert (eq (getf (test::completed-command stop id) :state) :unwound)))
           (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
           (assert (equal (s:thread-join thread nil)
                          (list (if abort-p :aborted :continued))))
           (assert (= (aref state 0) 1))
           (assert (eq (not (null (aref state 1))) (not abort-p)))
           (assert (eq i::*package-system-lock* lock))
           (i::call-with-package-system-lock (lambda () (assert (s:mutex-held-p lock)))))
      (when stop
        (lispm-frame-evaluation-test::release-test-stop stop controller))
      (d:close-debugger-controller controller))))

(defun run ()
  (assert (null (d:debugger-stops :include-closed t)))
  (dolist (abort-p '(nil t))
    (lock-case (make-condition 'simple-error :format-control "Owned package error.") abort-p)
    (lock-case (make-condition 'storage-condition) abort-p))
  (assert (null (d:debugger-stops :include-closed t)))
  (format t "PASS package mutex release at ERROR/STORAGE-CONDITION debugger stops, cross-thread access, Continue/Abort, reacquisition and cleanup.~%")
  t)

(defvar *overflow-cleanups* 0)

(defun overflow ()
  (setf *overflow-cleanups* 0)
  (labels ((consume-stack ()
             (unwind-protect (consume-stack)
               (incf *overflow-cleanups*))))
    (i::call-with-package-system-lock #'consume-stack)))
