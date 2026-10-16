(in-package #:lispm-nlx-step-test)

(defun helper-without-interrupts ()
  (s::safe-without-interrupts ()
    (i::%%debugger-nlx-entry)))
