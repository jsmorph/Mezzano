(defpackage :mezzano-long-division-kernel-bench
  (:use :cl)
  (:export :run :prepare :exercise))
(in-package :mezzano-long-division-kernel-bench)

(declaim (optimize (speed 3) (safety 3) (debug 1)))

(defun prepare (pairs)
  (loop for (a . b) in pairs collect
    (let* ((n (ceiling (integer-length b) 30))
           (size (ceiling (integer-length a) 30))
           (shift (- (* n 30) (integer-length b)))
           (template (mezzano-long-division::integer-digits
                      (ash a shift) (1+ size)))
           (v (mezzano-long-division::integer-digits (ash b shift) n)))
      (list template v (copy-seq template)
            (make-array (1+ (- size n)) :element-type '(unsigned-byte 32))))))

(defun restore-input (template work)
  (declare (type (simple-array (unsigned-byte 32) (*)) template work))
  (dotimes (i (length template))
    (setf (aref work i) (aref template i))))

(defun exercise (cases divide-p)
  (dolist (case cases)
    (destructuring-bind (template v u q) case
      (restore-input template u)
      (when divide-p
        (mezzano-long-division::divide-digits u v q)))))

(defun check-prepared (cases)
  (dolist (case cases)
    (destructuring-bind (template v u q) case
      (multiple-value-bind (expected-q expected-r)
          (truncate (mezzano-long-division::digits-integer template (length template))
                    (mezzano-long-division::digits-integer v (length v)))
        (restore-input template u)
        (mezzano-long-division::divide-digits u v q)
        (assert (= expected-q (mezzano-long-division::digits-integer q (length q))))
        (assert (= expected-r (mezzano-long-division::digits-integer u (length v))))))))

(defun allocated-bytes ()
  #+sbcl (sb-ext:get-bytes-consed)
  #+mezzano (mezzano.supervisor:thread-bytes-consed
             (mezzano.supervisor:current-thread)))

(defun measure (cases divide-p)
  (let* ((allocation-start (allocated-bytes))
         (start (get-internal-real-time))
         (end (+ start internal-time-units-per-second))
         (now start)
         (count 0))
    (loop
      (exercise cases divide-p)
      (incf count (length cases))
      (setf now (get-internal-real-time))
      (when (>= now end) (return)))
    (let ((allocation (- (allocated-bytes) allocation-start)))
      (values (* 1.0d6 (/ (- now start)
                         (float (* count internal-time-units-per-second) 1.0d0)))
              (/ allocation (float count 1.0d0))
              count))))

(defun run ()
  (format t "~A ~A~%" (lisp-implementation-type) (lisp-implementation-version))
  (format t "Preallocated arrays; SPEED 3 SAFETY 3 DEBUG 1; five one-second samples.~%")
  (dolist (function (list #'mezzano-long-division::divide-digits
                          #'restore-input #'exercise #'measure))
    (assert (compiled-function-p function)))
  (format t "bits,operation,divisions,min-us,median-us,max-us,median-bytes~%")
  (dolist (size '((768 384) (4096 2048)))
    (destructuring-bind (a-bits b-bits) size
      (let ((cases (prepare (mezzano-long-division-test:operands a-bits b-bits 32)))
            (times (vector nil nil))
            (bytes (vector nil nil))
            (counts (vector 0 0)))
        (check-prepared cases)
        (dotimes (sample 5)
          (dolist (index (if (evenp sample) '(0 1) '(1 0)))
            (multiple-value-bind (time allocation count)
                (measure cases (zerop index))
              (push time (aref times index))
              (push allocation (aref bytes index))
              (incf (aref counts index) count))))
        (check-prepared cases)
        (dotimes (index 2)
          (let ((time (sort (aref times index) #'<))
                (allocation (sort (aref bytes index) #'<)))
            (format t "~D/~D,~A,~D,~,3F,~,3F,~,3F,~,3F~%"
                    a-bits b-bits (if (zerop index) "restore+divide" "restore")
                    (aref counts index) (first time) (third time) (fifth time)
                    (third allocation))
            (finish-output))))))
  (format t "PASS prepared-array results before and after timing.~%"))

(defun integer-allocation (a-bits b-bits)
  (let* ((pairs (mezzano-long-division-test:operands a-bits b-bits 32))
         (start (allocated-bytes)))
    (dotimes (iteration 10)
      (dolist (pair pairs)
        (mezzano-long-division:divide (car pair) (cdr pair))))
    (/ (- (allocated-bytes) start) (float (* 10 (length pairs)) 1.0d0))))
