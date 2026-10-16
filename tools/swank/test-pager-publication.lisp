(defpackage #:lispm-pager-publication-test
  (:use #:cl)
  (:local-nicknames (#:s #:mezzano.supervisor)
                    (#:test #:lispm-service-test))
  (:export #:run))
(in-package #:lispm-pager-publication-test)

(defun probe-symbol (name)
  (find-symbol (concatenate 'string "*PAGER-PUBLICATION-TEST-" name "*")
               "MEZZANO.SUPERVISOR"))

(defun probe-value (name)
  (symbol-value (probe-symbol name)))

(defun run (&key expect-early)
  (assert (>= s::*n-up-cpus* 2))
  (let ((original (fdefinition 's::handle-pager-request))
        (gate-thread nil))
    (dolist (name '("READY" "QUEUED" "OBSERVED" "PUBLISHING" "EARLY" "OWNER" "CPU"))
      (set (probe-symbol name) nil))
    (set (probe-symbol "ORIGINAL-HANDLER") original)
    (unwind-protect
         (progn
           (setf (fdefinition 's::handle-pager-request)
                 #'s::pager-publication-test-handler)
           (setf gate-thread
                 (s:make-thread
                  (lambda () (s::pager-rpc 's::pager-publication-test-gate))
                  :name "Owned pager publication gate"))
           (test::await (lambda () (probe-value "READY")))
           (assert (eq (s::pager-publication-test-rpc) :echo))
           (test::await (lambda () (nth-value 1 (s:thread-join gate-thread nil))))
           (assert (equal (s:thread-join gate-thread nil) '(:gate)))
           (assert (probe-value "OBSERVED"))
           (assert (eql (not (null (probe-value "EARLY"))) expect-early))
           (when expect-early
             (assert (eq (probe-value "OWNER") (probe-value "CPU"))))
           (format t "PASS pager publication: processing before context save ~S; expected ~S.~%"
                   (probe-value "EARLY") expect-early))
      (unwind-protect
           (progn
             (set (probe-symbol "QUEUED") t)
             (when gate-thread
               (test::await
                (lambda () (nth-value 1 (s:thread-join gate-thread nil))))))
        (setf (fdefinition 's::handle-pager-request) original)
        (set (probe-symbol "ORIGINAL-HANDLER") nil)))
    (assert (eq (fdefinition 's::handle-pager-request) original)))
  t)
