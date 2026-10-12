(defpackage #:lispm-openai-test
  (:use #:cl)
  (:export #:run))
(in-package #:lispm-openai-test)

(defun run (&key ca-file)
  (let ((request (make-hash-table :test 'equal)))
    (setf (gethash "model" request) "gpt-4.1-nano"
          (gethash "input" request) "Test"
          (gethash "store" request) nil)
    (handler-case
        (progn
          (lispm-openai:create-response "invalid-key-for-test" request :ca-file ca-file)
          (error "Invalid credential unexpectedly succeeded."))
      (lispm-openai:http-error (condition)
        (assert (= 401 (lispm-openai:http-error-status condition)))
        (assert (hash-table-p
                 (gethash "error" (com.inuoe.jzon:parse
                                  (lispm-openai:http-error-body condition)))))
        (format t "PASS typed HTTP 401 with JSON error; request ID ~A.~%"
                (lispm-openai:http-error-request-id condition)))))
  t)
