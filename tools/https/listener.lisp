(in-package #:cl-user)

(defun complete (string &optional (model "gpt-4.1-nano"))
  "Return OpenAI output text for STRING using MODEL."
  (check-type string string)
  (check-type model string)
  (let ((request (make-hash-table :test 'equal))
        (key (with-open-file
                 (stream (merge-pathnames "openai-api.key" (user-homedir-pathname)))
               (read-line stream))))
    (unwind-protect
         (progn
           (setf (gethash "model" request) model
                 (gethash "input" request) string
                 (gethash "store" request) nil)
           (let ((response
                   (lispm-openai:create-response
                    key request
                    :ca-file #+mezzano "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT"
                             #-mezzano nil)))
             (unless (equal (gethash "status" response) "completed")
               (error "OpenAI response status is ~S." (gethash "status" response)))
             (let* ((found nil)
                    (text
                     (with-output-to-string (stream)
                       (loop for item across (gethash "output" response)
                             when (equal (gethash "type" item) "message")
                               do (loop for part across (gethash "content" item)
                                        when (equal (gethash "type" part) "output_text")
                                          do (setf found t)
                                             (write-string (gethash "text" part) stream))))))
               (unless found
                 (error "OpenAI returned no output text."))
               text)))
      (fill key #\Space))))

(defun curl (url)
  "GET URL.  Return its body, integer HTTP status, and header alist."
  (check-type url string)
  (let ((drakma:*header-stream* nil))
    (cl-cancel:with-timeout-context (context 60)
      (cl-cancel:check-cancellation context)
      (multiple-value-bind (body status headers)
          (drakma:http-request
           url :method :get :verify :required :redirect 5 :decode-content t
           :connection-timeout
           (max 0 (min 15 (- (cl-cancel:deadline context) (cl-cancel:get-current-time))))
           :ca-file #+mezzano "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT"
                    #-mezzano nil)
        (cl-cancel:check-cancellation context)
        (values body status headers)))))
