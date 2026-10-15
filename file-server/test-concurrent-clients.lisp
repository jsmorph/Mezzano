(defpackage :file-server-concurrency-test
  (:use :cl)
  (:export :run))

(in-package :file-server-concurrency-test)

#-sbcl (error "These host file-server tests require SBCL.")

(defvar *ready*)
(defvar *listener*)
(defvar *accepted*)
(defvar *workers*)
(defvar *files*)
(defvar *capture-lock*)
(defvar *worker-start* nil)
(defvar *saved-accept*)
(defvar *saved-make-worker*)
(defvar *install-close-failures* nil)

(defclass failing-close-stream (sb-gray:fundamental-output-stream)
  ((condition :initarg :condition :reader failure)
   (calls :initform 0 :accessor close-calls)))

(defmethod close ((stream failing-close-stream) &key abort)
  (declare (ignore abort))
  (incf (close-calls stream))
  (error (failure stream)))

(defun capture-accept (socket)
  (unless *listener*
    (setf *listener* socket)
    (sb-thread:signal-semaphore *ready*))
  (let ((client (funcall *saved-accept* socket)))
    (when client
      (assert (not (sb-bsd-sockets:non-blocking-mode client)))
      (sb-thread:with-mutex (*capture-lock*) (push client *accepted*)))
    client))

(defun capture-worker (function)
  (let ((thread (if *worker-start*
                    (funcall *worker-start* function)
                    (funcall *saved-make-worker* function))))
    (sb-thread:with-mutex (*capture-lock*) (push thread *workers*))
    thread))

(defun observe-files (arguments)
  (declare (ignore arguments))
  (when *install-close-failures*
    (setf (aref file-server::*file-table* 2) (first *install-close-failures*)
          (aref file-server::*file-table* 3) (second *install-close-failures*)))
  (sb-thread:with-mutex (*capture-lock*)
    (push (copy-seq file-server::*file-table*) *files*))
  (format file-server::*client* ":ok~%"))

