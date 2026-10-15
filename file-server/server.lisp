;;;; File server for the remote file system

(in-package #:file-server)

(defparameter *default-file-server-port* 2599)
(defparameter *idle-timeout* 60)

(defvar *commands* (make-hash-table))
(defvar *file-table*)
(defvar *client*)

(define-condition error-with-class (simple-error)
  ((error-class :initarg :class :reader error-class)))

(defmacro defcommand (name lambda-list &body body)
  (let ((args (gensym)))
    `(setf (gethash ',name *commands*)
           #-mezzano(alexandria:named-lambda ,name (,args)
                      (destructuring-bind ,lambda-list (rest ,args)
                        ,@body))
           #+mezzano(lambda (,args)
                      (declare (sys.int::lambda-name ,name))
                      (destructuring-bind ,lambda-list (rest ,args)
                        ,@body)))))

(defun parse-path (path)
  ;; Convert /x/ to x:/ on Windows.
  #+win32
  (when (and (>= (length path) 3)
             (eql (char path 0) #\/)
             (eql (char path 2) #\/))
    (setf path (copy-seq path))
    (setf (char path 0) (char path 1))
    (setf (char path 1) #\:)
    (format t "Converted to Windows path ~S~%" path))
  path)

(defun unparse-namestring (namestring)
  ;; Convert x:/ back to /x/ on Windows.
  #+win32
  (when (and (>= (length namestring) 3)
             (eql (char namestring 1) #\:)
             (eql (char namestring 2) #\/))
    (setf namestring (copy-seq namestring))
    (setf (char namestring 1) (char namestring 0))
    (setf (char namestring 0) #\/)
    (format t "Converted from Windows namestring ~S~%" namestring))
  namestring)

(defcommand :open (path &rest keys &key &allow-other-keys)
  (let ((fid (loop
                for i from 0
                for entry across *file-table*
                do (when (eql entry nil)
                     (return i)))))
    (format t "Keys ~:S~%" keys)
    (unless fid
      (error 'error-with-class
             :format-control "Too many open files."
             :class :too-many-open-files))
    (when (getf keys :element-type)
      (error 'error-with-class
             :format-control ":ELEMENT-TYPE is not permitted."
             :class :bad-argument))
    (setf (aref *file-table* fid)
          (apply 'open (parse-path path)
                 :element-type '(unsigned-byte 8)
                 keys))
    (format *client* "~D~%" fid)))

(defun get-stream (fid)
  (when (or (not (<= 0 fid (1- (length *file-table*))))
            (null (aref *file-table* fid)))
    (error 'error-with-class
           :format-control "Bad file ID."
           :class :bad-file-id))
  (aref *file-table* fid))

(defcommand :close (fid)
  (let ((stream (get-stream fid)))
    (close stream)
    (setf (aref *file-table* fid) nil)
    (format *client* ":ok~%")))

(defcommand :read (fid offset count)
  (assert (< count 1000000)) ; 1MB limit.
  (let ((stream (get-stream fid))
        (seq (make-array count :element-type '(unsigned-byte 8))))
    (file-position stream offset)
    (let ((count (read-sequence seq stream)))
      (format *client* "~D~%" count)
      (write-sequence seq *client* :end count)
      (finish-output *client*))))

(defcommand :write (fid offset count)
  (assert (< count 1000000)) ; 1MB limit.
  (let ((stream (get-stream fid))
        (seq (make-array count :element-type '(unsigned-byte 8))))
    (read-line *client*)
    (read-sequence seq *client*)
    (file-position stream offset)
    (write-sequence seq stream)
    (format *client* ":ok~%")))

(defcommand :size (fid)
  (let ((stream (get-stream fid)))
    (file-position stream :end)
    (format *client* "~D~%" (file-position stream))))

(defcommand :ping ()
  (format *client* ":pong~%"))

(defcommand :directory (path)
  (format *client* "~S~%"
          (list* :ok
                 (mapcar (lambda (path)
                           (unparse-namestring
                            (namestring path)))
                         (directory (parse-path path))))))

(defcommand :probe (path)
  (if (probe-file (parse-path path))
      (format *client* ":ok~%")
      (format *client* "(:not-found \"File not found\")~%")))

(defcommand :create (path)
  (if (open (parse-path path) :direction :probe :if-exists nil :if-does-not-exist :create)
      (format *client* ":ok~%")
      (format *client* "(:error \"???\")~%")))

#-mezzano
(defcommand :backup (path)
  (when (open (parse-path path) :direction :probe)
    (cl-fad:copy-file (parse-path path) (format nil "~A~~" (parse-path path))
                      :overwrite t))
  (format *client* ":ok~%"))

(defcommand :restore (path)
  (let ((backup (format nil "~A~~" (parse-path path))))
    (when (open backup :direction :probe)
      (rename-file backup (parse-path path)))
    (format *client* ":ok~%")))

(defcommand :create-directory (path)
  (multiple-value-bind (_ created)
      (ensure-directories-exist (parse-path path))
    (declare (ignore _))
    (if created
        (format *client* ":ok~%")
        (format *client* ":exists~%"))))

(defcommand :rename-file (source dest)
  (rename-file (parse-path source) (parse-path dest))
  (format *client* ":ok~%"))

(defcommand :file-write-date (path)
  (format *client* "~D~%" (file-write-date (parse-path path))))

(defcommand :delete (path)
  (if (or (pathname-name (parse-path path)) (pathname-type (parse-path path)))
      (delete-file (parse-path path))
      #+sbcl (sb-posix:rmdir (parse-path path))
      #-sbcl (error "delete of directories not implemented"))
  (format *client* ":ok~%"))

(define-condition file-server-errors (error)
  ((conditions :initarg :conditions :reader file-server-error-conditions))
  (:report (lambda (condition stream)
             (format stream "File server errors:~{~%  ~A~}"
                     (file-server-error-conditions condition)))))

(defun signal-file-server-errors (conditions)
  (when conditions
    (if (null (cdr conditions))
        (error (car conditions))
        (error 'file-server-errors :conditions (nreverse conditions)))))

(defun handle-client (*client*)
  (let ((*file-table* (make-array 8 :initial-element nil))
        (failures nil))
    (unwind-protect
         (handler-case
              (loop
                (let ((form (read-preserving-whitespace *client*)))
                  (format t "Command: ~S~%" form)
                  (cond
                    ((or (not (consp form))
                         (not (keywordp (first form))))
                     (format *client* "(:invalid-command \"Invalid command\")"))
                    ((eql (first form) :quit)
                     (format *client* ":bye")
                     (finish-output *client*)
                     (return))
                    (t (let ((fn (gethash (first form) *commands*)))
                         (if fn
                             (handler-case (funcall fn form)
                               (error-with-class (c)
                                 (format *client* "(:error ~S ~S)"
                                         (format nil "~A" c)
                                         (error-class c)))
                               (error (c)
                                 (format *client* "(:error ~S)"
                                         (format nil "~A" c))))
                             (format *client* "(:invalid-command \"Invalid command\")"))))))
                (finish-output *client*))
           (end-of-file ())
           #+sbcl (sb-sys:io-timeout ())
           (error (condition) (push condition failures)))
      (loop for file across *file-table*
            when file do (handler-case (close file)
                           (error (condition) (push condition failures))))
      (signal-file-server-errors failures))))

#-sbcl
(defun run-file-server (&key (port *default-file-server-port*))
  (iolib:with-open-socket (server :connect :passive
                                  :address-family :internet
                                  :type :stream
                                  :external-format :ascii)
    (iolib:bind-address server iolib:+ipv4-unspecified+
                        :port port
                        :reuse-addr t)
    (iolib:listen-on server :backlog 5)
    (loop
       (with-simple-restart (continue "Close connection.")
         (iolib:with-accept-connection (client server :wait t)
           (multiple-value-bind (who rport)
               (iolib:remote-name client)
             (format t "Got a connection from ~A:~A!~%" who rport))
           (handler-case (handle-client client)
             (end-of-file ())))))
    (finish-output)
    t))

#+sbcl
(progn
(defun accept (socket)
  (sb-sys:with-interrupts
    (sb-sys:wait-until-fd-usable (sb-bsd-sockets:socket-file-descriptor socket)
                                :input nil nil))
  (handler-case (sb-bsd-sockets:socket-accept socket)
    (sb-bsd-sockets:interrupted-error () nil)))

(defun make-client-worker (function)
  (sb-thread:make-thread function :name "File server client"))

(defun run-file-server (&key (port *default-file-server-port*))
  (let ((socket nil)
        (clients nil)
        (failures nil)
        (stopping nil)
        (idle-timeout *idle-timeout*)
        (owner sb-thread:*current-thread*)
        (failed (gensym "CLIENT-FAILED"))
        (socket-lock (sb-thread:make-mutex :name "File server sockets")))
    (labels ((serve-client (client)
               (let ((errors nil))
                 (unwind-protect
                      (handler-case
                          (let ((stream
                                  (sb-thread:with-mutex (socket-lock)
                                    (unless stopping
                                      (sb-bsd-sockets:socket-make-stream
                                       client :input t :output t :auto-close t
                                       :external-format :utf-8 :element-type :default
                                       :timeout idle-timeout)))))
                            (when stream
                              (handler-case (handle-client stream)
                                (stream-error (condition)
                                  (if (eq (stream-error-stream condition) stream)
                                      (handler-case
                                          (progn
                                            (sb-bsd-sockets:socket-peername client)
                                            (push condition errors))
                                        (sb-bsd-sockets:not-connected-error ())
                                        (error (probe-condition)
                                          (push condition errors)
                                          (push probe-condition errors)))
                                      (push condition errors))))))
                        (error (condition) (push condition errors)))
                   (handler-case
                       (sb-thread:with-mutex (socket-lock)
                         (sb-bsd-sockets:socket-close client :abort t))
                     (error (condition) (push condition errors))))
                 (when errors
                   (sb-thread:interrupt-thread
                    owner (lambda () (unless stopping (throw failed nil)))))
                 errors))
             (join-client (entry)
               (handler-case
                   (setf failures (nconc (sb-thread:join-thread (cdr entry)) failures))
                 (error (condition) (push condition failures))))
             (reap-clients ()
               (setf clients
                     (delete-if (lambda (entry)
                                  (unless (sb-thread:thread-alive-p (cdr entry))
                                    (join-client entry)
                                    t))
                                clients))
               (when failures (throw failed nil))))
      (sb-sys:without-interrupts
        (unwind-protect
             (handler-case
                 (catch failed
                   (setf socket (make-instance 'sb-bsd-sockets:inet-socket
                                               :type :stream :protocol :tcp))
                   (setf (sb-bsd-sockets:sockopt-reuse-address socket) t)
                   (sb-bsd-sockets:socket-bind
                    socket (sb-bsd-sockets:make-inet-address "127.0.0.1") port)
                   (sb-bsd-sockets:socket-listen socket 5)
                   (setf (sb-bsd-sockets:non-blocking-mode socket) t)
                   (loop
                     (reap-clients)
                     (let ((client (sb-sys:allow-with-interrupts (accept socket))))
                       (when client
                         (let ((entry (cons client nil)))
                           (push entry clients)
                           (setf (cdr entry) (make-client-worker (lambda () (serve-client client)))))))
                     (sb-sys:with-local-interrupts (values))))
               (error (condition) (push condition failures)))
          (sb-thread:with-mutex (socket-lock)
            (setf stopping t))
          (when socket
            (handler-case (sb-bsd-sockets:socket-close socket)
              (error (condition) (push condition failures))))
          (sb-thread:with-mutex (socket-lock)
            (dolist (entry clients)
              (when (sb-bsd-sockets:socket-open-p (car entry))
                (handler-case (sb-bsd-sockets:socket-shutdown (car entry) :direction :io)
                  (sb-bsd-sockets:not-connected-error ())
                  (error (condition) (push condition failures))))))
          (dolist (entry clients)
            (when (cdr entry) (join-client entry))
            (handler-case (sb-bsd-sockets:socket-close (car entry) :abort t)
              (error (condition) (push condition failures))))
          (signal-file-server-errors failures))))))
)

(defun spawn-file-server (&rest args)
  (bordeaux-threads:make-thread (lambda () (catch 'finished (apply 'run-file-server args)))))

(defun kill-server (thread)
  (bordeaux-threads:interrupt-thread thread (lambda () (throw 'finished nil))))
