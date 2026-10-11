(defpackage #:lispm-closure-write-test (:use #:cl))
(in-package #:lispm-closure-write-test)

(defun binding (frame name)
  (let ((variables (remove name (mezzano.debug:frame-local-variables frame)
                           :key #'mezzano.debug:local-variable-name
                           :test-not #'eq)))
    (assert (= (length variables) 1) () "Expected one ~S binding: ~S" name variables)
    (let ((variable (first variables)))
      (assert (consp (mezzano.internals::local-variable-location variable)))
      (assert (eq (mezzano.internals::local-variable-representation variable) :value))
      variable)))

(defun check-closure-write (definition arguments name before replacement after expected)
  (let* ((target (compile nil definition))
         (seen nil)
         (escaped-reader nil)
         (escaped-writer nil)
         (inspect
           (lambda (reader &optional writer)
             (setf escaped-reader reader escaped-writer writer)
             (assert (equal (funcall reader) before))
             (mezzano.debug:map-backtrace
              (lambda (frame)
                (when (eq (nth-value 1 (mezzano.debug:frame-function frame)) target)
                  (let ((variable (binding frame name)))
                    (assert (equal (mezzano.debug:local-variable-value frame variable) before))
                    (mezzano.internals::write-frame-slot
                     (list 0 (mezzano.internals::frame-fp frame) nil)
                     (mezzano.internals::local-variable-location variable)
                     replacement :value)
                    (assert (equal (funcall reader) replacement))
                    (when writer
                      (funcall writer after)
                      (assert (equal (mezzano.debug:local-variable-value frame variable) after)))
                    (setf seen t)))))))
         (result (apply target inspect arguments)))
    (assert seen)
    (assert (equal result expected) () "Continuation produced ~S, expected ~S." result expected)
    (mezzano.extensions:gc :full t)
    (assert (equal (funcall escaped-reader) after))
    (when escaped-writer
      (funcall escaped-writer before)
      (assert (equal (funcall escaped-reader) before)))))

(check-closure-write
 '(lambda (inspect a)
    (declare (optimize (debug 3) (safety 3)))
    (let ((reader (lambda () a)))
      (funcall inspect reader)
      (list a (funcall reader))))
 '(111) 'a 111 222 222 '(222 222))

(check-closure-write
 '(lambda (inspect initial)
    (declare (optimize (debug 3) (safety 3)))
    (let* ((a initial)
           (reader (lambda () a))
           (writer (lambda (value) (setf a value))))
      (funcall inspect reader writer)
      (list a (funcall reader))))
 '(111) 'a 111 222 333 '(333 333))

(check-closure-write
 '(lambda (inspect initial)
    (declare (optimize (debug 3) (safety 3)))
    (multiple-value-bind (a b) (values initial 444)
      (let ((reader (lambda () a)))
        (funcall inspect reader)
        (list a b (funcall reader)))))
 '(111) 'a 111 222 222 '(222 444 222))

(dolist (arguments '(() (111)))
  (check-closure-write
   '(lambda (inspect &optional (a 111))
      (declare (optimize (debug 3) (safety 3)))
      (let ((reader (lambda () a)))
        (funcall inspect reader)
        (list a (funcall reader))))
   arguments 'a 111 222 222 '(222 222)))

(check-closure-write
 '(lambda (inspect &optional a)
    (declare (optimize (debug 3) (safety 3)))
    (let ((reader (lambda () a)))
      (funcall inspect reader)
      (list a (funcall reader))))
 '() 'a nil 222 222 '(222 222))

(check-closure-write
 '(lambda (inspect &optional (a 111 supplied))
    (declare (optimize (debug 3) (safety 3)))
    (let ((reader (lambda () supplied)))
      (funcall inspect reader)
      (list a supplied (funcall reader))))
 '() 'supplied nil t t '(111 t t))

(check-closure-write
 '(lambda (inspect &rest a)
    (declare (optimize (debug 3) (safety 3)))
    (let ((reader (lambda () a)))
      (funcall inspect reader)
      (list a (funcall reader))))
 '(111) 'a '(111) '(222 333) '(222 333) '((222 333) (222 333)))

(check-closure-write
 '(lambda (inspect &key (a 111))
    (declare (optimize (debug 3) (safety 3)))
    (let ((reader (lambda () a)))
      (funcall inspect reader)
      (list a (funcall reader))))
 '(:a 111) 'a 111 222 222 '(222 222))

(format t "PASS captured argument, LET, multiple-value, optional, supplied-p, rest, and keyword writes; escaped closures and GC~%")
(in-package #:cl-user)
