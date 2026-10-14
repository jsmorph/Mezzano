(defpackage #:lispm-local-availability-test
  (:use #:cl)
  (:export #:run))
(in-package #:lispm-local-availability-test)

(declaim (optimize (safety 3) (debug 3) (speed 1)))

(defun check-frame (frame expected captured-p)
  (let ((locals (mezzano.debug:frame-local-variables frame)))
    (dolist (entry expected)
      (let ((local (find (first entry) locals :key #'mezzano.debug:local-variable-name)))
        (assert local)
        (assert (equal (multiple-value-list
                        (mezzano.debug:local-variable-value frame local))
                       (list (second entry) t)))
        (when captured-p
          (let ((location (mezzano.internals::local-variable-location local)))
            (assert (and (consp location) (not (eq (first location) 'quote)))))))))
  (let ((output
          (with-output-to-string (*standard-output*)
            (mezzano.internals::debugger-show-variables
             (mezzano.internals::frame-raw-data frame)))))
    (assert (not (search "[unavailable]" output)))))

(defun check-compiled (definition value expected &optional captured-p)
  (let ((target (compile nil definition)) (seen nil) (result nil))
    (flet ((inspect ()
             (mezzano.debug:map-backtrace
              (lambda (frame)
                (when (eq (nth-value 1 (mezzano.debug:frame-function frame)) target)
                  (setf seen t)
                  (check-frame frame expected captured-p))))))
      (setf result (funcall target value #'inspect)))
    (assert seen)
    (assert (eql result value))))

(defun run ()
  (dolist (value '(nil :$inaccessible-value$))
    (check-compiled
     '(lambda (value inspect)
        (declare (optimize (debug 3) (safety 3)))
        (let ((copy value) (constant :$inaccessible-value$) (empty nil))
          (funcall inspect)
          (values value copy constant empty)))
     value (list (list 'value value) (list 'copy value)
                 '(constant :$inaccessible-value$) '(empty nil)))
    (check-compiled
     '(lambda (value inspect)
        (declare (optimize (debug 3) (safety 3)))
        (let ((reader (lambda () value)))
          (funcall inspect)
          (values value reader)))
     value (list (list 'value value)) t)
    (let* ((frame (mezzano.internals::make-frame :callee-save-regs (list (cons :test value))))
           (local (mezzano.internals::make-local-variable
                   :name 'value :location :test :representation :value)))
      (assert (equal (multiple-value-list (mezzano.debug:local-variable-value frame local))
                     (list value t))))
    (assert (equal (multiple-value-list
                    (mezzano.internals::read-frame-slot nil (list 'quote value)))
                   (list value t))))
  (let* ((frame (mezzano.internals::make-frame))
         (raw (mezzano.internals::frame-raw-data frame)))
    (dolist (location '(:absent (:absent 0)))
      (assert (equal (multiple-value-list
                      (mezzano.debug:local-variable-value
                       frame (mezzano.internals::make-local-variable
                              :name 'absent :location location :representation :value)))
                     '(nil nil))))
    (assert (handler-case
                (progn (mezzano.internals::write-frame-slot raw '(:absent 0) 17) nil)
              (error (condition) (search "unavailable" (princ-to-string condition))))))
  (let ((raw (list nil nil nil (list (cons :test (vector :invalid))))))
    (assert (handler-case
                (progn (mezzano.internals::read-frame-slot raw '(:test 0 0)) nil)
              (type-error () t))))
  (format t "PASS NIL and keyword arguments, copies, constants, closures, register values, unavailable storage, and closure read errors.~%")
  (values))
