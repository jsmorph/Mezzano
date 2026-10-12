(dolist (file '("test-atomics.lisp" "test-cancellation.lisp"
                "test-http-cleanup.lisp" "test-sbcl.lisp" "test-openai.lisp"))
  (load (merge-pathnames file *load-truename*)))

(defpackage #:lispm-https-guest-test
  (:use #:cl)
  (:export #:run #:run-authenticated-from-file))
(in-package #:lispm-https-guest-test)

(defun run (&key (ca-file "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT"))
  (let ((first (ironclad:random-data 8193))
        (second (ironclad:random-data 8193)))
    (assert (typep first '(simple-array (unsigned-byte 8) (*))))
    (assert (typep second '(simple-array (unsigned-byte 8) (*))))
    (assert (= (length first) (length second) 8193))
    (assert (not (equalp first second)))
    (format t "PASS Ironclad guest entropy calls.~%"))
  (lispm-atomics-test:run)
  (lispm-cancellation-test:run)
  (lispm-http-cleanup-test:run)
  (lispm-https-test:run-transport-tests :ca-file ca-file)
  (lispm-openai-test:run :ca-file ca-file)
  t)

(defun run-authenticated-from-file (pathname &key (ca-file "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT"))
  (let ((failure nil))
    (let ((key (with-open-file (stream pathname) (read-line stream))))
      (unwind-protect
           (handler-case
               (lispm-https-test:run-openai-test key :ca-file ca-file)
             (error (condition) (setf failure (type-of condition))))
        (fill key #\Space)))
    (when failure
      (error "Guest OpenAI test failed with condition type ~S." failure)))
  t)
