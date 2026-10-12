(defpackage :mezzano-long-division-test
  (:use :cl)
  (:export :run :operands))
(in-package :mezzano-long-division-test)

(declaim (optimize (speed 3) (safety 3) (debug 1)))

(defun make-generator ()
  (let ((state 123456789))
    (lambda (bits)
      (let ((result 0))
        (loop for position from 0 below bits by 32 do
          (setf state (logand #xffffffff (+ (* state 1664525) 1013904223))
                result (logior result (ash state position))))
        (if (zerop bits) 0
            (logior (ldb (byte bits 0) result) (ash 1 (1- bits))))))))

(defun operands (dividend-bits divisor-bits count)
  (let ((generate (make-generator)))
    (loop repeat count collect
      (cons (funcall generate dividend-bits)
            (funcall generate divisor-bits)))))

(defun run ()
  (let ((count 0))
    (labels ((check (a b)
               (multiple-value-bind (q r) (mezzano-long-division:divide a b)
                 (multiple-value-bind (expected-q expected-r) (truncate a b)
                   (assert (and (= q expected-q) (= r expected-r)) ()
                           "Division mismatch for ~D / ~D: ~S versus ~S."
                           a b (list q r) (list expected-q expected-r)))
                 (assert (= a (+ (* q b) r)))
                 (assert (< (abs r) (abs b)))
                 (assert (or (zerop r) (eq (minusp r) (minusp a)))))
               (incf count))
             (signed (a b)
               (dolist (a-sign '(1 -1))
                 (dolist (b-sign '(1 -1))
                   (check (* a-sign a) (* b-sign b))))))
      (loop for a from -32 to 32 do
        (loop for b from -16 to 16 unless (zerop b) do (check a b)))
      (dolist (bits '(29 30 31 59 60 61 89 90 91 255 256 383 384 511 512
                     767 768 1023 1024 2047 2048))
        (let ((power (ash 1 bits)))
          (dolist (a (list (1- power) power (1+ power) (1- (* power power))))
            (dolist (b (list 1 2 3 (1- power) power (1+ power)))
              (signed a b)))))
      (let* ((base mezzano-long-division::+base+)
             (half (ash base -1))
             (two-digits (+ (* half base) (1- base)))
             (three-digits (+ (* half base base) 1)))
        (signed (* half base base) two-digits)
        (signed (* (1- half) base base) two-digits)
        (signed (1- (* base three-digits)) three-digits))
      (dolist (bits '(1 29 30 31 60 61 256 384 512 1024 2048))
        (dolist (pair (operands (* 2 bits) bits 24))
          (signed (car pair) (cdr pair))
          (signed (* (car pair) (cdr pair)) (cdr pair)))
        (dolist (pair (operands bits bits 24))
          (signed (car pair) (cdr pair))))
      (assert (handler-case
                  (progn (mezzano-long-division:divide 1 0) nil)
                (division-by-zero () t)))
      (format t "PASS ~D divisions: quotient, remainder, identity, bounds, signs, and zero divisor.~%"
              count)
      count)))
