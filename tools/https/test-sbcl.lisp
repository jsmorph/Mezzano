(defpackage #:lispm-https-test
  (:use #:cl)
  (:export #:run-transport-tests #:run-openai-test))

(in-package #:lispm-https-test)

(defun call-with-openai-tls (function &key (hostname "api.openai.com")
                                         ca-file
                                         (context (pure-tls:make-tls-context :ca-file ca-file)))
  (let ((socket (usocket:socket-connect "api.openai.com" 443
                                       :element-type '(unsigned-byte 8)
                                       :timeout 15))
        (tls nil))
    (unwind-protect
         (cl-cancel:with-timeout-context (deadline 30)
           (setf tls
                 (pure-tls:make-tls-client-stream
                  (usocket:socket-stream socket)
                  :hostname hostname
                  :sni-hostname "api.openai.com"
                  :verify pure-tls:+verify-required+
                  :context context
                  :request-context deadline))
           (funcall function tls))
      (if tls
          (close tls :abort t)
          (usocket:socket-close socket)))))

(defun call-with-chain-verification-count (function label)
  (let* ((name 'pure-tls::verify-certificate-chain)
         (original (fdefinition name))
         (thread (bt:current-thread))
         (count 0)
         (wrapper (lambda (&rest arguments)
                    (when (eq thread (bt:current-thread))
                      (incf count))
                    (apply original arguments))))
    (unwind-protect
         (progn
           (setf (fdefinition name) wrapper)
           (funcall function)
           (assert (= count 1) () "~A verified the chain ~D times." label count)
           (format t "~A verified the certificate chain once.~%" label))
      (when (eq (fdefinition name) wrapper)
        (setf (fdefinition name) original)))))

(defun expect-verification-error (function label)
  (handler-case
      (progn (funcall function)
             (error "~A: certificate verification unexpectedly succeeded." label))
    (pure-tls:tls-verification-error (condition)
      (format t "~A rejected: ~A~%" label condition))))

(defun test-verification-failures (ca-file label)
  (expect-verification-error
   (lambda ()
     (call-with-openai-tls
      (constantly nil) :hostname "hostname-mismatch.invalid" :ca-file ca-file))
   (format nil "~A mismatched hostname" label))
  (let ((pure-tls::*auto-load-system-trust-store* nil))
    (expect-verification-error
     (lambda ()
       (call-with-openai-tls
        (constantly nil)
        :context (pure-tls:make-tls-context :auto-load-system-ca nil)))
     (format nil "~A empty trust store" label))))

(defun test-unauthenticated-get (ca-file)
  (cl-cancel:with-timeout-context (deadline 30)
    (declare (ignore deadline))
    (let ((drakma:*header-stream* nil))
      (multiple-value-bind (body status)
          (drakma:http-request "https://api.openai.com/v1/models"
                               :verify :required :redirect nil
                               :force-binary t :connection-timeout 15 :ca-file ca-file)
        (unless (= status 401)
          (error "Unauthenticated request returned HTTP ~D; expected 401." status))
        (assert (hash-table-p (gethash "error" (com.inuoe.jzon:parse body))))
        (format t "Unauthenticated HTTPS GET: HTTP ~D, JSON error parsed.~%" status)))))

(defun run-transport-tests (&key ca-file)
  (let ((pure-tls::*session-ticket-cache* (make-hash-table :test 'equal)))
    (call-with-chain-verification-count
     (lambda ()
       (call-with-openai-tls
        (lambda (stream)
          (assert (not (pure-tls::client-handshake-psk-accepted
                        (pure-tls::tls-stream-handshake stream))))
          (format t "Verified handshake: version ~S, cipher ~S.~%"
                  (pure-tls:tls-version stream)
                  (pure-tls:tls-cipher-suite stream)))
        :ca-file ca-file))
     "Full handshake")
    (test-verification-failures ca-file "Full handshake")
    (test-unauthenticated-get ca-file)
    (let ((ticket (pure-tls::session-ticket-cache-get "api.openai.com")))
      (assert ticket () "The HTTP exchange did not receive a session ticket.")
      (assert (pure-tls::session-ticket-peer-certificate-chain ticket))
      (call-with-chain-verification-count
       (lambda ()
         (call-with-openai-tls
          (lambda (stream)
            (assert (pure-tls::client-handshake-psk-accepted
                     (pure-tls::tls-stream-handshake stream)))
            (assert (pure-tls:tls-peer-certificate stream)))
          :ca-file ca-file))
       "Resumed handshake")
      (test-verification-failures ca-file "Populated cache")
      (let ((without-chain (pure-tls::copy-session-ticket ticket)))
        (setf (pure-tls::session-ticket-peer-certificate-chain without-chain) nil)
        (pure-tls::session-ticket-cache-put "api.openai.com" without-chain)
        (unwind-protect
             (expect-verification-error
              (lambda () (call-with-openai-tls (constantly nil) :ca-file ca-file))
              "Cached ticket without peer certificates")
          (pure-tls::session-ticket-cache-put "api.openai.com" ticket)))))
  t)

(defun run-openai-test (api-key &key (model "gpt-4.1-nano") ca-file)
  (let ((request (make-hash-table :test 'equal)))
    (setf (gethash "model" request) model
          (gethash "input" request) "Reply with exactly: Lisp HTTPS works."
          (gethash "store" request) nil)
    (multiple-value-bind (response request-id)
        (lispm-openai:create-response api-key request :ca-file ca-file)
      (let ((output
              (with-output-to-string (stream)
                (loop for item across (gethash "output" response)
                      when (equal (gethash "type" item) "message")
                        do (loop for part across (gethash "content" item)
                                 when (equal (gethash "type" part) "output_text")
                                   do (write-string (gethash "text" part) stream))))))
        (unless (equal (gethash "status" response) "completed")
          (error "OpenAI response status: ~S." (gethash "status" response)))
        (unless (plusp (length output))
          (error "OpenAI returned no output text."))
        (format t "HTTPS POST: HTTP 200; model ~A; status ~A; request ID ~A.~%"
                (gethash "model" response) (gethash "status" response) request-id)
        (format t "Response: ~A~%Tokens: input ~D, output ~D.~%"
                output
                (gethash "input_tokens" (gethash "usage" response))
                (gethash "output_tokens" (gethash "usage" response)))
        response))))
