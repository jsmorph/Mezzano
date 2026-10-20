(defpackage #:lispm-type-control-flow-test
  (:use #:cl)
  (:local-nicknames (#:c #:mezzano.compiler))
  (:export #:run))
(in-package #:lispm-type-control-flow-test)

(defun return-form (count)
  (subst (cons 'values (loop for index below count collect index))
         :transfer-values
         '(lambda (flag)
            (let ((cleanups 0))
              (let ((result
                      (multiple-value-list
                       (block exit
                         (unwind-protect
                              (the fixnum
                                   (if flag
                                       (progn (return-from exit :transfer-values))
                                       23))
                           (incf cleanups))))))
                (list result cleanups))))))

(defun go-form ()
  '(lambda (flag)
     (let ((value 1) (cleanups 0))
       (let ((result
               (multiple-value-list
                (block exit
                  (unwind-protect
                       (tagbody
                         (setf value
                               (the fixnum
                                    (if flag (progn (incf value 2) (go done)) 4)))
                        done
                         (return-from exit (values value :go)))
                    (incf cleanups))))))
         (list result cleanups)))))

(defun compile-case (form debug)
  (let ((c::*optimize-policy* (list 'safety 3 'debug debug 'speed 1)))
    (multiple-value-bind (function warnings failure) (compile nil form)
      (assert (compiled-function-p function))
      (assert (not warnings))
      (assert (not failure))
      function)))

(defun run ()
  (dolist (debug '(0 1 3))
    (dolist (count '(0 1 8))
      (let ((function (compile-case (return-form count) debug)))
        (assert (equal (funcall function t)
                       (list (loop for index below count collect index) 1)))
        (assert (equal (funcall function nil) '((23) 1)))))
    (let ((function (compile-case (go-form) debug)))
      (assert (equal (funcall function t) '((3 :go) 1)))
      (assert (equal (funcall function nil) '((4 :go) 1)))))
  (format t "PASS typed RETURN-FROM/GO, both paths, zero/one/eight transferred values, cleanup, and DEBUG 0/1/3.~%")
  :type-control-flow-tested)
