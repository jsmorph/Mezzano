(in-package #:lispm-openai)

(define-condition completion-error (error)
  ((reason :initarg :reason :reader completion-error-reason)
   (response :initarg :response :reader completion-error-response)
   (request-id :initarg :request-id :reader completion-error-request-id)
   (cause :initarg :cause :initform nil :reader completion-error-cause))
  (:report (lambda (condition stream)
             (format stream "OpenAI completion failed: ~A; request ID ~A."
                     (completion-error-reason condition)
                     (or (completion-error-request-id condition) "unavailable")))))

(defun completion-object (&rest pairs)
  (let ((object (make-hash-table :test 'equal)))
    (loop for (key value) on pairs by #'cddr
          do (setf (gethash key object) value))
    object))

(defun completion-object-vector (objects)
  (unless (or (and (vectorp objects) (not (stringp objects)))
              (alexandria:proper-list-p objects))
    (error "Expected a list or vector of JSON objects."))
  (unless (every #'hash-table-p objects)
    (error "Expected JSON objects in the input sequence."))
  (coerce objects 'vector))

(defun completion-input (input)
  (cond
    ((stringp input) input)
    ((vectorp input) (completion-object-vector input))
    ((and input (alexandria:proper-list-p input))
     (map 'vector
          (lambda (message)
            (unless (and (alexandria:proper-list-p message)
                         (= (length message) 4)
                         (or (and (eq (first message) :role)
                                  (eq (third message) :content))
                             (and (eq (first message) :content)
                                  (eq (third message) :role)))
                         (member (getf message :role)
                                 '(:system :developer :user :assistant))
                         (stringp (getf message :content)))
              (error "Expected a message with :ROLE and string :CONTENT."))
            (completion-object "role" (string-downcase (getf message :role))
                               "content" (getf message :content)))
          input))
    (t (error "Expected a prompt string, message list, or vector of JSON objects."))))

(defun completion-finite-real-p (value)
  (and (realp value)
       (or (not (floatp value))
           (and (not (float-features:float-nan-p value))
                (not (float-features:float-infinity-p value))))))

(defun completion-sampling-value (value maximum)
  (unless (and (completion-finite-real-p value) (<= 0 value maximum))
    (error "Expected a finite sampling value between 0 and ~D." maximum))
  (if (typep value 'ratio) (float value 1d0) value))

(defun completion-request (input &key (model "gpt-4.1-nano") instructions
                                  max-output-tokens temperature top-p
                                  reasoning-effort verbosity text-format tools
                                  (tool-choice :auto) (parallel-tool-calls nil))
  (unless (and (stringp model) (plusp (length model)))
    (error "Expected a nonempty model name."))
  (check-type instructions (or null string))
  (check-type max-output-tokens (or null (integer 16)))
  (check-type reasoning-effort (member nil :none :minimal :low :medium :high :xhigh :max))
  (check-type verbosity (member nil :low :medium :high))
  (check-type text-format (or null hash-table))
  (check-type parallel-tool-calls boolean)
  (unless (or (member tool-choice '(:auto :none :required))
              (and (stringp tool-choice) (plusp (length tool-choice))))
    (error "Expected :AUTO, :NONE, :REQUIRED, or a function name for :TOOL-CHOICE."))
  (let ((request (completion-object "model" model "input" (completion-input input)
                                    "store" nil)))
    (when instructions (setf (gethash "instructions" request) instructions))
    (when max-output-tokens (setf (gethash "max_output_tokens" request) max-output-tokens))
    (when temperature
      (setf (gethash "temperature" request) (completion-sampling-value temperature 2)))
    (when top-p (setf (gethash "top_p" request) (completion-sampling-value top-p 1)))
    (when reasoning-effort
      (setf (gethash "reasoning" request)
            (completion-object "effort" (string-downcase reasoning-effort))))
    (when (or text-format verbosity)
      (let ((text (completion-object)))
        (when text-format (setf (gethash "format" text) text-format))
        (when verbosity (setf (gethash "verbosity" text) (string-downcase verbosity)))
        (setf (gethash "text" request) text)))
    (when tools (setf (gethash "tools" request) (completion-object-vector tools)))
    (setf (gethash "tool_choice" request)
          (if (stringp tool-choice)
              (completion-object "type" "function" "name" tool-choice)
              (string-downcase tool-choice))
          (gethash "parallel_tool_calls" request) parallel-tool-calls)
    request))

(defun completion-values (response request-id)
  (labels ((fail (reason &optional cause)
             (error 'completion-error :reason reason :response response
                    :request-id request-id :cause cause))
           (check-object (object)
             (unless (hash-table-p object) (fail :malformed-response)))
           (check-array (array)
             (unless (and (vectorp array) (not (stringp array)))
               (fail :malformed-response)))
           (nonempty-string-p (value)
             (and (stringp value) (plusp (length value)))))
    (check-object response)
    (unless (equal (gethash "status" response) "completed")
      (fail (if (equal (gethash "status" response) "incomplete") :incomplete :status)))
    (let ((output (gethash "output" response))
          (found-text nil)
          (calls nil)
          (call-ids (make-hash-table :test 'equal)))
      (check-array output)
      (let ((text
              (with-output-to-string (stream)
                (loop for item across output do
                  (check-object item)
                  (let ((type (gethash "type" item)))
                    (unless (stringp type) (fail :malformed-response))
                    (cond
                      ((equal type "message")
                       (let ((content (gethash "content" item)))
                         (check-array content)
                         (loop for part across content do
                           (check-object part)
                           (let ((part-type (gethash "type" part)))
                             (cond
                               ((equal part-type "refusal") (fail :refusal))
                               ((equal part-type "output_text")
                                (unless (stringp (gethash "text" part))
                                  (fail :malformed-response))
                                (setf found-text t)
                                (write-string (gethash "text" part) stream))
                               ((not (stringp part-type)) (fail :malformed-response)))))))
                      ((equal type "function_call")
                       (let ((id (gethash "call_id" item))
                             (name (gethash "name" item))
                             (arguments (gethash "arguments" item)))
                         (unless (and (nonempty-string-p id) (nonempty-string-p name)
                                      (stringp arguments) (not (gethash id call-ids)))
                           (fail :malformed-tool-call))
                         (let ((parsed
                                 (handler-case (com.inuoe.jzon:parse arguments)
                                   (error (condition) (fail :malformed-tool-call condition)))))
                           (unless (hash-table-p parsed) (fail :malformed-tool-call))
                           (setf (gethash id call-ids) t)
                           (push (list :call-id id :name name :arguments parsed) calls))))))))))
        (unless (or found-text calls) (fail :missing-output))
        (values (and found-text text) response request-id (nreverse calls))))))

(in-package #:cl-user)

(defun complete (input &key (model "gpt-4.1-nano") instructions max-output-tokens
                        temperature top-p reasoning-effort verbosity text-format
                        tools (tool-choice :auto) (parallel-tool-calls nil)
                        (timeout 60))
  "Send one OpenAI request.  Return text, response, request ID, and function calls."
  (unless (and (lispm-openai::completion-finite-real-p timeout) (plusp timeout))
    (error "Expected a finite positive :TIMEOUT in seconds."))
  (let ((request (lispm-openai::completion-request
                  input :model model :instructions instructions :max-output-tokens max-output-tokens
                  :temperature temperature :top-p top-p :reasoning-effort reasoning-effort
                  :verbosity verbosity :text-format text-format :tools tools
                  :tool-choice tool-choice :parallel-tool-calls parallel-tool-calls))
        (key nil))
    (unwind-protect
         (progn
           (setf key (with-open-file
                         (stream (merge-pathnames "openai-api.key" (user-homedir-pathname)))
                       (read-line stream)))
           (multiple-value-bind (response request-id)
               (lispm-openai:create-response
                key request :timeout timeout
                :ca-file #+mezzano "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT"
                         #-mezzano nil)
             (lispm-openai::completion-values response request-id)))
      (when key (fill key #\Space)))))

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
