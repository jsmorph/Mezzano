(defpackage :mezzano.http-server
  (:use :cl)
  (:local-nicknames (:tcp :mezzano.network.tcp)
                    (:net :mezzano.network)
                    (:sup :mezzano.supervisor)
                    (:sync :mezzano.sync)
                    (:gray :mezzano.gray))
  (:export #:start-server #:stop-server
           #:request-method #:request-target #:request-headers #:request-body))

(in-package :mezzano.http-server)

(defconstant +line-limit+ 8192)
(defconstant +header-limit+ 32768)
(defconstant +header-count-limit+ 100)
(defconstant +body-limit+ 1048576)
(defconstant +worker-limit+ 64)

(defstruct request method target headers body)
(defstruct connection stream thread method response-started-p)
(defstruct (server (:constructor %make-server))
  listener handler timeout thread
  (lock (sup:make-mutex 'http-server))
  (shutdown (sup:make-event :name 'http-server-shutdown))
  (connections nil)
  stopping-p)

(define-condition request-error (error)
  ((status :initarg :status :reader request-error-status))
  (:report (lambda (condition stream)
             (format stream "HTTP request rejected: ~D."
                     (request-error-status condition)))))

(defun reject (status)
  (error 'request-error :status status))

(defun token-character-p (character)
  (or (and (char<= #\a character) (char<= character #\z))
      (and (char<= #\A character) (char<= character #\Z))
      (and (char<= #\0 character) (char<= character #\9))
      (find character "!#$%&'*+-.^_`|~" :test #'char=)))

(defun field-value-p (string)
  (every (lambda (character)
           (let ((code (char-code character)))
             (or (= code 9) (<= 32 code 126) (<= 128 code 255))))
         string))

(defun next-byte (stream deadline &optional empty-eof-p)
  (loop
    (let* ((remaining (net::deadline-remaining deadline))
           (byte (gray:stream-read-byte-no-hang stream)))
      (cond ((eq byte :eof)
             (if empty-eof-p (return nil) (reject 400)))
            (byte (return byte))
            ((null (sync:wait-for-objects-with-timeout remaining stream))
             (error 'net:network-timeout))))))

(defun read-http-line (stream deadline budget status &optional empty-eof-p)
  (let ((line (make-array 80 :element-type 'character
                            :adjustable t :fill-pointer 0)))
    (loop
      (let ((byte (next-byte stream deadline
                             (and empty-eof-p (zerop (length line))))))
        (when (null byte) (return nil))
        (when (minusp (decf (car budget))) (reject 431))
        (cond ((= byte 13)
               (unless (= (next-byte stream deadline) 10) (reject 400))
               (when (minusp (decf (car budget))) (reject 431))
               (return line))
              ((= byte 10) (reject 400))
              (t
               (when (>= (length line) +line-limit+) (reject status))
               (vector-push-extend (code-char byte) line)))))))

(defun parse-request-line (line)
  (let* ((first (position #\Space line))
         (second (and first (position #\Space line :start (1+ first)))))
    (unless (and first second (plusp first) (> second (1+ first))
                 (< second (1- (length line)))
                 (not (position #\Space line :start (1+ second))))
      (reject 400))
    (let ((method (subseq line 0 first))
          (target (subseq line (1+ first) second))
          (version (subseq line (1+ second))))
      (unless (and (every #'token-character-p method)
                   (every (lambda (character) (<= 33 (char-code character) 126))
                          target))
        (reject 400))
      (unless (member version '("HTTP/1.0" "HTTP/1.1") :test #'string=)
        (reject 505))
      (values method target version))))

(defun parse-header (line)
  (let ((colon (position #\: line)))
    (unless (and colon (plusp colon)
                 (every #'token-character-p (subseq line 0 colon))
                 (field-value-p (subseq line (1+ colon))))
      (reject 400))
    (cons (string-downcase (subseq line 0 colon))
          (string-trim '(#\Space #\Tab) (subseq line (1+ colon))))))

(defun header-values (name headers)
  (loop for (key . value) in headers
        when (string= key name) collect value))

(defun content-length (headers)
  (when (header-values "transfer-encoding" headers) (reject 400))
  (let ((lengths (header-values "content-length" headers)))
    (when (rest lengths) (reject 400))
    (if lengths
        (let ((value 0)
              (text (first lengths)))
          (when (zerop (length text)) (reject 400))
          (loop for character across text
                for digit = (digit-char-p character 10)
                do (unless digit (reject 400))
                   (setf value (+ (* value 10) digit))
                   (when (> value +body-limit+) (reject 413)))
          value)
        0)))

(defun latin-1-octets (string)
  (let ((bytes (make-array (length string) :element-type '(unsigned-byte 8))))
    (dotimes (index (length string) bytes)
      (setf (aref bytes index) (char-code (char string index))))))

(defun write-octets (stream bytes deadline)
  (loop for start from 0 below (length bytes) by 16384
        do (net::deadline-remaining deadline)
           (write-sequence bytes stream :start start
                                        :end (min (+ start 16384) (length bytes))))
  (net::deadline-remaining deadline))

(defun read-request (stream deadline &optional connection)
  (let* ((budget (list +header-limit+))
         (line (read-http-line stream deadline budget 414 t)))
    (unless line (return-from read-request nil))
    (multiple-value-bind (method target version) (parse-request-line line)
      (when connection (setf (connection-method connection) method))
      (let ((headers nil))
        (loop for line = (read-http-line stream deadline budget 431)
              until (zerop (length line))
              do (when (>= (length headers) +header-count-limit+) (reject 431))
                 (push (parse-header line) headers))
        (setf headers (nreverse headers))
        (when (string= version "HTTP/1.1")
          (let ((hosts (header-values "host" headers)))
            (unless (and (= (length hosts) 1) (plusp (length (first hosts))))
              (reject 400))))
        (let* ((length (content-length headers))
               (expect (header-values "expect" headers))
               (body (make-array length :element-type '(unsigned-byte 8))))
          (when expect
            (unless (and (= (length expect) 1)
                         (string-equal (first expect) "100-continue")
                         (string= version "HTTP/1.1"))
              (reject 417))
            (write-octets stream
                          (latin-1-octets (format nil "HTTP/1.1 100 Continue~C~C~C~C"
                                                #\Return #\Linefeed #\Return #\Linefeed))
                          deadline))
          (dotimes (index length)
            (setf (aref body index) (next-byte stream deadline)))
          (make-request :method method :target target :headers headers :body body))))))

(defun reason-phrase (status)
  (case status
    (200 "OK") (201 "Created") (202 "Accepted") (204 "No Content")
    (301 "Moved Permanently") (302 "Found") (304 "Not Modified")
    (400 "Bad Request") (403 "Forbidden") (404 "Not Found")
    (405 "Method Not Allowed") (408 "Request Timeout") (409 "Conflict")
    (413 "Content Too Large") (414 "URI Too Long")
    (417 "Expectation Failed") (431 "Request Header Fields Too Large")
    (500 "Internal Server Error") (503 "Service Unavailable")
    (505 "HTTP Version Not Supported")
    (t "Response")))

(defun response-head (status headers body)
  (check-type status (integer 200 599))
  (check-type body (vector (unsigned-byte 8)))
  (when (and (member status '(204 304)) (plusp (length body)))
    (error "HTTP status ~D cannot include a response body." status))
  (dolist (header headers)
    (unless (and (consp header) (stringp (car header))
                 (plusp (length (car header)))
                 (every #'token-character-p (car header))
                 (stringp (cdr header)) (field-value-p (cdr header))
                 (not (member (car header)
                              '("content-length" "connection" "transfer-encoding")
                              :test #'string-equal)))
      (error "Invalid HTTP response header.")))
  (latin-1-octets
   (with-output-to-string (stream)
     (flet ((line (text)
              (write-string text stream)
              (write-char #\Return stream)
              (write-char #\Linefeed stream)))
       (line (format nil "HTTP/1.1 ~D ~A" status (reason-phrase status)))
       (dolist (header headers)
         (line (format nil "~A: ~A" (car header) (cdr header))))
       (unless (= status 204)
         (line (format nil "Content-Length: ~D" (length body))))
       (line "Connection: close")
       (line "")))))

(defun send-response (connection timeout method status headers body)
  (let* ((stream (connection-stream connection))
         (head (response-head status headers body))
         (deadline (net::deadline-after timeout)))
    (setf (connection-response-started-p connection) t
          (tcp:tcp-connection-timeout (tcp:tcp-stream-connection stream)) timeout)
    (write-octets stream head deadline)
    (unless (or (string= method "HEAD") (member status '(204 304)))
      (write-octets stream body deadline))))

(defun error-response (connection timeout status &optional uncertain-p)
  (send-response
   connection timeout (or (connection-method connection) "")
   status
   '(("Content-Type" . "application/json; charset=utf-8")
     ("Cache-Control" . "no-store")
     ("X-Content-Type-Options" . "nosniff")
     ("Referrer-Policy" . "no-referrer")
     ("Content-Security-Policy" .
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"))
   (latin-1-octets
    (format nil "{\"error\":\"~A\",\"uncertain\":~A}"
            (reason-phrase status) (if uncertain-p "true" "false")))))

(defun try-error-response (connection timeout status &optional uncertain-p)
  (unless (connection-response-started-p connection)
    (handler-case (error-response connection timeout status uncertain-p)
      (net:network-error () nil))))

(defun receive-request (server connection)
  (handler-case
      (read-request (connection-stream connection)
                    (net::deadline-after (server-timeout server))
                    connection)
    (request-error (condition)
      (try-error-response connection (server-timeout server)
                          (request-error-status condition))
      nil)
    (net:network-timeout ()
      (try-error-response connection (server-timeout server) 408)
      nil)
    (net:network-error () nil)))

(defun serve-connection (server connection)
  (handler-bind
      ((error (lambda (condition)
                (try-error-response connection (server-timeout server) 500 t)
                (error condition))))
    (let ((request (receive-request server connection)))
      (when request
        (multiple-value-bind (status headers body)
            (funcall (server-handler server) request)
          (handler-case
              (send-response connection (server-timeout server)
                             (request-method request) status headers body)
            (net:network-error () nil)))))))

(defun close-connection-stream (connection &key abort)
  (handler-case (close (connection-stream connection) :abort abort)
    (net:network-error ()
      (unless abort
        (close (connection-stream connection) :abort t)))))

(defun remove-connection (server connection)
  (sup:with-mutex ((server-lock server))
    (setf (server-connections server)
          (delete connection (server-connections server)))))

(defun connection-worker (server connection)
  (mezzano.debug:call-with-debugger-service
   (lambda ()
     (with-simple-restart (abort "End this HTTP request.")
       (unwind-protect
            (serve-connection server connection)
         (unwind-protect
              (close-connection-stream connection)
           (remove-connection server connection)))))))

(defun accept-connection (server stream)
  (let* ((connection (make-connection :stream stream))
         (action
           (sup:with-mutex ((server-lock server))
             (cond ((server-stopping-p server) :shutdown)
                   ((>= (length (server-connections server)) +worker-limit+) :full)
                   (t (push connection (server-connections server)) :accept)))))
    (case action
      (:shutdown (close-connection-stream connection :abort t))
      (:full
       (unwind-protect
            (try-error-response connection (server-timeout server) 503)
         (close-connection-stream connection)))
      (:accept
       (let ((started nil))
         (unwind-protect
              (progn
                (setf (connection-thread connection)
                      (sup:make-thread (lambda () (connection-worker server connection))
                                       :name "HTTP request"))
                (setf started t))
           (unless started
             (unwind-protect
                  (close-connection-stream connection :abort t)
               (remove-connection server connection)))))))))

(defun accept-worker (server)
  (mezzano.debug:call-with-debugger-service
   (lambda ()
     (with-simple-restart (abort "Stop accepting HTTP requests.")
       (unwind-protect
            (loop
              (sync:wait-for-objects (server-shutdown server) (server-listener server))
              (when (sup:event-state (server-shutdown server)) (return))
              (let ((stream nil))
                (unwind-protect
                     (progn
                       (sup:without-footholds
                         (setf stream (tcp:tcp-accept
                                       (server-listener server) :wait-p nil
                                       :element-type '(unsigned-byte 8))))
                       (when stream (accept-connection server stream))
                       (setf stream nil))
                  (when stream
                    (close-connection-stream (make-connection :stream stream) :abort t)))))
         (tcp:close-tcp-listener (server-listener server)))))))

(defun start-server (&key (address "0.0.0.0") (port 80) handler (timeout 15))
  (check-type port (integer 0 65535))
  (check-type handler function)
  (check-type timeout (real (0)))
  (let* ((listener (tcp:tcp-listen address port :backlog +worker-limit+))
         (server (%make-server :listener listener :handler handler :timeout timeout)))
    (handler-case
        (progn
          (setf (server-thread server)
                (sup:make-thread (lambda () (accept-worker server))
                                 :name (format nil "HTTP accept port ~D"
                                               (tcp:tcp-listener-local-port listener))))
          server)
      (error (condition)
        (tcp:close-tcp-listener listener)
        (error condition)))))

(defun stop-server (server)
  (let ((self (sup:current-thread)))
    (when (sup:with-mutex ((server-lock server))
            (or (eq self (server-thread server))
                (find self (server-connections server) :key #'connection-thread)))
      (error "HTTP server cannot stop from its own thread."))
    (sup:with-mutex ((server-lock server))
      (setf (server-stopping-p server) t
            (sup:event-state (server-shutdown server)) t))
    (sup:thread-join (server-thread server))
    (let ((connections
            (sup:with-mutex ((server-lock server))
              (copy-list (server-connections server)))))
      (dolist (connection connections)
        (close-connection-stream connection :abort t)
        (when (and (connection-thread connection)
                   (not (nth-value 1 (sup:thread-join (connection-thread connection) nil))))
          (sup:terminate-thread (connection-thread connection))))
      (dolist (connection connections)
        (when (connection-thread connection)
          (sup:thread-join (connection-thread connection))))))
  (values))
