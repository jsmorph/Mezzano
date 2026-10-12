(defpackage #:lispm-http-cleanup-test
  (:use #:cl)
  (:export #:run))
(in-package #:lispm-http-cleanup-test)

(define-condition close-failure (error) ())

(defclass response-stream (flexi-streams:flexi-io-stream)
  ((fail-close :initarg :fail-close :initform nil :reader fail-close)
   (closed :initform nil :accessor closed)
   (aborted :initform nil :accessor aborted)))

(defmethod close :around ((stream response-stream) &key abort)
  (setf (closed stream) t
        (aborted stream) abort)
  (call-next-method)
  (when (fail-close stream)
    (error 'close-failure)))

(defun make-response-stream (response &key fail-close)
  (change-class
   (flexi-streams:make-flexi-stream
    (chunga:make-chunked-stream
     (make-two-way-stream
      (flexi-streams:make-in-memory-input-stream
       (babel:string-to-octets response :encoding :latin-1))
      (flexi-streams:make-in-memory-output-stream)))
    :external-format :latin-1)
   'response-stream :fail-close fail-close))

(defun run ()
  (let ((stream (make-response-stream
                 (format nil "HTTP/1.1 200 OK~C~CContent-Length: 2~C~C~C~COK"
                         #\Return #\Newline #\Return #\Newline #\Return #\Newline)
                 :fail-close t)))
    (let ((reported
            (handler-case
                (progn (drakma:http-request "http://fixture.invalid/" :stream stream) nil)
              (close-failure () t))))
      (assert (closed stream))
      (assert reported () "HTTP request discarded the close failure."))
    (assert (not (aborted stream))))
  (let ((stream (make-response-stream "")))
    (assert
     (handler-case
         (progn (drakma:http-request "http://fixture.invalid/" :stream stream) nil)
       (drakma:drakma-error () t)))
    (assert (closed stream))
    (assert (aborted stream)))
  (format t "PASS HTTP close-error propagation and abort after incomplete response.~%")
  t)
