(defpackage #:lispm-https-listener-test
  (:use #:cl)
  (:export #:run-get-tests #:run-completion-tests #:run-chunked-tests))
(in-package #:lispm-https-listener-test)

(defun run-chunked-tests ()
  (let* ((crlf (format nil "~C~C" #\Return #\Newline))
         (chunks (concatenate 'string "5" crlf "hello" crlf
                              "6" crlf " world" crlf "0" crlf crlf))
         (bytes (babel:string-to-octets chunks :encoding :latin-1)))
    (dolist (wrapped-p '(nil t))
      (let* ((raw (flexi-streams:make-in-memory-input-stream bytes))
             (input (if wrapped-p (chunga:make-chunked-stream raw) raw)))
        (with-open-stream (decoded (drakma:decode-stream :chunked input))
          (when wrapped-p (assert (eq decoded input)))
          (let ((body (make-array 11 :element-type '(unsigned-byte 8))))
            (assert (= (read-sequence body decoded) 11))
            (assert (equalp body (babel:string-to-octets "hello world" :encoding :latin-1)))
            (assert (eq (read-byte decoded nil :eof) :eof))))))
    (with-open-stream
        (stream
         (flexi-streams:make-flexi-stream
          (chunga:make-chunked-stream
           (make-two-way-stream
            (flexi-streams:make-in-memory-input-stream
             (babel:string-to-octets
              (concatenate 'string "HTTP/1.1 200 OK" crlf
                           "Transfer-Encoding: chunked" crlf
                           "Content-Type: text/plain" crlf crlf chunks)
              :encoding :latin-1))
            (flexi-streams:make-in-memory-output-stream)))
          :external-format :latin-1))
      (multiple-value-bind (body status headers)
          (drakma:http-request "http://fixture.invalid/" :stream stream)
        (assert (equal body "hello world"))
        (assert (= status 200))
        (assert (equal (cdr (assoc :transfer-encoding headers)) "chunked")))))
  (format t "PASS raw and existing chunked streams and chunked HTTP response.~%")
  t)

(defun run-get-tests ()
  (multiple-value-bind (body status headers)
      (cl-user::curl "http://example.org/")
    (assert (= status 200))
    (assert (stringp body))
    (assert (search "Example Domain" body))
    (assert (assoc :content-type headers))
    (assert (equal (cdr (assoc :transfer-encoding headers)) "chunked"))
    (format t "PASS CURL chunked text body, HTTP 200, and response headers.~%"))
  (multiple-value-bind (body status headers)
      (cl-user::curl "https://example.org/")
    (assert (= status 200))
    (assert (stringp body))
    (assert (search "Example Domain" body))
    (assert (assoc :content-type headers))
    (format t "PASS CURL verified HTTPS text body, HTTP 200, and headers.~%"))
  (multiple-value-bind (body status headers)
      (cl-user::curl "https://api.openai.com/v1/models")
    (assert (= status 401))
    (assert (typep body '(array (unsigned-byte 8) (*))))
    (assert (hash-table-p (gethash "error" (com.inuoe.jzon:parse body))))
    (assert (assoc :content-type headers))
    (format t "PASS CURL octet body, HTTP 401, and response headers.~%"))
  t)

(defun run-completion-tests ()
  (let ((failure nil))
    (handler-case
        (dolist (arguments '(("Reply with exactly: Listener completion works.")
                             ("Reply with exactly: Explicit model works."
                              "gpt-4.1-nano-2025-04-14")))
          (let ((text (apply #'cl-user::complete arguments)))
            (assert (and (stringp text) (plusp (length text))))
            (format t "PASS COMPLETE (~A): ~S~%"
                    (if (rest arguments) "explicit model" "default model") text)))
      (error (condition) (setf failure (type-of condition))))
    (when failure
      (error "Listener completion test failed with condition type ~S." failure)))
  t)
