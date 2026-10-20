(defpackage #:lispm-closure-identity-test
  (:use #:cl)
  (:local-nicknames (#:c #:mezzano.compiler))
  (:export #:run))
(in-package #:lispm-closure-identity-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun compile-case (source label debug compilation-speed)
  (multiple-value-bind (function warnings failure) (compile nil source)
    (assert (and function (not warnings) (not failure)) ()
            "Compilation failed for ~S at DEBUG ~D/COMPILATION-SPEED ~D: ~S ~S."
            label debug compilation-speed warnings failure)
    function))

(defun check-result (actual expected label debug compilation-speed)
  (assert (equal actual expected) ()
          "~S at DEBUG ~D/COMPILATION-SPEED ~D returned ~S, expected ~S."
          label debug compilation-speed actual expected))

(defun check-value-reads (debug compilation-speed)
  (dolist (case
           '((:stored-read
              (lambda (x)
                (let ((f (lambda () x)))
                  (let ((saved (vector f)))
                    (eq (svref saved 0) f))))
              (42) (t))
             (:loop-read
              (lambda (x)
                (let ((f (lambda () x))
                      (seen nil))
                  (dotimes (i 2) (push f seen))
                  (eq (first seen) (second seen))))
              (42) (t))
             (:typed-read
              (lambda (x)
                (let ((f (the function (lambda () x))))
                  (let ((saved (vector f)))
                    (values (eq (svref saved 0) f)
                            (funcall (svref saved 0))))))
              (42) (t 42))
             (:aliases-and-shared-cell
              (lambda (x)
                (let ((f (lambda (delta) (incf x delta))))
                  (let* ((alias f)
                         (saved (vector f alias)))
                    (values (eq f alias)
                            (eq (svref saved 0) f)
                            (funcall f 1)
                            (funcall (svref saved 0) 2)
                            (funcall alias 4)
                            x
                            (eq (svref saved 1) f)))))
              (10) (t t 11 13 17 17 t))
             (:read-before-assignment
              (lambda (x)
                (let ((f (lambda () x)))
                  (let ((saved (vector f)))
                    (setq f 42)
                    (values (funcall (svref saved 0)) f))))
              (17) (17 42))
             (:funcall-before-argument-assignment
              (lambda (x)
                (let ((f (lambda (y) (+ x y))))
                  (values (funcall f (progn (setq f #'identity) 2))
                          (funcall f 3))))
              (40) (42 3))
             (:apply-before-argument-assignment
              (lambda (x)
                (let ((f (lambda (y) (+ x y))))
                  (values (apply f (progn (setq f #'identity) (list 2)))
                          (funcall f 3))))
              (40) (42 3))
             (:multiple-values-before-argument-assignment
              (lambda (x)
                (let ((f (lambda (y) (+ x y))))
                  (values (multiple-value-call f
                            (progn (setq f #'identity) (values 2)))
                          (funcall f 3))))
              (40) (42 3))))
    (destructuring-bind (label source arguments expected) case
      (check-result
       (multiple-value-list
        (apply (compile-case source label debug compilation-speed) arguments))
       expected label debug compilation-speed))))

(defun check-function-cell (debug compilation-speed)
  (let ((name (gensym "CLOSURE-IDENTITY-"))
        (function
          (compile-case
           '(lambda (name x)
              (let ((original (lambda () :original)))
                (setf (fdefinition name) original)
                (unwind-protect
                     (let ((observer (lambda () x))
                           (expected nil))
                       (let ((value
                               (unwind-protect
                                    (progn
                                      (setf (fdefinition name) observer)
                                      (funcall (fdefinition name)))
                                 (setf expected (eq (fdefinition name) observer))
                                 (setf (fdefinition name) original))))
                         (values value expected (eq (fdefinition name) original))))
                  (fmakunbound name))))
           :function-cell debug compilation-speed)))
    (unwind-protect
         (progn
           (check-result (multiple-value-list (funcall function name 42))
                         '(42 t t) :function-cell debug compilation-speed)
           (assert (not (fboundp name))))
      (when (fboundp name) (fmakunbound name)))))

(defun run ()
  (dolist (debug '(0 1 3))
    (dolist (compilation-speed '(1 3))
      (let ((c::*optimize-policy*
              (list 'debug debug 'safety 3 'speed 1
                    'compilation-speed compilation-speed))
            (c::*the-checks-types* t))
        (check-value-reads debug compilation-speed)
        (check-function-cell debug compilation-speed))))
  (format t "PASS 54 closure identity, alias, captured-cell, assignment-order, and function-cell cleanup cases at DEBUG 0/1/3 and COMPILATION-SPEED 1/3.~%")
  t)
