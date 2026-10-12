(defpackage #:lispm-method-order-test
  (:use #:cl)
  (:export #:run #:check-existing))
(in-package #:lispm-method-order-test)

(defparameter *cases*
  '((eql-first-forward nil nil)
    (eql-first-reverse t nil)
    (eql-second-precedence nil t)))

(defun install-case (name reverse-definitions-p reordered-p)
  (when (fboundp name) (fmakunbound name))
  (eval `(defgeneric ,name (tag value)
           ,@(when reordered-p '((:argument-precedence-order value tag)))))
  (let ((methods
          (loop for (specializer marker)
                  in '((integer :integer) (number :number) (t :any))
                collect
                `(defmethod ,name
                     ,(if reordered-p
                          `((tag ,specializer) (value (eql :chunked)))
                          `((tag (eql :chunked)) (value ,specializer)))
                   (cons ,marker (call-next-method))))))
    (eval `(defmethod ,name (tag value)
             (declare (ignore tag value))
             (list :fallback)))
    (dolist (method (if reverse-definitions-p (reverse methods) methods))
      (eval method))))

(defun check-existing ()
  (dolist (case *cases*)
    (destructuring-bind (name reverse-definitions-p reordered-p) case
      (declare (ignore reverse-definitions-p))
      (dolist (input '((42 (:integer :number :any :fallback))
                       (3/2 (:number :any :fallback))
                       ("text" (:any :fallback))))
        (destructuring-bind (value expected) input
          (let ((arguments (if reordered-p
                               (list value :chunked)
                               (list :chunked value))))
            (dotimes (iteration 2)
              (let ((result (apply name arguments)))
                (assert (equal result expected) ()
                        "~S ~S, call ~D: expected ~S, got ~S."
                        name arguments iteration expected result))))))
      (assert (equal (apply name (if reordered-p '(42 :other) '(:other 42)))
                     '(:fallback)))))
  (format t "PASS EQL method order, CALL-NEXT-METHOD, argument precedence, and repeated dispatch.~%")
  t)

(defun run ()
  (dolist (case *cases*) (apply #'install-case case))
  (check-existing))
