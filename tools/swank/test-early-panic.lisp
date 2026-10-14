(defpackage #:lispm-early-panic-test
  (:use #:cl)
  (:export #:install #:uninstall))
(in-package #:lispm-early-panic-test)
(declaim (optimize (safety 3) (debug 1) (speed 1)))

(defvar *original-console* nil)

(defun test-console (boot-information-page)
  (funcall (load-time-value
            (fdefinition 'mezzano.supervisor::initialize-platform-early-console) t)
           boot-information-page)
  (mezzano.supervisor:panic "Owned early-console panic test."))

(defun install ()
  (assert (null *original-console*))
  (setf *original-console* #'mezzano.supervisor::initialize-platform-early-console
        (fdefinition 'mezzano.supervisor::initialize-platform-early-console)
        #'test-console)
  t)

(defun uninstall ()
  (assert *original-console*)
  (setf (fdefinition 'mezzano.supervisor::initialize-platform-early-console)
        *original-console*
        *original-console* nil)
  t)
