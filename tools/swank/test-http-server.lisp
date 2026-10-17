(defpackage :lispm-http-server-test
  (:use :cl)
  (:local-nicknames (:http :mezzano.http-server)
                    (:tcp :mezzano.network.tcp)
                    (:net :mezzano.network)
                    (:sup :mezzano.supervisor)
                    (:gray :mezzano.gray))
  (:export #:run-tests))

(in-package :lispm-http-server-test)

(defclass memory-stream (gray:fundamental-binary-input-stream
                         gray:fundamental-binary-output-stream)
  ((input :initarg :input :reader input)
   (position :initform 0 :accessor input-position)
   (output :initform (make-array 0 :element-type '(unsigned-byte 8)
                                  :adjustable t :fill-pointer 0)
           :reader output)))

(defmethod gray:stream-element-type ((stream memory-stream))
  '(unsigned-byte 8))

(defmethod gray:stream-read-byte-no-hang ((stream memory-stream))
  (if (= (input-position stream) (length (input stream)))
      :eof
      (prog1 (aref (input stream) (input-position stream))
        (incf (input-position stream)))))

(defmethod gray:stream-write-byte ((stream memory-stream) byte)
  (vector-push-extend byte (output stream))
  byte)

(defun bytes (string)
  (http::latin-1-octets string))

(defun wire (&rest lines)
  (with-output-to-string (stream)
    (dolist (line lines)
      (write-string line stream)
      (write-char #\Return stream)
      (write-char #\Linefeed stream))))

(defun parse (text &optional (body #()))
  (let ((stream (make-instance 'memory-stream
                              :input (concatenate '(vector (unsigned-byte 8))
                                                  (bytes text) body))))
    (values (http::read-request stream nil)
            (output stream))))

(defun expect-status (status text)
  (assert
   (handler-case (progn (parse text) nil)
     (http::request-error (condition)
       (= status (http::request-error-status condition))))))

(defun parser-tests ()
  (multiple-value-bind (request interim)
      (parse (wire "POST /api?x=1 HTTP/1.1" "Host: example"
                   "X-Test: one" "X-Test: two" "Content-Length: 3"
                   "Expect: 100-continue" "")
             (make-array 3 :element-type '(unsigned-byte 8) :initial-contents '(0 128 255)))
    (assert (string= (http:request-method request) "POST"))
    (assert (string= (http:request-target request) "/api?x=1"))
    (assert (equal (http::header-values "x-test" (http:request-headers request))
                   '("one" "two")))
    (assert (equalp (http:request-body request) #(0 128 255)))
    (assert (equalp interim (bytes (wire "HTTP/1.1 100 Continue" "")))))
  (assert (null (parse "")))
  (assert (string= (http:request-method (parse (wire "GET / HTTP/1.0" ""))) "GET"))
  (dolist (entry
           (list
            (cons 400 (wire "GET  / HTTP/1.1" "Host: a" ""))
            (cons 400 (format nil "GET / HTTP/1.1~%Host: a~%~%"))
            (cons 400 (wire "GET / HTTP/1.1" ""))
            (cons 400 (wire "GET / HTTP/1.1" "Host: a" "Host: b" ""))
            (cons 400 (wire "GET / HTTP/1.1" "Host : a" ""))
            (cons 400 (wire "GET / HTTP/1.1" "Host: a" " folded" ""))
            (cons 400 (wire "POST / HTTP/1.1" "Host: a" "Transfer-Encoding: chunked" ""))
            (cons 400 (wire "POST / HTTP/1.1" "Host: a" "Transfer-Encoding: chunked"
                            "Content-Length: 0" ""))
            (cons 400 (wire "POST / HTTP/1.1" "Host: a" "Content-Length: 0"
                            "Content-Length: 0" ""))
            (cons 400 (wire "POST / HTTP/1.1" "Host: a" "Content-Length: +1" ""))
            (cons 400 (wire "POST / HTTP/1.1" "Host: a" "Content-Length: 1" ""))
            (cons 413 (wire "POST / HTTP/1.1" "Host: a" "Content-Length: 1048577" ""))
            (cons 417 (wire "POST / HTTP/1.1" "Host: a" "Expect: other" ""))
            (cons 505 (wire "GET / HTTP/2.0" "Host: a" ""))))
    (expect-status (car entry) (cdr entry)))
  (expect-status 414
                 (wire (concatenate 'string "GET /" (make-string 8192 :initial-element #\a)
                                    " HTTP/1.1")
                       "Host: a" ""))
  (expect-status 431
                 (apply #'wire "GET / HTTP/1.1" "Host: a"
                        (append (loop repeat 100 collect "X-Test: a") (list ""))))
  (expect-status 431
                 (apply #'wire "GET / HTTP/1.1" "Host: a"
                        (append (loop repeat 5 collect
                                      (concatenate 'string "X-Test: "
                                                   (make-string 7000 :initial-element #\a)))
                                (list ""))))
  (let* ((body (bytes "abc"))
         (head (http::response-head 200 '(("Content-Type" . "application/octet-stream")) body)))
    (assert (search (bytes (wire "Content-Length: 3")) head))
    (assert (search (bytes (wire "Connection: close" "")) head))
    (assert (handler-case
                (progn (http::response-head 200
                                           (list (cons "X-Test" (wire "bad" "injected")))
                                           body)
                       nil)
              (error () t)))
    (assert (handler-case
                (progn (http::response-head 200 '(("Content-Length" . "3")) body) nil)
              (error () t))))
  (format t "PASS HTTP parsing, framing rejection, bounds, and response headers.~%"))

(defun await (predicate)
  (let ((deadline (net::deadline-after 5)))
    (loop
      (let ((value (funcall predicate)))
        (when value (return value)))
      (net::deadline-remaining deadline)
      (sleep 0.01))))

(defun connect (server)
  (tcp:tcp-stream-connect
   "127.0.0.1" (tcp:tcp-listener-local-port (http::server-listener server))
   :element-type '(unsigned-byte 8) :connect-timeout 3 :timeout 3))

(defun response (stream &optional head-p)
  (let* ((deadline (net::deadline-after 5))
         (budget (list 32768))
         (line (http::read-http-line stream deadline budget 431))
         (status (parse-integer line :start 9 :end 12))
         (headers nil))
    (loop for line = (http::read-http-line stream deadline budget 431)
          until (zerop (length line))
          do (push (http::parse-header line) headers))
    (let* ((length (if head-p 0 (http::content-length headers)))
           (body (make-array length :element-type '(unsigned-byte 8))))
      (dotimes (index length)
        (setf (aref body index) (http::next-byte stream deadline)))
      (values status headers body))))

(defun request (server text &optional head-p body)
  (let ((stream (connect server)))
    (unwind-protect
         (progn
           (write-sequence (bytes text) stream)
           (when body (write-sequence body stream))
           (multiple-value-prog1 (response stream head-p)
             (assert (null (http::next-byte stream (net::deadline-after 3) t)))))
      (close stream :abort t))))

(defun loopback-tests ()
  (let* ((body (make-array 3 :element-type '(unsigned-byte 8)
                            :initial-contents '(0 128 255)))
         (server (http:start-server
                  :address "127.0.0.1" :port 0 :timeout 3
                  :handler (lambda (request)
                             (values 200 '(("Content-Type" . "application/octet-stream"))
                                     (if (string= (http:request-method request) "POST")
                                         (http:request-body request) body))))))
    (unwind-protect
         (progn
           (multiple-value-bind (status headers result)
               (request server (wire "GET /font HTTP/1.1" "Host: test" ""))
             (assert (= status 200))
             (assert (equalp result body))
             (assert (string= (cdr (assoc "connection" headers :test #'string=)) "close")))
           (multiple-value-bind (status headers result)
               (request server (wire "HEAD /font HTTP/1.1" "Host: test" "") t)
             (assert (= status 200))
             (assert (= (http::content-length headers) 3))
             (assert (zerop (length result))))
           (multiple-value-bind (status headers result)
               (request server (wire "POST /api HTTP/1.1" "Host: test"
                                     "Content-Length: 3" "") nil body)
             (declare (ignore headers))
             (assert (= status 200))
             (assert (equalp result body)))
           (assert (= (request server (wire "GET / HTTP/1.1" "")) 400))
           (let ((blocked (connect server)))
             (unwind-protect
                  (progn
                    (write-sequence (bytes "GET / HTTP/1.1") blocked)
                    (await (lambda () (http::server-connections server)))
                    (assert (= (request server (wire "GET / HTTP/1.1" "Host: test" "")) 200))
                    (http:stop-server server)
                    (assert (null (http::server-connections server))))
               (close blocked :abort t))))
      (http:stop-server server)))
  (format t "PASS HTTP loopback octets, HEAD, independent workers, and shutdown.~%"))

(defun timeout-test ()
  (let* ((server (http:start-server
                  :address "127.0.0.1" :port 0 :timeout 0.2
                  :handler (lambda (request)
                             (declare (ignore request))
                             (error "Partial request reached HTTP handler."))))
         (start (get-internal-run-time))
         (stream nil))
    (unwind-protect
         (progn
           (setf stream (connect server))
           (dolist (byte '(71 69 84))
             (write-byte byte stream)
             (sleep 0.05))
           (assert (= (response stream) 408))
           (assert (>= (- (get-internal-run-time) start)
                       (* 0.15 internal-time-units-per-second))))
      (when stream (close stream :abort t))
      (http:stop-server server)))
  (format t "PASS HTTP absolute receive deadline during partial input.~%"))

(defvar *unexpected-cleanup-count* 0)

(defun raise-handler-error (condition)
  (unwind-protect
       (error condition)
    (incf *unexpected-cleanup-count*)))

(defun unexpected-error-test ()
  (setf *unexpected-cleanup-count* 0)
  (let* ((condition (make-condition 'simple-error :format-control "HTTP handler test error"))
         (server (http:start-server
                  :address "127.0.0.1" :port 0
                  :handler (lambda (request)
                             (declare (ignore request))
                             (raise-handler-error condition))))
         (client nil)
         (handle nil)
         (controller (mezzano.debug:make-debugger-controller)))
    (unwind-protect
         (progn
           (setf client (connect server))
           (write-sequence (bytes (wire "GET / HTTP/1.1" "Host: test" "")) client)
           (multiple-value-bind (status headers body) (response client)
             (declare (ignore headers))
             (assert (= status 500))
             (assert (search (bytes "\"uncertain\":true") body)))
           (setf handle
                 (await
                  (lambda ()
                    (find-if
                     (lambda (handle)
                       (let ((stop (mezzano.debug::check-service-handle handle)))
                         (eq (mezzano.debug::service-stop-condition stop) condition)))
                     (mezzano.debug:debugger-stops)))))
           (assert (zerop *unexpected-cleanup-count*))
           (assert (find #'raise-handler-error
                         (mezzano.debug::service-stop-frames
                          (mezzano.debug::check-service-handle handle))
                         :key #'mezzano.debug::frame-function :test #'eq))
           (let* ((lease (mezzano.debug:attach-debugger-stop handle controller))
                  (id (getf (mezzano.debug:debugger-stop-information handle) :next-command-id)))
             (mezzano.debug:submit-debugger-command lease id :restarts)
             (let* ((result (await
                             (lambda ()
                               (let ((result (mezzano.debug:debugger-command-result handle id)))
                                 (when (eq (getf result :state) :returned) result)))))
                    (abort (find "ABORT" (getf result :result)
                                 :key (lambda (entry) (getf entry :name)) :test #'string=)))
               (assert abort)
               (mezzano.debug:submit-debugger-command
                lease (1+ id) :invoke-restart (getf abort :index))
               (await (lambda ()
                        (eq (getf (mezzano.debug:debugger-command-result handle (1+ id)) :state)
                            :unwound)))
               (await (lambda () (null (http::server-connections server))))
               (assert (= *unexpected-cleanup-count* 1))
               (mezzano.debug:release-debugger-stop lease)))
           (format t "PASS HTTP unexpected500 retains original condition and ABORT cleanup.~%"))
      (when client (close client :abort t))
      (http:stop-server server)
      (mezzano.debug:close-debugger-controller controller))))

(defun run-tests ()
  (parser-tests)
  (loopback-tests)
  (timeout-test)
  (unexpected-error-test)
  t)
