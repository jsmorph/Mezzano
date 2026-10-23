(in-package #:lispm-nlx-step-test)

(defun helper-without-interrupts ()
  (declare (optimize (debug 1) (safety 3) (speed 1)))
  (s::safe-without-interrupts ()
    (i::%%debugger-nlx-entry)))
