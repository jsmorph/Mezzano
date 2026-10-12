(defpackage :mezzano-long-division-bench
  (:use :cl)
  (:export :run))
(in-package :mezzano-long-division-bench)

(declaim (optimize (speed 3) (safety 3) (debug 1)))

(defvar *result* nil)

(defun measure (function cases)
  (let* ((start (get-internal-real-time))
         (end (+ start internal-time-units-per-second))
         (now start)
         (count 0)
         (q 0)
         (r 0))
    (loop
      (dolist (pair cases)
        (multiple-value-setq (q r)
          (funcall function (car pair) (cdr pair))))
      (incf count (length cases))
      (setf now (get-internal-real-time))
      (when (>= now end) (return)))
    (setf *result* (list q r))
    (values (* 1.0d6 (/ (- now start)
                       (float (* count internal-time-units-per-second) 1.0d0)))
            count)))

(defun run ()
  (format t "~A ~A, ~A, fixnum bits ~D, timer units/s ~D~%"
          (lisp-implementation-type) (lisp-implementation-version)
          (machine-type) (integer-length most-positive-fixnum)
          internal-time-units-per-second)
  (format t "Policy: SPEED 3 SAFETY 3 DEBUG 1.  32 operands, five one-second samples, wall time, conversion included.~%")
  #+mezzano
  (format t "Compiler restrictions: ~S~%"
          mezzano.compiler::*optimize-restrictions*)
  (format t "bits,implementation,divisions,minimum-us,median-us,maximum-us~%")
  (dolist (size '((512 256) (768 384) (1024 512) (2048 1024) (4096 2048)))
    (destructuring-bind (a-bits b-bits) size
      (let* ((cases (mezzano-long-division-test:operands a-bits b-bits 32))
             (functions (vector #'mezzano-long-division:divide #'truncate))
             (samples (vector nil nil))
             (counts (vector 0 0)))
        (dotimes (sample 5)
          (dolist (index (if (evenp sample) '(0 1) '(1 0)))
            (multiple-value-bind (microseconds count)
                (measure (aref functions index) cases)
              (push microseconds (aref samples index))
              (incf (aref counts index) count))))
        (dotimes (index 2)
          (let ((times (sort (aref samples index) #'<)))
            (format t "~D/~D,~A,~D,~,3F,~,3F,~,3F~%"
                    a-bits b-bits
                    (if (zerop index) "long-division" "truncate")
                    (aref counts index)
                    (first times) (third times) (fifth times))
            (finish-output)))))))
