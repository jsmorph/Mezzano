(defpackage #:lispm-http-listener-lifecycle-test
  (:use #:cl)
  (:local-nicknames (#:tcp #:mezzano.network.tcp)
                    (#:http #:mezzano.http-server)
                    (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug)
                    (#:st #:lispm-service-test))
  (:export #:run #:baseline))
(in-package #:lispm-http-listener-lifecycle-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun conflict-state ()
  (let* ((listener (tcp:tcp-listen "127.0.0.1" 0 :backlog 1))
         (port (tcp:tcp-listener-local-port listener))
         (duplicate nil)
         (condition nil)
         (held :not-signalled))
    (unwind-protect
         (progn
           (handler-case
               (handler-bind
                   ((simple-error
                      (lambda (error)
                        (declare (ignore error))
                        (setf held (s:mutex-held-p tcp::*tcp-listener-lock*)))))
                 (setf duplicate (tcp:tcp-listen "127.0.0.1" port :backlog 1)))
             (simple-error (error) (setf condition error)))
           (assert condition)
           (assert (search "Server already listening" (princ-to-string condition)))
           (assert (eq (tcp::get-tcp-listener (tcp:tcp-listener-local-ip listener) port) listener))
           (list :lock-held-p held :message (princ-to-string condition)))
      (when duplicate (tcp:close-tcp-listener duplicate))
      (tcp:close-tcp-listener listener))))

(defun shutdown-state ()
  (let* ((server (http:start-server
                  :address "127.0.0.1" :port 0
                  :handler (lambda (request)
                             (declare (ignore request))
                             (values 200 nil #()))))
         (listener (http::server-listener server))
         (acceptor (http::server-thread server))
         (original #'tcp:close-tcp-listener)
         (entered (s:make-event))
         (release (s:make-event))
         (stopper nil))
    (unwind-protect
         (progn
           (setf (symbol-function 'tcp:close-tcp-listener)
                 (lambda (object)
                   (when (eq object listener)
                     (setf (s:event-state entered) t)
                     (s:event-wait release))
                   (funcall original object)))
           (setf (s:event-state (http::server-shutdown server)) t)
           (st::await (lambda () (s:event-state entered)))
           (setf stopper
                 (s:make-thread
                  (lambda () (http:stop-server server) :stopped)
                  :name "Owned HTTP cleanup shutdown"))
           (st::await
            (lambda ()
              (or (nth-value 1 (s:thread-join acceptor nil))
                  (and (eq (s::sample-thread-state acceptor) :sleeping)
                       (eq (s::thread-wait-item acceptor) release)
                       (eq (s::sample-thread-state stopper) :sleeping)
                       (eq (s::thread-wait-item stopper) (s::thread-join-event acceptor))
                       (null (s::thread-pending-footholds acceptor))))))
           (let ((terminated (nth-value 1 (s:thread-join acceptor nil))))
             (setf (s:event-state release) t)
             (st::await (lambda () (nth-value 1 (s:thread-join stopper nil))))
             (assert (equal (s:thread-join stopper) '(:stopped)))
             (list :terminated-during-cleanup terminated
                   :listener-leaked-p
                   (eq (tcp::get-tcp-listener
                        (tcp:tcp-listener-local-ip listener)
                        (tcp:tcp-listener-local-port listener)) listener))))
      (setf (symbol-function 'tcp:close-tcp-listener) original
            (s:event-state release) t)
      (when stopper
        (st::await (lambda () (nth-value 1 (s:thread-join stopper nil)))))
      (http:stop-server server)
      (funcall original listener))))

(defun retained-conflict-test ()
  (let* ((listener (tcp:tcp-listen "127.0.0.1" 0 :backlog 1))
         (port (tcp:tcp-listener-local-port listener))
         (name (format nil "Owned TCP conflict ~D" (get-internal-real-time)))
         (controller (d:make-debugger-controller))
         (cleanup 0)
         (thread
           (s:make-thread
            (lambda ()
              (d:call-with-debugger-service
               (lambda ()
                 (with-simple-restart (abort "End the TCP conflict fixture.")
                   (unwind-protect
                        (tcp:tcp-listen "127.0.0.1" port :backlog 1)
                     (incf cleanup))))))
            :name name)))
    (unwind-protect
         (let* ((handle (st::await (lambda () (st::stop-for-thread name))))
                (lease (d:attach-debugger-stop handle controller))
                (stop (d::service-handle-stop handle)))
           (assert (search "Server already listening"
                           (princ-to-string (d::service-stop-condition stop))))
           (assert (not (eq (s::mutex-owner tcp::*tcp-listener-lock*) thread)))
           (assert (eq (tcp::get-tcp-listener (tcp:tcp-listener-local-ip listener) port) listener))
           (assert (st::command handle lease :frames))
           (st::command handle lease :condition)
           (let ((id (getf (d:debugger-stop-information handle) :next-command-id)))
             (d:submit-debugger-command lease id :abort)
             (assert (eq (getf (st::completed-command handle id) :state) :unwound)))
           (st::await (lambda () (nth-value 1 (s:thread-join thread nil))))
           (assert (= cleanup 1))
           (d:release-debugger-stop lease))
      (tcp:close-tcp-listener listener)
      (d:close-debugger-controller controller)))
  t)

(defun baseline ()
  (list :conflict (conflict-state) :shutdown (shutdown-state)))

(defun run ()
  (assert (null (getf (conflict-state) :lock-held-p)))
  (let ((shutdown (shutdown-state)))
    (assert (not (getf shutdown :terminated-during-cleanup)))
    (assert (not (getf shutdown :listener-leaked-p))))
  (retained-conflict-test)
  (format t "PASS TCP conflict outside lock, retained debugger Abort, cooperative HTTP cleanup and listener release.~%")
  t)
