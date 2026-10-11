(defpackage #:lispm-debugger-test (:use #:cl))
(in-package #:lispm-debugger-test)

(defparameter *cleanup-count* 0)
(defparameter *continued* nil)
(fmakunbound 'missing)

(defun call-missing (a b)
  (declare (optimize (debug 3) (safety 3)))
  (unwind-protect
       (multiple-value-prog1 (funcall 'missing a b)
         (setf *continued* t))
    (incf *cleanup-count*)))

(in-package #:cl-user)
