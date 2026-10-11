(defpackage #:lispm-keyword-test (:use #:cl))
(in-package #:lispm-keyword-test)

(defun rejects-arguments-p (target &rest arguments)
  (handler-case (progn (apply target arguments) nil)
    (program-error () t)))

(dolist (debug '(1 3))
  (let ((target (compile nil `(lambda (&key (a 111) (b 222))
                               (declare (optimize (debug ,debug) (safety 3)))
                               (values a b)))))
    (assert (equal (multiple-value-list (funcall target)) '(111 222)))
    (assert (equal (multiple-value-list (funcall target :b 333 :a 444)) '(444 333)))
    (assert (equal (multiple-value-list (funcall target :a 333 :a 444)) '(333 222)))
    (assert (equal (multiple-value-list
                    (funcall target :unknown 333 :allow-other-keys t))
                   '(111 222)))
    (assert (rejects-arguments-p target :unknown 333))
    (assert (rejects-arguments-p target :unknown 333 :allow-other-keys nil))
    (assert (rejects-arguments-p target :a))
    (let* ((thread (mezzano.supervisor:current-thread))
           (before (mezzano.supervisor:thread-bytes-consed thread)))
      (funcall target :b 333 :a 444)
      (let ((allocated (- (mezzano.supervisor:thread-bytes-consed thread) before)))
        (assert (zerop allocated) () "Keyword processing allocated ~D bytes at debug ~D."
                allocated debug)))))

(format t "PASS keyword processing at debug 1 and 3 without heap allocation on valid calls~%")
(in-package #:cl-user)
