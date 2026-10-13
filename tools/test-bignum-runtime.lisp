(defpackage :mezzano-bignum-test
  (:use :cl)
  (:export :write-shift-cases :run-shifts))
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
