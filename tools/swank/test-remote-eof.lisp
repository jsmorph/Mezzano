(defpackage #:lispm-remote-eof-test
  (:use #:cl)
  (:local-nicknames (#:remote #:mezzano.file-system.remote)
                    (#:tcp #:mezzano.network.tcp)
                    (#:sup #:mezzano.supervisor))
  (:export #:run #:probe))
(in-package #:lispm-remote-eof-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun await (predicate)
  (let ((deadline (+ (get-internal-run-time) (* 5 internal-time-units-per-second))))
    (loop for result = (funcall predicate)
          when result return result
          do (when (>= (get-internal-run-time) deadline)
               (error "Remote EOF test wait expired."))
             (sleep 0.01))))

(defun probe (mode)
  (let* ((listener (tcp:tcp-listen "127.0.0.1" 0))
         (port (tcp::tcp-listener-local-port listener))
         (host (make-instance 'remote::remote-file-host
                              :name "EOF-TEST" :address "127.0.0.1" :port port))
         (pathname (make-pathname :host host :directory '(:absolute) :name "missing"))
         (old-peer nil)
         (peer nil)
         (thread nil)
         (done nil)
         (commands nil)
         (result nil)
         (server-result nil)
         (remote::*connection-idle-timeout* 2))
    (unwind-protect
         (progn
           (unless (eq mode :mutation)
             (let ((client (tcp:tcp-stream-connect "127.0.0.1" port
                                                   :connect-timeout 2)))
               (setf (remote::remote-host-connection host) client
                     old-peer (await (lambda () (tcp:tcp-accept listener :wait-p nil))))
               (close old-peer)
               (await (lambda ()
                        (eq (tcp::tcp-connection-state (tcp:tcp-stream-connection client))
                            :close-wait)))))
           (setf thread
                 (sup:make-thread
                  (lambda ()
                    (handler-case
                        (unwind-protect
                             (progn
                               (loop until done
                                     do (setf peer (tcp:tcp-accept listener :wait-p nil))
                                     when peer do (return)
                                     do (sleep 0.01))
                               (when peer
                                 (setf (tcp::tcp-connection-timeout
                                        (tcp:tcp-stream-connection peer)) 2)
                                 (let ((command (read peer)))
                                   (assert (eq (first command) :probe))
                                   (push command commands))
                                 (unless (eq mode :repeat)
                                   (mezzano.network:buffered-format
                                    peer "~S~%" '(:not-found "Missing test file")))
                                 (when (eq mode :mutation)
                                   (let ((command (read peer)))
                                     (assert (eq (first command) :create))
                                     (push command commands)))))
                          (when peer (close peer)))
                      (error (condition) condition)))
                  :name "Remote EOF test peer"))
           (setf result
                 (handler-case
                     (list :returned
                           (mezzano.file-system:open-using-host
                            host pathname
                            :direction (if (eq mode :mutation) :output :input)
                            :element-type '(unsigned-byte 8)
                            :if-exists :error
                            :if-does-not-exist (when (eq mode :mutation) :create)
                            :external-format :default))
                   (end-of-file () :eof))))
      (setf done t)
      (when (remote::remote-host-connection host)
        (close (remote::remote-host-connection host) :abort t))
      (when old-peer (close old-peer :abort t))
      (when thread
        (await (lambda () (nth-value 1 (sup:thread-join thread nil))))
        (setf server-result (first (sup:thread-join thread))))
      (tcp:close-tcp-listener listener))
    (when (typep server-result 'error) (error server-result))
    (values result (nreverse commands))))

(defun run ()
  (multiple-value-bind (result commands) (probe :recover)
    (assert (equal result '(:returned nil)))
    (assert (equal (mapcar #'first commands) '(:probe))))
  (multiple-value-bind (result commands) (probe :repeat)
    (assert (eq result :eof))
    (assert (equal (mapcar #'first commands) '(:probe))))
  (multiple-value-bind (result commands) (probe :mutation)
    (assert (eq result :eof))
    (assert (equal (mapcar #'first commands) '(:probe :create))))
  (format t "PASS orderly EOF probe recovery, one retry, and no CREATE replay.~%")
  t)
