(defpackage #:lispm-https-test
  (:use #:cl)
  (:export #:run-transport-tests #:run-openai-test))

(in-package #:lispm-https-test)

(defun call-with-openai-tls (function &key (hostname "api.openai.com")
                                         (context (pure-tls:make-tls-context)))
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

(defun expect-verification-error (function label)
  (handler-case
      (progn (funcall function)
             (error "~A: certificate verification unexpectedly succeeded." label))
    (pure-tls:tls-verification-error (condition)
      (format t "~A rejected: ~A~%" label condition))))

(defun run-transport-tests ()
  (call-with-openai-tls
   (lambda (stream)
     (format t "Verified handshake: version ~S, cipher ~S.~%"
             (pure-tls:tls-version stream)
             (pure-tls:tls-cipher-suite stream))))
  (expect-verification-error
   (lambda ()
     (call-with-openai-tls
      (constantly nil) :hostname "hostname-mismatch.invalid"))
   "Mismatched hostname")
  (let ((pure-tls::*auto-load-system-trust-store* nil))
    (expect-verification-error
     (lambda ()
       (call-with-openai-tls
        (constantly nil)
        :context (pure-tls:make-tls-context :auto-load-system-ca nil)))
     "Empty trust store"))
  (cl-cancel:with-timeout-context (deadline 30)
    (declare (ignore deadline))
    (let ((drakma:*header-stream* nil))
      (multiple-value-bind (body status)
          (drakma:http-request "https://api.openai.com/v1/models"
                               :verify :required :redirect nil
                               :force-binary t :connection-timeout 15)
        (unless (= status 401)
          (error "Unauthenticated request returned HTTP ~D; expected 401." status))
        (assert (hash-table-p (gethash "error" (com.inuoe.jzon:parse body))))
        (format t "Unauthenticated HTTPS GET: HTTP ~D, JSON error parsed.~%" status))))
  t)

(defun run-openai-test (api-key &key (model "gpt-4.1-nano"))
  (check-type api-key string)
  (when (or (zerop (length api-key))
            (find #\Return api-key)
            (find #\Newline api-key))
    (error "Expected a nonempty API key without line breaks."))
  (let ((request (make-hash-table :test 'equal))
        (authorization (concatenate 'string "Bearer " api-key))
        (drakma:*header-stream* nil))
    (setf (gethash "model" request) model
          (gethash "input" request) "Reply with exactly: Lisp HTTPS works."
          (gethash "store" request) nil)
    (unwind-protect
         (cl-cancel:with-timeout-context (deadline 60)
           (declare (ignore deadline))
           (multiple-value-bind (body status headers)
               (drakma:http-request
                "https://api.openai.com/v1/responses"
                :method :post :verify :required :redirect nil
                :connection-timeout 15 :force-binary t
                :content-type "application/json"
                :content (babel:string-to-octets
                          (com.inuoe.jzon:stringify request) :encoding :utf-8)
                :additional-headers (list (cons "Authorization" authorization)))
             (unless (= status 200)
               (error "OpenAI returned HTTP ~D; request ID ~A."
                      status (cdr (assoc :x-request-id headers))))
             (let* ((response (com.inuoe.jzon:parse body))
                    (output
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
               (format t "HTTPS POST: HTTP ~D; model ~A; status ~A.~%"
                       status (gethash "model" response) (gethash "status" response))
               (format t "Response: ~A~%Tokens: input ~D, output ~D.~%"
                       output
                       (gethash "input_tokens" (gethash "usage" response))
                       (gethash "output_tokens" (gethash "usage" response)))
               response)))
      (fill authorization #\Space))))
