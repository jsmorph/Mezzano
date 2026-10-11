(defpackage #:lispm-write-flow-test
  (:use #:cl)
  (:import-from #:lispm-binding-write-test #:check-write))
(in-package #:lispm-write-flow-test)

(check-write
 '(lambda (a inspect)
    (declare (optimize (debug 3) (safety 3)))
    (let ((prior (+ a 1)))
      (funcall inspect)
      (list a prior (+ a 1))))
 '(111) 'a (lambda () 1/2) '(1/2 112 3/2))

(check-write
 '(lambda (a inspect)
    (declare (optimize (debug 3) (safety 3)))
    (if (typep a 'fixnum)
        (progn
          (funcall inspect)
          (list (+ a 1) (typep a 'fixnum)))
        (error "The initial value should select the fixnum branch.")))
 '(111) 'a (lambda () 1/2) '(3/2 nil))

(check-write
 '(lambda (a inspect)
    (declare (optimize (debug 3) (safety 3)))
    (if (eq a t)
        (progn (funcall inspect) (eq a t))
        (error "The initial value should select the true branch.")))
 '(t) 'a (lambda () nil) nil)

(check-write
 '(lambda (a inspect)
    (declare (optimize (debug 3) (safety 3)))
    (if (vectorp a)
        (progn (funcall inspect) (list (length a) (elt a 1)))
        (error "The initial value should select the vector branch.")))
 (list (vector 1 2)) 'a (lambda () (list 10 20 30)) '(3 20))

(format t "PASS binding type changes after earlier arithmetic, type, identity, and vector tests~%")
(in-package #:cl-user)
