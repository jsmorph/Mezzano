(defpackage #:lispm-jump-table-test (:use #:cl))
(in-package #:lispm-jump-table-test)

(dolist (debug '(1 3))
  (dolist (body '((1+ (ecase x (1 11) (2 22) (3 33) (4 44)))
                  (list (ecase x (1 11) (2 22) (3 33) (4 44)))))
    (let ((target (compile nil `(lambda (x)
                                 (declare (optimize (debug ,debug) (safety 3)))
                                 ,body))))
      (loop for x from 1 to 4
            for expected = (if (eq (first body) '1+) (1+ (* x 11)) (list (* x 11)))
            do (assert (equal (funcall target x) expected)))
      (dolist (x '(0 5 invalid))
        (assert (handler-case (progn (funcall target x) nil)
                  (type-error () t)))))))

(format t "PASS jump-table binding cleanup, case results, and invalid selectors at debug 1 and 3~%")
(in-package #:cl-user)
