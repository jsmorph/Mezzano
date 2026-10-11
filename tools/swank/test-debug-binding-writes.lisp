(defpackage #:lispm-binding-write-test (:use #:cl))
(in-package #:lispm-binding-write-test)

(defun change-binding (frame name value)
  (let* ((variable (find name (mezzano.debug:frame-local-variables frame)
                         :key #'mezzano.debug:local-variable-name))
         (location (and variable
                        (mezzano.internals::local-variable-location variable))))
    (assert variable)
    (assert (integerp location))
    (assert (eq (mezzano.internals::local-variable-representation variable) :value))
    (mezzano.internals::write-frame-slot
     (list 0 (mezzano.internals::frame-fp frame) nil)
     location value :value)))

(defun check-write (definition arguments binding make-value expected)
  (let* ((target (compile nil definition))
         (changed nil)
         (inspect
           (lambda ()
             (mezzano.debug:map-backtrace
              (lambda (frame)
                (when (eq (nth-value 1 (mezzano.debug:frame-function frame)) target)
                  (change-binding frame binding (funcall make-value))
                  (setf changed t))))))
         (result (apply target (append arguments (list inspect)))))
    (assert changed)
    (assert (equal result expected) ()
            "Changing ~S produced ~S, expected ~S." binding result expected)))

(dolist (case '((a (222 111)) (b (111 222))))
  (check-write
   '(lambda (a inspect)
      (declare (optimize (debug 3) (safety 3)))
      (let ((b a))
        (funcall inspect)
        (list a b)))
   '(111) (first case) (lambda () 222) (second case)))

(check-write
 '(lambda (inspect)
    (declare (optimize (debug 3) (safety 3)))
    (let ((constant 17))
      (funcall inspect)
      constant))
 '() 'constant (lambda () 222) 222)

(check-write
 '(lambda (inspect)
    (declare (optimize (debug 3) (safety 3)))
    (multiple-value-bind (a b) (values 111 222)
      (funcall inspect)
      (list a b)))
 '() 'a (lambda () 333) '(333 222))

(check-write
 '(lambda (inspect)
    (declare (optimize (debug 3) (safety 3)))
    (let ((counter 0))
      (dotimes (i 3)
        (when (= i 1) (funcall inspect))
        (incf counter))
      counter))
 '() 'counter (lambda () 10) 12)

(check-write
 '(lambda (a inspect)
    (declare (optimize (debug 3) (safety 3)))
    (let ((b a))
      (funcall inspect)
      (mezzano.extensions:gc :full t)
      (list a b)))
 (list (list 111)) 'a (lambda () (list 222 333)) '((222 333) (111)))

(format t "PASS copied, constant, multiple-value, and loop binding writes; GC after mutation~%")
(in-package #:cl-user)