(defun connect-client ()
  (let ((socket (make-instance 'sb-bsd-sockets:inet-socket :type :stream :protocol :tcp)))
    (handler-case
        (progn
          (sb-bsd-sockets:socket-connect socket #(127 0 0 1)
                                         (nth-value 1 (sb-bsd-sockets:socket-name *listener*)))
          (sb-bsd-sockets:socket-make-stream socket :input t :output t
                                            :element-type :default :external-format :utf-8
                                            :timeout 2))
      (error (condition)
        (sb-bsd-sockets:socket-close socket :abort t)
        (error condition)))))

(defun send-request (stream form)
  (with-standard-io-syntax (format stream "~S~%" form))
  (finish-output stream))

(defun request (stream form)
  (send-request stream form)
  (read-preserving-whitespace stream))

(defun read-file-data (stream fid count)
  (let* ((length (request stream (list :read fid 0 count)))
         (bytes (make-array length :element-type '(unsigned-byte 8))))
    (assert (= length count))
    (assert (char= (read-char stream) #\Newline))
    (assert (= (read-sequence bytes stream) count))
    (map 'string #'code-char bytes)))

(defun assert-clean ()
  (assert (not (sb-bsd-sockets:socket-open-p *listener*)))
  (dolist (socket *accepted*)
    (assert (not (sb-bsd-sockets:socket-open-p socket))))
  (dolist (thread *workers*) (assert (not (sb-thread:thread-alive-p thread))))
  (dolist (table *files*)
    (loop for stream across table
          when (and stream (not (typep stream 'failing-close-stream)))
            do (assert (not (open-stream-p stream))))))

(defun stop-server (server)
  (when (sb-thread:thread-alive-p server) (file-server:kill-server server))
  (sb-thread:join-thread server :timeout 2))

(defun call-with-test-server (function &key public (idle-timeout file-server::*idle-timeout*))
  (setf *ready* (sb-thread:make-semaphore)
        *listener* nil *accepted* nil *workers* nil *files* nil)
  (let ((server
          (if public
              (file-server:spawn-file-server :port 0)
              (sb-thread:make-thread
               (lambda ()
                 (let ((file-server::*idle-timeout* idle-timeout))
                   (handler-case
                       (catch 'file-server::finished (file-server::run-file-server :port 0))
                     (error (condition) condition))))
               :name "File server test owner"))))
    (unwind-protect
         (progn
           (assert (sb-thread:wait-on-semaphore *ready* :timeout 2))
           (funcall function server))
      (stop-server server)
      (assert-clean))))

(defun test-concurrent-clients (a-path b-path)
  (call-with-test-server
   (lambda (server)
     (with-open-stream (a (connect-client))
       (assert (eq (request a '(:ping)) :pong))
       (assert (zerop (request a (list :open a-path :direction :input))))
       (assert (eq (request a '(:test-observe-files)) :ok))
       (with-open-stream (b (connect-client))
         (assert (eq (request b (list :probe b-path)) :ok))
         (assert (zerop (request b (list :open b-path :direction :input))))
         (assert (eq (request b '(:test-observe-files)) :ok))
         (assert (string= (read-file-data b 0 5) "bravo"))
         (assert (string= (read-file-data a 0 5) "alpha"))
         (assert (eq (first (request b '(:size 7))) :error))
         (assert (eq (request b '(:ping)) :pong))
         (assert (eq (request b '(:quit)) :bye)))
       (assert (eq (request a '(:ping)) :pong))
       (with-open-stream (b (connect-client))
         (assert (eq (request b '(:ping)) :pong))
         (assert (null (stop-server server)))
         (assert (eq (read a nil :eof) :eof))
         (assert (eq (read b nil :eof) :eof)))))
   :public t))

(defun test-idle-expiration (path)
  (call-with-test-server
   (lambda (server)
     (with-open-stream (client (connect-client))
       (assert (zerop (request client (list :open path :direction :input))))
       (assert (eq (request client '(:test-observe-files)) :ok))
       (assert (eq (read client nil :eof) :eof)))
     (with-open-stream (client (connect-client))
       (assert (eq (request client '(:ping)) :pong)))
     (assert (null (stop-server server))))
   :idle-timeout 0.05))

(defun test-creation-failure ()
  (let ((condition (make-condition 'simple-error :format-control "Worker creation failed")))
    (setf *worker-start* (lambda (function) (declare (ignore function)) (error condition)))
    (unwind-protect
         (call-with-test-server
          (lambda (server)
            (with-open-stream (client (connect-client))
              (assert (eq (read client nil :eof) :eof)))
            (assert (eq (sb-thread:join-thread server :timeout 2) condition))
            (assert (null *workers*))))
      (setf *worker-start* nil))))

(defun test-shutdown-during-worker-start ()
  (let ((entered (sb-thread:make-semaphore))
        (resume (sb-thread:make-semaphore)))
    (setf *worker-start*
          (lambda (function)
            (sb-thread:signal-semaphore entered)
            (sb-thread:wait-on-semaphore resume)
            (funcall *saved-make-worker* function)))
    (unwind-protect
         (call-with-test-server
          (lambda (server)
            (with-open-stream (client (connect-client))
              (unwind-protect
                   (progn
                     (assert (sb-thread:wait-on-semaphore entered :timeout 2))
                     (file-server:kill-server server))
                (sb-thread:signal-semaphore resume))
              (assert (null (sb-thread:join-thread server :timeout 2)))
              (assert (eq (read client nil :eof) :eof)))))
      (setf *worker-start* nil))))

(defun reset-client (stream)
  (sb-alien:with-alien ((linger (sb-alien:array sb-alien:int 2)))
    (setf (sb-alien:deref linger 0) 1 (sb-alien:deref linger 1) 0)
    (assert (zerop (sb-bsd-sockets-internal::setsockopt
                    (sb-sys:fd-stream-fd stream)
                    sb-bsd-sockets-internal::sol-socket
                    sb-bsd-sockets-internal::so-linger
                    (sb-alien:alien-sap (sb-alien:addr linger))
                    (sb-alien:alien-size (sb-alien:array sb-alien:int 2) :bytes)))))
  (close stream :abort t))

(defun test-reset (path)
  (call-with-test-server
   (lambda (server)
     (with-open-stream (client (connect-client))
       (assert (zerop (request client (list :open path :direction :input))))
       (assert (eq (request client '(:test-observe-files)) :ok))
       (reset-client client)
       (assert (null (sb-thread:join-thread (first *workers*) :timeout 2))))
     (with-open-stream (client (connect-client))
       (assert (eq (request client '(:ping)) :pong)))
     (assert (null (stop-server server))))))

(defun test-connected-stream-error ()
  (let ((handler (fdefinition 'file-server::handle-client))
        (condition nil))
    (unwind-protect
         (progn
           (setf (fdefinition 'file-server::handle-client)
                 (lambda (stream)
                   (setf condition (make-condition 'sb-int:simple-stream-error
                                                   :stream stream :format-control "Test read failure"))
                   (error condition)))
           (call-with-test-server
            (lambda (server)
              (with-open-stream (client (connect-client))
                (assert (eq (read client nil :eof) :eof)))
              (assert (eq (sb-thread:join-thread server :timeout 2) condition)))))
      (setf (fdefinition 'file-server::handle-client) handler))))

(defun test-worker-error ()
  (call-with-test-server
   (lambda (server)
     (with-open-stream (client (connect-client))
       (write-line ")" client)
       (finish-output client)
       (assert (eq (read client nil :eof) :eof)))
     (assert (typep (sb-thread:join-thread server :timeout 2) 'reader-error)))))

(defun test-cleanup-errors (path)
  (let* ((one (make-condition 'simple-error :format-control "First close failed"))
         (two (make-condition 'simple-error :format-control "Second close failed"))
         (first (make-instance 'failing-close-stream :condition one))
         (second (make-instance 'failing-close-stream :condition two)))
    (setf *install-close-failures* (list first second))
    (unwind-protect
         (call-with-test-server
          (lambda (server)
            (with-open-stream (client (connect-client))
              (assert (zerop (request client (list :open path :direction :input))))
              (assert (eq (request client '(:test-observe-files)) :ok))
              (assert (eq (request client '(:quit)) :bye)))
            (let ((condition (sb-thread:join-thread server :timeout 2)))
              (assert (typep condition 'file-server::file-server-errors))
              (assert (equal (file-server::file-server-error-conditions condition) (list one two))))
            (assert (= (close-calls first) (close-calls second) 1))))
      (setf *install-close-failures* nil))))

(defun run ()
  (let* ((a (format nil "/tmp/mezzano-file-server-~D-a" (sb-posix:getpid)))
         (b (format nil "/tmp/mezzano-file-server-~D-b" (sb-posix:getpid)))
         (old-accept (fdefinition 'file-server::accept))
         (old-make-worker (fdefinition 'file-server::make-client-worker)))
    (setf *saved-accept* old-accept
          *saved-make-worker* old-make-worker
          *capture-lock* (sb-thread:make-mutex))
    (unwind-protect
         (progn
           (with-open-file (stream a :direction :output :if-exists :error) (write-string "alpha" stream))
           (with-open-file (stream b :direction :output :if-exists :error) (write-string "bravo" stream))
           (setf (fdefinition 'file-server::accept) #'capture-accept
                 (fdefinition 'file-server::make-client-worker) #'capture-worker
                 (gethash :test-observe-files file-server::*commands*) #'observe-files)
           (test-concurrent-clients a b)
           (format t "PASS concurrent clients, independent handles, and idle shutdown~%")
           (test-idle-expiration a)
           (format t "PASS configured idle expiration and file cleanup~%")
           (test-creation-failure)
           (format t "PASS worker creation failure and socket cleanup~%")
           (test-shutdown-during-worker-start)
           (format t "PASS shutdown during accepted-client ownership transfer~%")
           (test-reset a)
           (format t "PASS disconnected client stream, real TCP reset, and file cleanup~%")
           (test-connected-stream-error)
           (format t "PASS connected client stream preserves original error~%")
           (test-worker-error)
           (format t "PASS unexpected worker error propagation~%")
           (test-cleanup-errors a)
           (format t "PASS all file cleanup and original cleanup conditions~%"))
      (setf (fdefinition 'file-server::accept) old-accept
            (fdefinition 'file-server::make-client-worker) old-make-worker)
      (remhash :test-observe-files file-server::*commands*)
      (when (probe-file a) (delete-file a))
      (when (probe-file b) (delete-file b))))
  :concurrent-file-server-tests-passed)
