(in-package #:lispm-gc-stack-guard-test)

(defun read-return-page-flags-in-pager (address unused2 unused3)
  (declare (ignore unused2 unused3))
  (s::with-rw-lock-read (s::*vm-lock*)
    (s::block-info-for-virtual-address address)))
