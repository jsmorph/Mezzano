(defpackage #:lispm-gc-restart-test
  (:use #:cl)
  (:import-from #:lispm-foothold-gc-test
                #:await #:register-function
                #:*root* #:*entered* #:*release* #:*interrupted* #:*result*))
(in-package #:lispm-gc-restart-test)

(defvar *thread* nil)
(defvar *gate* nil)

(defun seek-restart (thread target)
  (mezzano.supervisor::convert-thread-to-full-save thread)
  (loop repeat 2000
        for rip = (mezzano.supervisor:thread-state-rip thread)
        do (multiple-value-bind (function offset)
               (mezzano.internals::return-address-to-function rip)
             (when (eq function target)
               (let ((metadata (multiple-value-list
                                (mezzano.internals::gc-info-for-function-offset
                                 function offset))))
                 (when (nth 11 metadata)
                   (return-from seek-restart
                     (+ (logand (mezzano.internals::lisp-object-address function) -16)
                        (nth 10 metadata)))))))
           (mezzano.internals::safe-single-step-thread thread))
  (error "Did not reach the fixture's GC restart region."))

(defun test-restart (nested)
  (setf *root* (vector :gc-restart nested)
        *entered* nil *release* nil *interrupted* nil *result* nil
        *gate* (mezzano.supervisor:make-event))
  (let* ((function (register-function :r8 t))
         (done (mezzano.supervisor:make-event))
         (frame-pointer nil))
    (setf *thread*
          (mezzano.supervisor:make-thread
           (lambda ()
             (setf *result* (funcall function *root*))
             (setf (mezzano.supervisor:event-state done) t))
           :name "GC instruction restart test"))
    (await (lambda () *entered*))
    (mezzano.supervisor::stop-thread *thread*)
    (let ((expected (seek-restart *thread* function)))
      (when nested
        (mezzano.supervisor:establish-thread-foothold
         *thread*
         (lambda ()
           (setf *interrupted* t)
           (mezzano.supervisor:event-wait *gate*)))
        (setf frame-pointer (mezzano.supervisor:thread-state-rbp *thread*))
        (mezzano.supervisor::resume-thread *thread*)
        (await (lambda () *interrupted*)))
      (mezzano.extensions:gc :full t)
      (let ((observed (if nested
                          (mezzano.internals::memref-unsigned-byte-64 frame-pointer 1)
                          (mezzano.supervisor:thread-state-rip *thread*))))
        (format t "Restart address ~X, expected ~X, nested ~S.~%" observed expected nested)
        (assert (= observed expected) () "Invalid GC restart address.  Fixture remains suspended."))
      (setf *release* t
            (mezzano.supervisor:event-state *gate*) t)
      (unless nested (mezzano.supervisor::resume-thread *thread*))
      (await (lambda () (mezzano.supervisor:event-state done)))
      (assert *result*)
      (setf *thread* nil *gate* nil)
      (format t "PASS raw GC restart address and resumption, nested ~S~%" nested))))

(defun run-tests ()
  (test-restart nil)
  (test-restart t))

(run-tests)
(in-package #:cl-user)
