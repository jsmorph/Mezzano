(defpackage #:lispm-frame-transfer-lifetime-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:e #:lispm-entry-arguments-test))
  (:export #:run))
(in-package #:lispm-frame-transfer-lifetime-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defvar *expected*)
(defvar *check*)
(defvar *cleanups* 0)

(defun target (callback value)
  (unwind-protect
       (funcall callback value)
    (incf *cleanups*)
    (mezzano.extensions:gc :full t))
  (error "Transfer lifetime target resumed."))

(defun replacement (value)
  (assert (eq value *expected*))
  (assert (mezzano.runtime::dynamic-extent-p value))
  (mezzano.extensions:gc :full t)
  (funcall *check* value)
  (values value :reinvoked))

(defun run-owned (value check operation older younger)
  (assert (mezzano.runtime::dynamic-extent-p value))
  (let* ((*expected* value) (*check* check) (*cleanups* 0)
         (result
           (multiple-value-list
            (e::with-prompts
             older
             (lambda ()
               (target
                (lambda (argument)
                  (e::with-prompts
                   younger
                   (lambda ()
                     (let ((frame (e::selected-frame #'target)))
                       (ecase operation
                         (:return (i::return-from-frame frame (list argument :returned)))
                         (:reinvoke (i::reinvoke-frame frame #'replacement (list argument))))))))
                value))))))
    (assert (= *cleanups* 1))
    (assert (eq (first result) value))
    (assert (equal (rest result) (list (ecase operation (:return :returned) (:reinvoke :reinvoked)))))
    (mezzano.extensions:gc :full t)
    (funcall check value)
    t))

(defun cons-case (operation depth)
  (let* ((marker (vector :heap))
         (value (list marker :tail)))
    (declare (dynamic-extent value))
    (run-owned value
               (lambda (object)
                 (assert (eq (first object) marker))
                 (assert (equal (rest object) '(:tail))))
               operation depth depth)))

(defun vector-case (operation older younger)
  (let* ((marker (vector :heap))
         (value (vector marker :tail)))
    (declare (dynamic-extent value))
    (run-owned value
               (lambda (object)
                 (assert (= (length object) 2))
                 (assert (eq (aref object 0) marker))
                 (assert (eq (aref object 1) :tail)))
               operation older younger)))

(defun closure-case (operation)
  (let ((count 0))
    (flet ((value () (incf count)))
      (declare (dynamic-extent (function value)))
      (run-owned #'value (lambda (object) (assert (plusp (funcall object))))
                 operation 2 2))
    (assert (plusp count))))

(defun run ()
  (cons-case :return 0)
  (cons-case :reinvoke 2)
  (vector-case :return 0 2)
  (vector-case :reinvoke 2 0)
  (closure-case :return)
  (closure-case :reinvoke)
  (format t "PASS caller-owned DX cons/vector/closure identity through Return/Reinvoke, cleanup, full GC, and prompt stacks.~%")
  t)
