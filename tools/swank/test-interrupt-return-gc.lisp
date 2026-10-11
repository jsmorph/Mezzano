(defpackage #:lispm-interrupt-return-test
  (:use #:cl)
  (:import-from #:lispm-foothold-gc-test
                #:await #:register-function
                #:*root* #:*entered* #:*release* #:*interrupted* #:*result*))
(in-package #:lispm-interrupt-return-test)

(defun seek-return (thread phase)
  (mezzano.supervisor::convert-thread-to-full-save thread)
  (loop repeat 2000
        for rip = (mezzano.supervisor:thread-state-rip thread)
        do (multiple-value-bind (function offset)
               (mezzano.internals::return-address-to-function rip)
             (when (and (eq function #'mezzano.supervisor::%%partial-save-return-thunk)
                        (ecase phase
                          (:entry t)
                          (:iret (not (mezzano.internals::gc-info-for-function-offset
                                       function offset)))))
               (format t "Stopped at ~A, offset ~D.~%" phase offset)
               (return-from seek-return)))
           (mezzano.internals::safe-single-step-thread thread))
  (error "Did not reach interrupt return phase ~S." phase))

(defun test-return (phase nested)
  (setf *root* (vector :return-gc phase nested)
        *entered* nil *release* nil *interrupted* nil *result* nil)
  (let* ((function (register-function :r8))
         (gate (mezzano.supervisor:make-event))
         (done (mezzano.supervisor:make-event))
         (thread (mezzano.supervisor:make-thread
                  (lambda ()
                    (setf *result* (funcall function *root*))
                    (setf (mezzano.supervisor:event-state done) t))
                  :name "Interrupt return GC test")))
    (unwind-protect
         (progn
           (await (lambda () *entered*))
           (mezzano.supervisor::stop-thread thread)
           (seek-return thread phase)
           (when nested
             (mezzano.supervisor:establish-thread-foothold
              thread
              (lambda ()
                (setf *interrupted* t)
                (mezzano.supervisor:event-wait gate)))
             (mezzano.supervisor::resume-thread thread)
             (await (lambda () *interrupted*)))
           (format t "Collecting at ~A, nested ~S.~%" phase nested)
           (let ((before (mezzano.internals::lisp-object-address *root*)))
             (mezzano.extensions:gc :full t)
             (assert (/= before (mezzano.internals::lisp-object-address *root*))))
           (setf *release* t
                 (mezzano.supervisor:event-state gate) t)
           (unless nested (mezzano.supervisor::resume-thread thread))
           (await (lambda () (mezzano.supervisor:event-state done)))
           (assert *result*)
           (format t "PASS interrupt return ~A, nested ~S~%" phase nested))
      (setf *release* t
            (mezzano.supervisor:event-state gate) t)
      (when (eq (mezzano.supervisor::sample-thread-state thread) :stopped)
        (mezzano.supervisor::resume-thread thread)))))

(defun run-tests ()
  (dolist (nested '(nil t))
    (dolist (phase '(:entry :iret))
      (test-return phase nested))))

(run-tests)
(in-package #:cl-user)
