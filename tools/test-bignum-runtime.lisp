(defpackage :mezzano-bignum-test
  (:use :cl)
  (:export :write-shift-cases :run-shifts :write-binary-cases :run-binary-cases))
(in-package :mezzano-bignum-test)

(defun write-shift-cases (pathname)
  (with-open-file (out pathname :direction :output :if-exists :supersede)
    (with-standard-io-syntax
      (dolist (bits '(0 1 30 31 32 61 62 63 64 65 127 128 129
                     255 256 383 384 511 512 1023 1024 4095 4096))
        (dolist (delta '(-1 0 1))
          (dolist (sign '(1 -1))
            (let ((value (* sign (+ (ash 1 bits) delta))))
              (dolist (shift (append
                             '(-8192 -4097 -1024 -513 -384 -129 -128 -127
                               -65 -64 -63 -33 -32 -31 -1 0 1 31 32 33
                               63 64 65 127 128 129 384 513 1024)
                             (list (- most-positive-fixnum) (- (ash 1 70)))))
                (write (list value shift (ash value shift) value) :stream out)
                (terpri out)))))))))

(defun run-shifts (pathname &optional (operation #'ash))
  (let ((count 0))
    (with-open-file (in pathname)
      (with-standard-io-syntax
        (let ((*read-eval* nil))
          (loop for case = (read in nil nil) while case do
            (destructuring-bind (value shift expected original) case
              (let ((result (funcall operation value shift)))
                (assert (= result expected) ()
                        "Shift mismatch: ~D by ~D." value shift)
                (assert (= value original) ()
                        "Shift changed its input.")
                (assert (eq (typep result 'fixnum) (typep expected 'fixnum)))
                #+mezzano
                (when (typep result 'bignum)
                  (assert (= (mezzano.internals::%n-bignum-fragments result)
                             (ceiling (1+ (integer-length result)) 64)))))
              (incf count))))))
    (format t "PASS ~D shifts, input immutability, and canonical results.~%" count)
    count))

(defun write-binary-cases (pathname operation)
  (let ((state 123456789))
    (labels ((generate (bits)
               (let ((value 0))
                 (loop for position from 0 below bits by 32 do
                   (setf state (logand #xffffffff (+ (* state 1664525) 1013904223))
                         value (logior value (ash state position))))
                 (ldb (byte bits 0) value))))
      (with-open-file (out pathname :direction :output :if-exists :supersede)
        (with-standard-io-syntax
          (flet ((emit (a b)
                   (unless (and (eq operation 'truncate) (zerop b))
                     (dolist (a-sign '(1 -1))
                       (dolist (b-sign '(1 -1))
                         (let ((a (* a-sign a)) (b (* b-sign b)))
                           (write (list a b (multiple-value-list (funcall operation a b)) a b)
                                  :stream out)
                           (terpri out)))))))
            (when (eq operation 'truncate)
              (let* ((base (ash 1 32))
                     (half (ash base -1))
                     (two-digits (+ (* half base) (1- base)))
                     (three-digits (+ (* half base base) 1)))
                (emit (* half base base) two-digits)
                (emit (* (1- half) base base) two-digits)
                (emit (1- (* base three-digits)) three-digits)))
            (dolist (bits '(1 31 32 62 63 64 65 127 128 129 255 256
                           383 384 511 512 1024 2048 4096))
              (let ((power (ash 1 bits)))
                (dolist (a (list 0 (1- power) power (1+ power)))
                  (dolist (b (list 1 (1- power) power (1+ power)))
                    (emit a b))))
              (dotimes (i 8)
                (emit (generate (* 2 bits)) (generate bits))))))))))

(defun run-binary-cases (pathname operation)
  (let ((count 0))
    (with-open-file (in pathname)
      (with-standard-io-syntax
        (let ((*read-eval* nil))
          (loop for case = (read in nil nil) while case do
            (destructuring-bind (a b expected original-a original-b) case
              (let ((results (multiple-value-list (funcall operation a b))))
                (assert (equal results expected) () "Arithmetic mismatch in case ~D." count)
                (assert (and (= a original-a) (= b original-b)) ()
                        "Arithmetic changed an input.")
                (loop for result in results for reference in expected do
                  (assert (eq (typep result 'fixnum) (typep reference 'fixnum)))
                  #+mezzano
                  (when (typep result 'bignum)
                    (assert (= (mezzano.internals::%n-bignum-fragments result)
                               (ceiling (1+ (integer-length result)) 64))))))
              (incf count))))))
    (format t "PASS ~D binary cases, input immutability, and canonical results.~%" count)
    count))

#+mezzano
(defun check-allocation-gc (operation &rest arguments)
  (let* ((expected (multiple-value-list (apply operation arguments)))
         (name 'mezzano.internals::%make-bignum-of-length)
         (original (fdefinition name))
         (owner (mezzano.supervisor:current-thread))
         (armed t)
         (wrapper (lambda (words)
                    (when (and armed (eq owner (mezzano.supervisor:current-thread)))
                      (setf armed nil)
                      (mezzano.extensions:gc :full t))
                    (funcall original words))))
    (unwind-protect
         (progn
           (setf (fdefinition name) wrapper)
           (assert (equal (multiple-value-list (apply operation arguments)) expected))
           (assert (not armed)))
      (assert (eq (fdefinition name) wrapper))
      (setf (fdefinition name) original))
    (format t "PASS collection during arithmetic allocation.~%")))

(in-package :cl-user)
