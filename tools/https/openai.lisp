(defpackage #:lispm-openai
  (:use #:cl)
  (:export #:create-response #:http-error
           #:http-error-status #:http-error-request-id #:http-error-body))

(in-package #:lispm-openai)

(define-condition http-error (error)
  ((status :initarg :status :reader http-error-status)
   (request-id :initarg :request-id :reader http-error-request-id)
   (body :initarg :body :reader http-error-body))
  (:report (lambda (condition stream)
             (format stream "OpenAI returned HTTP ~D; request ID ~A."
                     (http-error-status condition)
                     (or (http-error-request-id condition) "unavailable")))))

(defun create-response (api-key request &key (timeout 60) ca-file)
  "POST a non-streaming Responses request.  Return parsed JSON and the request ID."
  (check-type api-key string)
  (check-type request hash-table)
  (check-type timeout (real (0)))
  (when (or (zerop (length api-key))
            (find #\Return api-key)
            (find #\Newline api-key))
    (error "Expected a nonempty API key without line breaks."))
  (when (gethash "stream" request)
    (error "CREATE-RESPONSE requires a non-streaming request."))
  (let ((content (babel:string-to-octets
                  (com.inuoe.jzon:stringify request) :encoding :utf-8))
        (authorization (concatenate 'string "Bearer " api-key))
        (drakma:*header-stream* nil))
    (unwind-protect
         (cl-cancel:with-timeout-context (context timeout)
           (cl-cancel:check-cancellation context)
           (multiple-value-bind (body status headers)
               (drakma:http-request
                "https://api.openai.com/v1/responses"
                :method :post :verify :required :redirect nil
                :connection-timeout
                (max 0 (min 15 (- (cl-cancel:deadline context) (cl-cancel:get-current-time))))
                :ca-file ca-file :force-binary t
                :content-type "application/json" :content content
                :additional-headers (list (cons "Authorization" authorization)))
             (cl-cancel:check-cancellation context)
             (let ((request-id (cdr (assoc :x-request-id headers))))
               (unless (= status 200)
                 (error 'http-error :status status :request-id request-id :body body))
               (values (com.inuoe.jzon:parse body) request-id))))
      (fill authorization #\Space))))
