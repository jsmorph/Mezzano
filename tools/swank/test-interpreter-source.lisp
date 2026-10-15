(defpackage #:lispm-interpreter-source-test
  (:use #:cl)
  (:export #:run))
(in-package #:lispm-interpreter-source-test)

(defun run ()
  (dolist (source (list nil #p"SYS:HOME;INTERPRETER-SOURCE-TEST.LISP"))
    (let ((*load-truename* source))
      (let* ((outer (mezzano.full-eval::eval-in-lexenv
                     '(lambda (value) (lambda () (+ value 1)))))
             (inner (funcall outer 41))
             (filename (when source (namestring source))))
        (assert (equal (mezzano.full-eval::interpreted-function-filename outer) filename))
        (assert (equal (mezzano.full-eval::interpreted-function-filename inner) filename))
        (assert (= (funcall inner) 42)))))
  (let ((*load-truename* 123))
    (assert
     (handler-case
         (progn (mezzano.full-eval::eval-in-lexenv '(lambda () 42)) nil)
       (type-error (condition) (eql (type-error-datum condition) 123)))))
  (let ((*load-truename* nil)
        (mezzano.fast-eval:*lazy-lambda-evaluation* t))
    (mezzano.full-eval::eval-in-lexenv
     '(deftype source-type () '(integer 0 10)))
    (assert (funcall (symbol-function 'typep) 7 'source-type))
    (assert (not (funcall (symbol-function 'typep) 11 'source-type))))
  (format t "PASS interpreter source metadata, closures, and lazy type expansion~%")
  t)
