(in-package #:lispm-https-test)

(defun redact-key (message key)
  (if (zerop (length key))
      message
      (with-output-to-string (stream)
        (loop with start = 0
              for found = (search key message :start2 start)
              do (write-string message stream :start start :end found)
              while found
              do (write-string "[redacted]" stream)
                 (setf start (+ found (length key)))))))

(let ((key (read-line *standard-input*)))
  (unwind-protect
       (handler-case
           (run-openai-test key)
         (error (condition)
           (format *error-output* "~&OpenAI test failed (~A): ~A~%"
                   (type-of condition)
                   (redact-key (princ-to-string condition) key))
           (uiop:quit 1)))
    (fill key #\Space)))
