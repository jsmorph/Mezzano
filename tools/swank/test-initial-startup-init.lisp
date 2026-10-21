(in-package :cl-user)
(defvar *startup-test-initial-error* t)
(defvar *startup-test-init-effects* nil)
(push :before *startup-test-init-effects*)
(when *startup-test-initial-error*
  (cerror "Continue initial startup." "Owned initial startup recovery test.")
  (setf *startup-test-initial-error* nil))
(push :after *startup-test-init-effects*)
