(defpackage :lispm-certificate-bench
  (:use :cl)
  (:export :read-data :run))
(in-package :lispm-certificate-bench)

(defun read-data (pathname)
  (with-open-file (in pathname)
    (let* ((*read-eval* nil)
           (data (read in)))
      (flet ((parse (items)
               (mapcar (lambda (bytes)
                         (pure-tls::parse-certificate
                          (coerce bytes '(simple-array (unsigned-byte 8) (*)))))
                       items)))
        (values (parse (getf data :chain))
                (parse (getf data :roots))
                (getf data :time))))))

(defun bytes-consed ()
  #+sbcl (sb-ext:get-bytes-consed)
  #+mezzano (mezzano.supervisor:thread-bytes-consed
             (mezzano.supervisor:current-thread)))

(defun run (chain roots &key (now (get-universal-time)) (samples 5))
  (assert (compiled-function-p #'pure-tls::verify-certificate-chain))
  (format t "~A ~A; ~D chain certificates; ~D roots.~%"
          (lisp-implementation-type) (lisp-implementation-version)
          (length chain) (length roots))
  (loop for i below samples collect
    (let ((start (get-internal-real-time))
          (bytes (bytes-consed)))
      (assert (pure-tls::verify-certificate-chain
               chain roots :now now :purpose :server-auth))
      (let ((elapsed (* 1000.0d0 (/ (- (get-internal-real-time) start)
                                   internal-time-units-per-second)))
            (allocated (- (bytes-consed) bytes)))
        (format t "sample ~D: ~,3F ms; ~D bytes.~%" i elapsed allocated)
        (list elapsed allocated)))))

(in-package :cl-user)
