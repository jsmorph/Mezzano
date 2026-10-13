(defpackage #:lispm-complete-test
  (:use #:cl)
  (:export #:run #:run-live #:run-live-limits #:tool-definition #:answer-format))
(in-package #:lispm-complete-test)

(defun object (&rest pairs)
  (apply #'lispm-openai::completion-object pairs))

(defun expect-error (function)
  (assert (handler-case (progn (funcall function) nil) (error () t))))

(defun tool-definition ()
  (object "type" "function" "name" "lispm_test_value"
          "description" "Request the test value."
          "strict" t
          "parameters" (object "type" "object"
                               "properties" (object "value" (object "type" "integer" "enum" #(7)))
                               "required" #("value") "additionalProperties" nil)))

(defun answer-format ()
  (object "type" "json_schema" "name" "answer" "strict" t
          "schema" (object "type" "object"
                           "properties" (object "answer" (object "type" "integer"))
                           "required" #("answer") "additionalProperties" nil)))

(defun test-requests ()
  (let* ((messages '((:content "λ" :role :developer) (:role :user :content "雪")))
         (before (copy-tree messages))
         (tool (tool-definition))
         (format (answer-format))
         (request (lispm-openai::completion-request
                   messages :model "example-model" :instructions "Instructions"
                   :max-output-tokens 500 :temperature 0 :top-p 1/2
                   :reasoning-effort :low :verbosity :high :text-format format
                   :tools (list tool) :tool-choice "lispm_test_value"))
         (encoded (com.inuoe.jzon:parse (com.inuoe.jzon:stringify request))))
    (assert (equal messages before))
    (assert (equal (gethash "model" encoded) "example-model"))
    (assert (equal (gethash "instructions" encoded) "Instructions"))
    (assert (= (gethash "max_output_tokens" encoded) 500))
    (assert (= (gethash "temperature" encoded) 0))
    (assert (= (gethash "top_p" encoded) 0.5d0))
    (assert (equal (gethash "role" (aref (gethash "input" encoded) 0)) "developer"))
    (assert (equal (gethash "content" (aref (gethash "input" encoded) 1)) "雪"))
    (assert (equal (gethash "effort" (gethash "reasoning" encoded)) "low"))
    (assert (equal (gethash "verbosity" (gethash "text" encoded)) "high"))
    (assert (equalp (gethash "format" (gethash "text" encoded)) format))
    (assert (equalp (aref (gethash "tools" encoded) 0) tool))
    (assert (equalp (gethash "tool_choice" encoded)
                    (object "type" "function" "name" "lispm_test_value")))
    (dolist (key '("parallel_tool_calls" "store"))
      (multiple-value-bind (value present) (gethash key encoded)
        (assert present) (assert (null value)))))
  (let ((request (lispm-openai::completion-request "Prompt")))
    (assert (equal (gethash "input" request) "Prompt"))
    (assert (equal (gethash "model" request) "gpt-4.1-nano"))
    (dolist (key '("temperature" "top_p" "reasoning" "text" "instructions"
                   "max_output_tokens" "tools"))
      (assert (not (nth-value 1 (gethash key request))))))
  (dolist (choice '(:auto :none :required))
    (let ((request (lispm-openai::completion-request
                    "Prompt" :tool-choice choice :parallel-tool-calls t)))
      (assert (equal (gethash "tool_choice" request) (string-downcase choice)))
      (assert (eq (gethash "parallel_tool_calls" request) t))))
  (let* ((input (vector (object "type" "function_call_output" "call_id" "call_x"
                               "output" "Result")))
         (encoded (com.inuoe.jzon:stringify input))
         (request (lispm-openai::completion-request input)))
    (assert (equal (com.inuoe.jzon:stringify (gethash "input" request)) encoded))
    (assert (equal (com.inuoe.jzon:stringify input) encoded)))
  (dolist (input (list nil 42 '("not a message") '(a . b) #("not an object")
                      '((:role :user :role :assistant)) '((:role :unknown :content "x"))
                      '((:role :user :content 42)) '((:role :user :content "x" :extra t))))
    (expect-error (lambda () (lispm-openai::completion-request input))))
  (let ((cycle (list :role :user)))
    (setf (cddr cycle) cycle)
    (expect-error (lambda () (lispm-openai::completion-request cycle))))
  (dolist (arguments '((:model "") (:model 1) (:instructions 1)
                       (:max-output-tokens 15) (:max-output-tokens 16.5)
                       (:temperature -1) (:temperature 3) (:temperature "0")
                       (:top-p -1) (:top-p 2) (:verbosity :unknown)
                       (:reasoning-effort :unknown) (:text-format "json")
                       (:tools "tool") (:tools #(1)) (:parallel-tool-calls :yes)
                       (:tool-choice "") (:tool-choice nil)))
    (expect-error (lambda () (apply #'lispm-openai::completion-request "Prompt" arguments))))
  (dolist (value (list float-features:double-float-positive-infinity
                      float-features:double-float-nan))
    (expect-error (lambda () (lispm-openai::completion-request "Prompt" :temperature value)))
    (expect-error (lambda () (cl-user::complete "Prompt" :timeout value))))
  (dolist (timeout '(0 -1 "60"))
    (expect-error (lambda () (cl-user::complete "Prompt" :timeout timeout))))
  (format t "PASS COMPLETE request encoding and argument validation.~%"))

(defun message (text)
  (object "type" "message" "content" (vector (object "type" "output_text" "text" text))))

(defun call-item (id arguments)
  (object "type" "function_call" "call_id" id "name" "lispm_test_value" "arguments" arguments))

(defun test-responses ()
  (let* ((reasoning (object "type" "reasoning" "encrypted_content" "opaque"))
         (response (object "status" "completed" "output"
                           (vector reasoning (message "λ") (call-item "call_1" "{\"value\":7}")
                                   (message "雪") (call-item "call_2" "{}"))))
         (original (com.inuoe.jzon:stringify response)))
    (multiple-value-bind (text returned id calls)
        (lispm-openai::completion-values response "request_1")
      (assert (equal text "λ雪"))
      (assert (eq returned response))
      (assert (equal id "request_1"))
      (assert (equal (mapcar (lambda (call) (getf call :call-id)) calls) '("call_1" "call_2")))
      (assert (equal (getf (first calls) :name) "lispm_test_value"))
      (assert (= (gethash "value" (getf (first calls) :arguments)) 7))
      (assert (= (hash-table-count (getf (second calls) :arguments)) 0)))
    (assert (equal original (com.inuoe.jzon:stringify response))))
  (let ((response (object "status" "completed" "output" (vector (call-item "c" "{}")))))
    (let ((values (multiple-value-list (lispm-openai::completion-values response nil))))
      (assert (= (length values) 4))
      (assert (null (first values)))
      (assert (eq (second values) response))
      (assert (null (third values)))
      (assert (= (length (fourth values)) 1))))
  (multiple-value-bind (text response id calls)
      (lispm-openai::completion-values (object "status" "completed" "output" (vector (message ""))) nil)
    (declare (ignore response id))
    (assert (equal text "")) (assert (null calls)))
  (dolist (fixture
           (list (cons :incomplete (object "status" "incomplete" "output" (vector (message "Partial"))))
                 (cons :status (object "status" "failed"))
                 (cons :missing-output (object "status" "completed" "output" #()))
                 (cons :malformed-response 42)
                 (cons :malformed-response (object "status" "completed" "output" "array"))
                 (cons :refusal (object "status" "completed" "output"
                                       (vector (object "type" "message" "content"
                                                       (vector (object "type" "refusal" "refusal" "No"))))))
                 (cons :malformed-tool-call (object "status" "completed" "output"
                                                   (vector (call-item "same" "{}") (call-item "same" "{}"))))))
    (let* ((response (cdr fixture))
           (condition (handler-case (progn (lispm-openai::completion-values response "request_bad") nil)
                        (lispm-openai:completion-error (condition) condition))))
      (assert condition)
      (assert (eq (lispm-openai:completion-error-reason condition) (car fixture)))
      (assert (eq (lispm-openai:completion-error-response condition) response))
      (assert (equal (lispm-openai:completion-error-request-id condition) "request_bad"))))
  (dolist (arguments '("{" "" "[]" "null" "1" "{} {}"))
    (let* ((response (object "status" "completed" "output" (vector (call-item "c" arguments))))
           (condition (handler-case (progn (lispm-openai::completion-values response nil) nil)
                        (lispm-openai:completion-error (condition) condition))))
      (assert condition)
      (assert (eq (lispm-openai:completion-error-reason condition) :malformed-tool-call))))
  (let* ((response (object "status" "completed" "output" (vector (call-item "c" "{"))))
         (condition (handler-case (lispm-openai::completion-values response nil)
                      (lispm-openai:completion-error (condition) condition))))
    (assert (typep (lispm-openai:completion-error-cause condition) 'error)))
  (dolist (item (list (call-item "" "{}")
                      (object "type" "function_call" "call_id" "c" "name" 4 "arguments" "{}")
                      (object "type" "function_call" "call_id" "c" "name" "f" "arguments" #())))
    (let ((condition (handler-case
                         (lispm-openai::completion-values
                          (object "status" "completed" "output" (vector item)) nil)
                       (lispm-openai:completion-error (condition) condition))))
      (assert (eq (lispm-openai:completion-error-reason condition) :malformed-tool-call))))
  (format t "PASS COMPLETE text, tool calls, response identity, and error conditions.~%"))

(defun run ()
  (test-requests)
  (test-responses)
  t)

(defun check-live-result (text response request-id calls)
  (assert (hash-table-p response))
  (assert (equal (gethash "status" response) "completed"))
  (assert (and (stringp request-id) (plusp (length request-id))))
  (assert (or (stringp text) calls))
  (format t "PASS live COMPLETE: ~A, ~S, ~D function calls.~%"
          (gethash "model" response) text (length calls)))

(defun run-live ()
  (multiple-value-call #'check-live-result
    (cl-user::complete "Reply with exactly: Default completion works." :max-output-tokens 64))
  (multiple-value-call #'check-live-result
    (cl-user::complete '((:role :user :content "Return the integer 42 in the answer field."))
                       :model "gpt-4.1-nano-2025-04-14" :instructions "Follow the supplied schema."
                       :temperature 0 :max-output-tokens 128 :text-format (answer-format)))
  (let* ((input (vector (object "role" "user" "content" "Request the test value using the provided function.")))
         (tools (vector (tool-definition))))
    (multiple-value-bind (text response request-id calls)
        (cl-user::complete input :tools tools :tool-choice "lispm_test_value" :max-output-tokens 128)
      (check-live-result text response request-id calls)
      (assert (= (length calls) 1))
      (let ((call (first calls)))
        (assert (equal (getf call :name) "lispm_test_value"))
        (assert (= (gethash "value" (getf call :arguments)) 7))
        (multiple-value-bind (answer final final-id final-calls)
            (cl-user::complete
             (concatenate 'vector input (gethash "output" response)
                          (vector (object "type" "function_call_output"
                                          "call_id" (getf call :call-id)
                                          "output" "{\"answer\":8}")))
             :tools tools :tool-choice :none :top-p 1 :max-output-tokens 128
             :instructions "Return the answer supplied by the function."
             :text-format (answer-format))
          (check-live-result answer final final-id final-calls)
          (assert (null final-calls))
          (assert (= (gethash "answer" (com.inuoe.jzon:parse answer)) 8))))))
  (let ((condition
          (handler-case (cl-user::complete "Test" :model "lispm-nonexistent-model-for-test")
            (lispm-openai:http-error (condition) condition))))
    (assert (typep condition 'lispm-openai:http-error))
    (assert (member (lispm-openai:http-error-status condition) '(400 404)))
    (assert (stringp (lispm-openai:http-error-request-id condition)))
    (assert (hash-table-p (com.inuoe.jzon:parse (lispm-openai:http-error-body condition))))
    (format t "PASS live COMPLETE preserves HTTP ~D and its JSON error body.~%"
            (lispm-openai:http-error-status condition)))
  t)

(defun run-live-limits ()
  (let ((condition
          (handler-case
              (cl-user::complete "Output the integers from 1 through 1000, separated by spaces."
                        :max-output-tokens 16 :temperature 0)
            (lispm-openai:completion-error (condition) condition))))
    (assert (typep condition 'lispm-openai:completion-error))
    (assert (eq (lispm-openai:completion-error-reason condition) :incomplete))
    (assert (equal (gethash "reason" (gethash "incomplete_details"
                                               (lispm-openai:completion-error-response condition)))
                   "max_output_tokens"))
    (assert (stringp (lispm-openai:completion-error-request-id condition)))
    (format t "PASS live output-token limit preserves incomplete response and request ID.~%"))
  (let ((condition
          (handler-case (cl-user::complete "Test." :timeout 1/1000000000)
            ((or cl-cancel:deadline-exceeded usocket:timeout-error) (condition) condition))))
    (assert (typep condition '(or cl-cancel:deadline-exceeded usocket:timeout-error)))
    (format t "PASS COMPLETE timeout reaches the HTTP cancellation context.~%"))
  t)
