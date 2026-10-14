(defpackage #:lispm-large-code-display-test
  (:use #:cl #:mezzano.debug)
  (:local-nicknames (#:d #:mezzano.debug) (#:i #:mezzano.internals)
                    (#:dis #:mezzano.disassemble)
                    (#:test #:lispm-service-test) (#:catch-test #:lispm-catch-display-test))
  (:export #:run))
(in-package #:lispm-large-code-display-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defvar *target* nil)
(defvar *last-value* nil)

(defun sink (value)
  (setf *last-value* value))

(defun check-output (handle lease controller)
  (declare (ignore controller))
  (let* ((stop (d::service-handle-stop handle))
         (history (copy-list (d::service-stop-evaluation-history stop)))
         (output (test::command handle lease :compiled-code))
         (context (dis:make-disassembler-context *target*))
         (instructions (dis:context-instructions context))
         (last (aref instructions (1- (length instructions)))))
    (assert (> (length output) 65535))
    (assert (search (format nil "#x~4,'0X:" (dis:inst-offset last)) output))
    (assert (equal history (d::service-stop-evaluation-history stop)))
    (assert (null *last-value*))
    (format t "Large disassembly: ~D characters, ~D decoded rows.~%"
            (length output) (length instructions))))

(defun run ()
  (setf *last-value* nil
        *target*
        (compile nil `(lambda ()
                        (break "Owned large code display test.")
                        ,@(loop for value below 1000 collect `(sink ,value))
                        (values 42 43))))
  (unwind-protect
       (progn
         (catch-test::run-target "(funcall lispm-large-code-display-test::*target*)"
                                 *target* #'check-output)
         (assert (= *last-value* 999)))
    (setf *target* nil *last-value* nil))
  (format t "PASS large complete disassembly, terminal instruction, unchanged history, multiple values, continuation effects, and release.~%")
  t)
