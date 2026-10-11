(load (merge-pathnames "client.lisp" *load-truename*))

(defpackage #:lispm-debugger-client
  (:use #:cl)
  (:export #:fresh-name #:make-session #:session-name #:call-with-session
           #:request #:send-request #:receive-reply #:call-rpc
           #:request-error #:request-error-reason))
(in-package #:lispm-debugger-client)

(define-condition request-error (error)
  ((reason :initarg :reason :reader request-error-reason))
  (:report (lambda (condition stream)
             (format stream "Debugger request failed: ~S."
                     (request-error-reason condition)))))

(defun fresh-name ()
  (with-open-file (stream "/dev/urandom" :element-type '(unsigned-byte 8))
    (format nil "~(~{~2,'0X~}~)"
            (loop repeat 32 collect (read-byte stream)))))

(defstruct (session (:constructor %make-session (name attempted-p)))
  (name nil :read-only t)
  attempted-p)

(defun make-session (&key resume)
  (if resume
      (progn
        (unless (and (stringp resume) (= (length resume) 64)
                     (every (lambda (char) (find char "0123456789abcdef")) resume))
          (error "Invalid debugger session name."))
        (%make-session (copy-seq resume) t))
      (%make-session (fresh-name) nil)))

(defvar *stream*)
(defvar *session*)
(defvar *request-id*)

(defun send-rpc (form &optional (thread t))
  (let ((id (incf *request-id*)))
    (lispm-swank-client:send-packet
     *stream* (format nil "(:emacs-rex ~A ~S ~S ~D)" form "CL-USER" thread id))
    id))

(defun receive-rpc (id)
  (loop for message = (lispm-swank-client:receive-message *stream*)
        do (case (first message)
             (:ping
              (lispm-swank-client:send-packet
               *stream* (format nil "(:emacs-pong ~D ~S)"
                                (second message) (third message))))
             (:write-string (write-string (second message)))
             ((:new-package :new-features :indentation-update :debug-activate))
             (:return
              (unless (and (eql (third message) id)
                           (eq (first (second message)) :ok))
                (error "Unexpected SWANK reply: ~S." message))
              (return (second (second message))))
             (:debug
              (send-rpc "(swank:throw-to-toplevel)" (second message))
              (error "SWANK entered its debugger: ~S." message))
             (otherwise (error "Unexpected SWANK event: ~S." message)))))

(defun call-rpc (form)
  (receive-rpc (send-rpc form)))

(defun checked-reply (reply)
  (unless (and (listp reply) (= (length reply) 2))
    (error "Invalid debugger reply: ~S." reply))
  (ecase (first reply)
    (:ok (second reply))
    (:error (error 'request-error :reason (second reply)))))

(defun attach-session (session)
  (let ((operation (if (session-attempted-p session) "resume-session" "open-session")))
    (setf (session-attempted-p session) t)
    (loop
      (let ((reply (call-rpc (format nil "(swank/mezzano-debugger:~A ~S)"
                                    operation (session-name session)))))
        (if (equal reply '(:error :session-attached))
            (sleep 0.01)
            (return (checked-reply reply)))))))

(defun call-with-session (session function &key (host "127.0.0.1") (port 4005) (seconds 60))
  (lispm-swank-client:call-with-connection
   host port seconds
   (lambda (stream)
     (let ((*stream* stream)
           (*session* session)
           (*request-id* 0))
       (call-rpc "(swank:swank-require :swank-mezzano-debugger)")
       (attach-session session)
       (funcall function)))))

(defun send-request (operation &rest arguments)
  (send-rpc
   (format nil "(swank/mezzano-debugger:request ~S ~S~{ '~S~})"
           (session-name *session*) operation arguments)))

(defun receive-reply (id)
  (checked-reply (receive-rpc id)))

(defun request (operation &rest arguments)
  (receive-reply (apply #'send-request operation arguments)))
