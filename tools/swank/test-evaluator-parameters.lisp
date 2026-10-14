(defpackage #:lispm-evaluator-parameters-test
  (:use #:cl)
  (:export #:run #:prepare-restore-test #:finish-restore-test))
(in-package #:lispm-evaluator-parameters-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defvar *state* 17)

(defun read-state () *state*)

(defmacro declared-type (name &environment environment)
  (list 'quote (mezzano.compiler::lookup-variable-declared-type-in-environment
                name environment)))

(defun check-form (form expected)
  (let ((observed (multiple-value-list (mezzano.full-eval:eval-in-lexenv form nil))))
    (assert (equal observed expected)
            () "Interpreted ~S returned ~S instead of ~S." form observed expected))
  (multiple-value-bind (function warnings-p failure-p)
      (compile nil `(lambda () ,form))
    (assert (and function (compiled-function-p function) (not warnings-p) (not failure-p)))
    (let ((observed (multiple-value-list (funcall function))))
      (assert (equal observed expected)
              () "Compiled ~S returned ~S instead of ~S." form observed expected))))

(defun check-call-error (lambda arguments)
  (let ((function (mezzano.full-eval:eval-in-lexenv lambda nil)))
    (assert (handler-case (progn (apply function arguments) nil)
              (error () t))
            () "Missing argument error for ~S with ~S." lambda arguments)))

(defvar *restore-closures* nil)

(defun prepare-restore-test ()
  (assert (null *restore-closures*))
  (setf *restore-closures*
        (multiple-value-list
         (mezzano.full-eval:eval-in-lexenv
          '(macrolet ((next (x) (list '1+ x)))
             (let ((x 17))
               (declare (fixnum x))
               (values (lambda () (next x))
                       (lambda (new) (setf x new)))))
          nil)))
  (assert (= (funcall (first *restore-closures*)) 18))
  (values))

(defun finish-restore-test ()
  (assert (= (length *restore-closures*) 2))
  (mezzano.extensions:gc :full t)
  (assert (= (funcall (first *restore-closures*)) 18))
  (assert (= (funcall (second *restore-closures*) 41) 41))
  (assert (= (funcall (first *restore-closures*)) 42))
  (setf *restore-closures* nil)
  (format t "PASS restored interpreted closures, local macro environment, shared writes, and full GC.~%")
  (values))

(defun run ()
  (check-form
   '(let ((x 17))
      (declare (special x))
      (values (multiple-value-list
               (funcall (lambda (x &optional (y x))
                          (declare (special x))
                          (values x y))
                        42))
              x))
   '((42 42) 17))
  (check-form
   '(let ((*state* 17))
      (values (funcall (lambda (&optional (*state* 42 present))
                         (declare (special present))
                         (list (read-state) present)))
              (funcall (lambda (&optional (*state* 42 present))
                         (declare (special present))
                         (list (read-state) present))
                       37)
              *state*))
   '((42 nil) (37 t) 17))
  (check-form
   '(funcall (lambda (&rest arguments &key (x 40 xp) (y (1+ x))
                       &aux (z (1+ y)))
               (declare (special arguments x xp y z))
               (list arguments x xp y z))
             :x 40)
   '(((:x 40) 40 t 41 42)))
  (check-form
   '(let ((events nil))
      (values (funcall (lambda (x &optional
                                 (y (progn (push :y events) (1+ x)) yp)
                                 (z (progn (push yp events) (1+ y)))
                                 &aux (a (progn (push :a events) (1+ z))))
                         (list x y yp z a))
                       39)
              events))
   '((39 40 nil 41 42) (:a nil :y)))
  (check-form
   '(funcall (lambda (&key (x (error "Unexpected initializer."))) x)
             :x 42 :x 99)
   '(42))
  (check-form
   '(funcall (lambda (&key x) x)
             :ignored 9 :allow-other-keys t :x 42)
   '(42))
  (check-form
   '(funcall (lambda (&key x &allow-other-keys) x) :ignored 9 :x 42)
   '(42))
  (check-form
   '(funcall (lambda (&key x) x) :allow-other-keys nil :x 42)
   '(42))
  (check-form
   '(funcall (lambda (&key x) x)
             :allow-other-keys t :allow-other-keys nil :ignored 9 :x 42)
   '(42))
  (check-form
   '(funcall (lambda (&key ((answer x) 0 supplied)) (list x supplied))
             'answer 42)
   '((42 t)))
  (check-form
   '(let* ((x 4) (seen (declared-type x)))
      (declare (type (integer 0 10) x) (type (integer 3 20) x) (ignorable x))
      seen)
   '((integer 3 10)))
  (check-form
   '(funcall (lambda (x &optional (seen (declared-type x)))
               (declare (type (integer 0 10) x) (type (integer 3 20) x) (ignorable x))
               seen)
             4)
   '((integer 3 10)))
  (check-form
   '(let ((y 17))
      (declare (special y))
      (values (funcall (lambda (&optional (y y)) (declare (special y)) y))
              y))
   '(17 17))
  (check-form
   '(let ((*state* 17) (cleanup nil))
      (values (multiple-value-list
               (catch 'exit
                 (funcall (lambda (*state*)
                            (unwind-protect
                                 (throw 'exit (values (read-state) 43))
                              (setf cleanup (read-state))))
                          42)))
              *state* cleanup))
   '((42 43) 17 42))
  (check-form
   '(let ((*state* 17) (cleanup nil))
      (values (handler-case
                  (funcall (lambda (*state*)
                             (unwind-protect (error "Parameter unwind test.")
                               (setf cleanup (read-state))))
                           42)
                (error () :caught))
              *state* cleanup))
   '(:caught 17 42))
  (check-form
   '(multiple-value-bind (read write)
        (funcall (lambda (x)
                   (declare (fixnum x))
                   (values (lambda () x) (lambda (new) (setf x new))))
                 17)
      (let ((before (funcall read)))
        (funcall write 42)
        (values before (funcall read))))
   '(17 42))
  (check-call-error '(lambda (x) x) nil)
  (check-call-error '(lambda (x) x) '(1 2))
  (check-call-error '(lambda (&key x) x) '(:x))
  (check-call-error '(lambda (&key x) x) '(:unknown 1))
  (check-call-error '(lambda (&key x) x)
                    '(:allow-other-keys nil :allow-other-keys t :unknown 1))
  (multiple-value-bind (function warnings-p failure-p)
      (compile nil
               '(lambda (first &key x mezzano.internals::&count argument-count)
                  (declare (special argument-count))
                  (list first x argument-count)))
    (assert (and function (not warnings-p) (not failure-p)))
    (assert (equal (funcall function 7 :x 42) '(7 42 3))))
  (format t "PASS interpreted parameter bindings, initializer order and declarations, keyword rules, shared closures, multiple values, and dynamic unwinding.~%")
  (values))
