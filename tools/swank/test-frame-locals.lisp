(defpackage #:lispm-frame-test (:use #:cl))
(in-package #:lispm-frame-test)

(let* ((target
         (compile nil
                  '(lambda (a b inspect)
                     (declare (optimize (debug 3) (safety 3)))
                     (funcall inspect)
                     (list a b))))
       (inspected nil)
       (result
         (funcall
          target 111 222
          (lambda ()
            (swank/backend:call-with-debugging-environment
             (lambda ()
               (let* ((index
                        (position target swank/mezzano::*current-backtrace*
                                  :key (lambda (frame)
                                         (nth-value 1
                                           (mezzano.debug:frame-function frame)))
                                  :test #'eq)))
                 (assert index)
                 (let* ((locals (swank/backend:frame-locals index))
                        (ids (mapcar (lambda (local) (getf local :id)) locals)))
                   (assert (= (length ids) (length (remove-duplicates ids))))
                   (dolist (expected '((a 111) (b 222)))
                     (let ((local (find (first expected) locals
                                        :key (lambda (local) (getf local :name)))))
                       (assert local)
                       (assert (eql (getf local :value) (second expected)))
                       (assert (eql (swank/backend:frame-var-value
                                     index (getf local :id))
                                    (second expected)))))
                   (setf inspected t)))))))))
  (assert inspected)
  (assert (equal result '(111 222))))

(format t "PASS SWANK frame-local identity and selection~%")
(in-package #:cl-user)
