(defpackage :lispm-network-test
  (:use :cl)
  (:local-nicknames (:net :mezzano.network)
                    (:tcp :mezzano.network.tcp)
                    (:sup :mezzano.supervisor)
                    (:dispatch :mezzano.sync.dispatch)))
(in-package :lispm-network-test)

(defun await (predicate)
  (let ((deadline (+ (get-internal-run-time) (* 5 internal-time-units-per-second))))
    (loop until (funcall predicate)
          do (when (>= (get-internal-run-time) deadline)
               (error "Network test wait expired."))
             (sleep 0.01))))

(defun drain-network-queue ()
  (let ((done nil))
    (dispatch:dispatch-async (lambda () (setf done t)) net::*network-serial-queue*)
    (await (lambda () done))))

(defun connect (port &optional (timeout 2))
  (tcp:tcp-stream-connect "127.0.0.1" port :element-type '(unsigned-byte 8)
                                               :connect-timeout timeout))

(defun deadline-tests ()
  (assert (handler-case (progn (connect 1 0) nil)
            (net:network-timeout () t)))
  (let ((mezzano.network.dns::*dns-servers* '(("127.0.0.1" . :test)))
        (start (get-internal-run-time)))
    (assert (handler-case
                (progn (net:resolve-address "deadline.invalid" t
                                            :deadline (net::deadline-after 0.05))
                       nil)
              (net:network-timeout () t)))
    (assert (< (- (get-internal-run-time) start) (* 2 internal-time-units-per-second))))
  (let ((gate (sup:make-event))
        (entered nil)
        (listener (tcp:tcp-listen "127.0.0.1" 0)))
    (unwind-protect
         (let ((port (tcp::tcp-listener-local-port listener)))
           (dispatch:dispatch-async
            (lambda () (setf entered t) (sup:event-wait gate))
            net::*network-serial-queue*)
           (await (lambda () entered))
           (let ((start (get-internal-run-time)))
             (assert (handler-case (progn (connect port 0.05) nil)
                       (net:network-timeout () t)))
             (assert (< (- (get-internal-run-time) start)
                        (* 2 internal-time-units-per-second))))
           (setf (sup:event-state gate) t)
           (drain-network-queue)
           (assert (null (tcp:tcp-accept listener :wait-p nil)))
           (assert (notany (lambda (connection)
                             (= (tcp:tcp-connection-remote-port connection) port))
                           tcp::*tcp-connections*)))
      (setf (sup:event-state gate) t)
      (tcp:close-tcp-listener listener)))
  (let* ((listener (tcp:tcp-listen "127.0.0.1" 0))
         (port (tcp::tcp-listener-local-port listener)))
    (tcp:close-tcp-listener listener)
    (assert (handler-case (progn (connect port) nil)
              (tcp::connection-reset () t))))
  (format t "PASS DNS and connection deadlines, canceled queued start, and refusal.~%"))

(define-condition interrupted-connect (error) ())

(defun interrupt-test ()
  (let ((gate (sup:make-event))
        (entered nil)
        (done nil)
        (result nil)
        (thread nil)
        (listener (tcp:tcp-listen "127.0.0.1" 0)))
    (unwind-protect
         (let ((port (tcp::tcp-listener-local-port listener)))
           (dispatch:dispatch-async
            (lambda () (setf entered t) (sup:event-wait gate))
            net::*network-serial-queue*)
           (await (lambda () entered))
           (setf thread
                 (sup:make-thread
                  (lambda ()
                    (unwind-protect
                         (setf result
                               (handler-case (connect port 4)
                                 (interrupted-connect () :interrupted)))
                      (setf done t)))
                  :name "TCP interrupted connect test"))
           (await (lambda () (typep (sup:thread-wait-item thread)
                                   'sup:condition-variable)))
           (sup:establish-thread-foothold
            thread (lambda () (error 'interrupted-connect)))
           (await (lambda () done))
           (sup:thread-join thread)
           (assert (eq result :interrupted))
           (setf (sup:event-state gate) t)
           (drain-network-queue)
           (assert (null (tcp:tcp-accept listener :wait-p nil)))
           (assert (notany (lambda (connection)
                            (= (tcp:tcp-connection-remote-port connection) port))
                          tcp::*tcp-connections*)))
      (setf (sup:event-state gate) t)
      (tcp:close-tcp-listener listener)))
  (format t "PASS interrupted connection establishment and cleanup.~%"))

(defun call-with-pair (function)
  (let ((listener (tcp:tcp-listen "127.0.0.1" 0))
        (client nil)
        (server nil))
    (unwind-protect
         (progn
           (setf client (connect (tcp::tcp-listener-local-port listener)))
           (await (lambda () (setf server (tcp:tcp-accept listener :wait-p nil
                                                        :element-type '(unsigned-byte 8)))))
           (funcall function client server))
      (when client (close client :abort t))
      (when server (close server :abort t))
      (tcp:close-tcp-listener listener)
      (drain-network-queue))))

(defun stream-tests ()
  (call-with-pair
   (lambda (client server)
     (write-byte 42 server)
     (assert (= (read-byte client) 42))
     (close server)
     (assert (eq (read-byte client nil :eof) :eof))))
  (call-with-pair
   (lambda (client server)
     (declare (ignore server))
     (let* ((connection (tcp:tcp-stream-connection client))
            (done nil)
            (result nil)
            (thread
              (sup:make-thread
               (lambda ()
                 (unwind-protect
                      (setf result
                            (handler-case (read-byte client nil :eof)
                              (tcp::connection-aborted () :aborted)))
                   (setf done t)))
               :name "TCP blocked read test")))
       (unwind-protect
            (progn
              (await (lambda () (eq (sup:thread-wait-item thread)
                                    (tcp::tcp-connection-cvar connection))))
              (assert (close client :abort t))
              (await (lambda () done))
              (sup:thread-join thread)
              (assert (eq result :aborted))
              (assert (not (open-stream-p client)))
              (assert (sup:event-state (tcp::tcp-connection-receive-event connection)))
              (drain-network-queue)
              (assert (not (member connection tcp::*tcp-connections*)))
              (assert (not (tcp::tcp-connection-retransmit-queue connection))))
         (close client :abort t)))))
  (format t "PASS TCP octets, EOF, abort of blocked input, and connection cleanup.~%"))

(defvar *restore-client*)
(defvar *restore-server*)

(defun prepare-restore-test ()
  (let ((listener (tcp:tcp-listen "127.0.0.1" 0)))
    (unwind-protect
         (progn
           (setf *restore-client* (connect (tcp::tcp-listener-local-port listener)))
           (await (lambda ()
                    (setf *restore-server*
                          (tcp:tcp-accept listener :wait-p nil :element-type '(unsigned-byte 8))))))
      (tcp:close-tcp-listener listener)))
  (format t "Prepared TCP snapshot fixture.~%"))

(defun finish-restore-test ()
  (unwind-protect
       (progn
         (assert (handler-case (progn (read-byte *restore-client*) nil)
                   (tcp::connection-stale () t)))
         (stream-tests)
         (format t "PASS stale TCP connection rejection and new connections after restore.~%"))
    (close *restore-client* :abort t)
    (close *restore-server* :abort t)))

(defun run ()
  (deadline-tests)
  (interrupt-test)
  (stream-tests)
  t)

(in-package :cl-user)
