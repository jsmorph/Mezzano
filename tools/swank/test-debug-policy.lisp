(defpackage #:lispm-debug-policy-test (:use #:cl))
(in-package #:lispm-debug-policy-test)

(defun check-policy (function-debug capturedp &optional (body-debug 3))
  (let* ((target
           (compile nil
                    `(lambda (inspect original)
                       (declare (optimize (debug ,function-debug) (safety 3)))
                       (locally
                           (declare (optimize (debug 3)))
                         (let ((a original) (b original) (unused (list :retained)))
                           (declare (ignorable unused))
                           ,(if capturedp
                                `(let ((reader (lambda () a)))
                                   (locally
                                       (declare (optimize (debug ,body-debug)))
                                     (funcall inspect reader)
                                     (list a b (funcall reader))))
                                `(locally
                                     (declare (optimize (debug ,body-debug)))
                                   (funcall inspect nil)
                                   (list a b))))))))
         (seen nil)
         (result
           (funcall
            target
            (lambda (reader)
              (mezzano.extensions:gc :full t)
              (mezzano.debug:map-backtrace
               (lambda (frame)
                 (when (eq (nth-value 1 (mezzano.debug:frame-function frame)) target)
                   (let ((locals (mezzano.debug:frame-local-variables frame)))
                     (labels ((binding (name)
                                (let ((matches (remove name locals
                                                       :key #'mezzano.debug:local-variable-name
                                                       :test-not #'eq)))
                                  (assert (= (length matches) 1) ()
                                          "Expected one ~S at debug ~D: ~S"
                                          name function-debug locals)
                                  (first matches)))
                              (value (name)
                                (multiple-value-bind (value validp)
                                    (mezzano.debug:local-variable-value frame (binding name))
                                  (assert validp)
                                  value)))
                       (assert (eql (value 'a) 111))
                       (assert (eql (value 'b) 111))
                       (assert (equal (value 'unused) '(:retained)))
                       (when (zerop function-debug)
                         (dolist (name '(inspect original))
                           (assert (not (find name locals
                                              :key #'mezzano.debug:local-variable-name)))))
                       (let* ((variable (binding 'a))
                              (location (mezzano.internals::local-variable-location variable)))
                         (assert (eq (mezzano.internals::local-variable-representation variable)
                                     :value))
                         (assert (if capturedp (consp location) (integerp location)))
                         (mezzano.internals::write-frame-slot
                          (list 0 (mezzano.internals::frame-fp frame) nil)
                          location (list :changed) :value))
                       (mezzano.extensions:gc :full t)
                       (assert (equal (value 'a) '(:changed)))
                       (assert (eql (value 'b) 111))
                       (assert (equal (value 'unused) '(:retained)))
                       (when reader
                         (assert (equal (funcall reader) '(:changed))))
                       (setf seen t)))))))
            111)))
    (assert seen)
    (assert (equal result (if capturedp
                             '((:changed) 111 (:changed))
                             '((:changed) 111))))))

(dolist (function-debug '(0 1 2))
  (dolist (capturedp '(nil t))
    (check-policy function-debug capturedp)))

(dolist (capturedp '(nil t))
  (check-policy 0 capturedp 0))

(format t "PASS local debug policy, binding writes, closure sharing, and GC during inspection~%")
(in-package #:cl-user)
