(defpackage :mezzano-array-transform-test
  (:use :cl)
  (:export :capture :run))
(in-package :mezzano-array-transform-test)

(defvar *order*)

(defparameter *specifications*
  '((t :old :new ())
    (fixnum 0 #.most-positive-fixnum (#.(1+ most-positive-fixnum)))
    ((unsigned-byte 64) 0 #xffffffffffffffff (-1 #x10000000000000000))
    ((unsigned-byte 32) 0 #xffffffff (-1 #x100000000))
    ((unsigned-byte 16) 0 #xffff (-1 #x10000))
    ((unsigned-byte 8) 0 #xff (-1 #x100))
    ((signed-byte 64) #x-8000000000000000 #x7fffffffffffffff
     (#x-8000000000000001 #x8000000000000000))
    ((signed-byte 32) #x-80000000 #x7fffffff (#x-80000001 #x80000000))
    ((signed-byte 16) #x-8000 #x7fff (#x-8001 #x8000))
    ((signed-byte 8) -128 127 (-129 128))
    (single-float 0.0f0 1.5f0 (0))
    (double-float 0.0d0 1.5d0 (0))))

(defun accessors (type debug &optional (dimension '*))
  (let* ((array-type `(simple-array ,type (,dimension)))
         (array `(the ,array-type (progn (push :array *order*) array)))
         (index '(the fixnum (progn (push :index *order*) index))))
    (list
     (compile nil `(lambda (array index)
                     (declare (optimize (speed 3) (safety 3) (debug ,debug))
                              (type ,array-type array) (type fixnum index))
                     (aref ,array ,index)))
     (compile nil `(lambda (array index value)
                     (declare (optimize (speed 3) (safety 3) (debug ,debug))
                              (type ,array-type array) (type fixnum index))
                     (setf (aref ,array ,index)
                           (progn (push :value *order*) value)))))))

(defun capture ()
  (loop for debug in '(1 3) append
    (loop for (type) in *specifications* collect
      (list type debug (accessors type debug)))))

(defun outcome (function arguments)
  (let ((*order* nil))
    (append
     (handler-case
         (list :values (multiple-value-list (apply function arguments)))
       (type-error (condition)
         (list :error (type-of condition)
               :datum (type-error-datum condition)
               :expected-type (type-error-expected-type condition)))
       (simple-error (condition)
         (list :error (type-of condition)
               :control (simple-condition-format-control condition)
               :arguments (simple-condition-format-arguments condition))))
     (list :order (reverse *order*)))))

(defun run (&optional reference)
  (let ((count 0))
    (dolist (debug '(1 3))
      (dolist (spec *specifications*)
        (destructuring-bind (type initial replacement invalid-values) spec
          (destructuring-bind (reader writer) (accessors type debug)
            (let* ((entry (find-if (lambda (entry)
                                     (and (equal (first entry) type)
                                          (= (second entry) debug)))
                                   reference))
                   (old (third entry))
                   (array (make-array 4 :element-type type :initial-element initial)))
              (labels
                  ((check (function old-function target index value write-p success-p)
                     (let* ((arguments (if write-p (list target index value)
                                           (list target index)))
                            (before (when (vectorp target) (copy-seq target)))
                            (expected (when old-function
                                        (prog1 (outcome old-function arguments)
                                          (when before (replace target before)))))
                            (actual (outcome function arguments)))
                       (incf count)
                       (when expected
                         (assert (equalp actual expected) ()
                                 "Changed array behavior: ~S / debug ~D, ~S versus ~S."
                                 type debug actual expected))
                       (assert (equal (getf actual :order)
                                      (if write-p '(:array :index :value)
                                          '(:array :index))))
                       (if success-p
                           (assert (equalp (getf actual :values)
                                           (list (if write-p value initial))))
                           (progn
                             (assert (getf actual :error))
                             (when before (assert (equalp target before))))))))
                (dolist (index '(0 3))
                  (fill array initial)
                  (check reader (first old) array index nil nil t)
                  (check writer (second old) array index replacement t t)
                  (assert (eql (aref array index) replacement)))
                (dolist (index (list -1 4 most-positive-fixnum
                                    (1+ most-positive-fixnum) 1/2 :bad))
                  (fill array initial)
                  (check reader (first old) array index nil nil nil)
                  (check writer (second old) array index replacement t nil))
                (dolist (target (list 17 (make-array '(2 2) :element-type type
                                                     :initial-element initial)
                                      (make-array 0 :element-type type)))
                  (check reader (first old) target 0 nil nil nil)
                  (check writer (second old) target 0 replacement t nil))
                (dolist (value invalid-values)
                  (fill array initial)
                  (check writer (second old) array 0 value t nil)
                  (check writer (second old) array 4 value t nil))))))))
    (let ((debug 1))
      (destructuring-bind (reader writer) (accessors '(unsigned-byte 32) debug 4)
        (dolist (array (list (make-array 3 :element-type '(unsigned-byte 32))
                            (make-array 4 :element-type '(unsigned-byte 16))))
          (assert (getf (outcome reader (list array 0)) :error))
          (assert (getf (outcome writer (list array 0 7)) :error))
          (incf count 2))))
    (format t "PASS ~D checked array cases at debug 1 and 3.~%" count)
    count))

(in-package :cl-user)
