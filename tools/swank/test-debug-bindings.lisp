(defpackage #:lispm-binding-test (:use #:cl))
(in-package #:lispm-binding-test)

(defun check-frame-bindings (frame expected)
  (let ((locals (mezzano.debug:frame-local-variables frame)))
    (dolist (entry expected)
      (let ((variables (remove (first entry) locals
                               :key #'mezzano.debug:local-variable-name
                               :test-not #'eq)))
        (assert (= (length variables) (length (rest entry)))
                () "Missing bindings for ~S: ~S" entry locals)
        (let ((values
                (mapcar (lambda (variable)
                          (multiple-value-bind (value validp)
                              (mezzano.debug:local-variable-value frame variable)
                            (assert validp)
                            value))
                        variables)))
          (assert (equal (sort values #'<)
                         (sort (copy-list (rest entry)) #'<))))))))

(defun check-bindings (definition arguments expected result)
  (let* ((target (compile nil definition))
         (seen nil)
         (inspect
           (lambda ()
             (mezzano.debug:map-backtrace
              (lambda (frame)
                (when (eq (nth-value 1 (mezzano.debug:frame-function frame)) target)
                  (setf seen t)
                  (check-frame-bindings frame expected)))))))
    (assert (equal (apply target (append arguments (list inspect))) result))
    (assert seen)))

(check-bindings
 '(lambda (a inspect)
    (declare (optimize (debug 3) (safety 3)))
    (let ((b a))
      (funcall inspect)
      (list a b)))
 '(111) '((a 111) (b 111)) '(111 111))

(check-bindings
 '(lambda (inspect)
    (declare (optimize (debug 3) (safety 3)))
    (let ((constant 17) (unused 23))
      (declare (ignorable unused))
      (funcall inspect)
      constant))
 '() '((constant 17) (unused 23)) 17)

(check-bindings
 '(lambda (a inspect)
    (declare (optimize (debug 3) (safety 3)) (ignorable a))
    (let ((a 222))
      (funcall inspect)
      a))
 '(111) '((a 111 222)) 222)

(check-bindings
 '(lambda (a inspect)
    (declare (optimize (debug 1) (safety 3)))
    (let ((b a))
      (funcall inspect)
      (list a b)))
 '(111) '((b)) '(111 111))

(format t "PASS debug 3 copied, constant, unused, and shadowed bindings; debug 1 propagation~%")
(in-package #:cl-user)
