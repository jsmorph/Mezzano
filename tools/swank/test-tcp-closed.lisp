(defpackage :lispm-tcp-closed-test
  (:use :cl)
  (:local-nicknames (:tcp :mezzano.network.tcp)
                    (:ip :mezzano.network.ip)
                    (:net :mezzano.network)
                    (:sup :mezzano.supervisor)
                    (:dispatch :mezzano.sync.dispatch))
  (:export #:run))
(in-package :lispm-tcp-closed-test)

(declaim (optimize (safety 3) (debug 3) (speed 1)))

(defclass packet-interface ()
  ((packets :initform nil :accessor interface-packets)))

(defmethod ip:transmit-ipv4-packet-on-interface
    (destination (interface packet-interface) packet)
  (declare (ignore destination))
  (let ((bytes (make-array (net:packet-length packet)
                           :element-type '(unsigned-byte 8))))
    (net:copy-packet bytes packet)
    (push bytes (interface-packets interface))))

(defstruct task
  (done (sup:make-event))
  thread failure values)

(defun await (predicate)
  (let ((deadline (+ (get-internal-run-time)
                     (* 10 internal-time-units-per-second))))
    (loop until (funcall predicate)
          do (when (>= (get-internal-run-time) deadline)
               (error "TCP test wait expired."))
             (sleep 0.001))))

(defun enqueue (function interface)
  (let ((task (make-task)))
    (dispatch:dispatch-async
     (lambda ()
       (setf (task-thread task) (sup:current-thread))
       (unwind-protect
            (handler-case
                (let ((ip::*routing-table*
                        (list (make-instance 'ip::ipv4-route
                                             :network (ip:make-ipv4-address "198.18.0.0")
                                             :prefix-length 24 :gateway interface))))
                  (setf (task-values task) (multiple-value-list (funcall function))))
              (error (condition) (setf (task-failure task) condition)))
         (setf (sup:event-state (task-done task)) t)))
     net::*network-serial-queue*)
    task))

(defun finish (task)
  (await (lambda () (sup:event-state (task-done task))))
  (when (task-failure task) (error (task-failure task)))
  (values-list (task-values task)))

(defun on-network (function interface)
  (finish (enqueue function interface)))

(defun make-connection (&optional (state :syn-sent))
  (make-instance 'tcp::tcp-connection
                 :state state :local-port 41001 :remote-port 41002
                 :local-ip (ip:make-ipv4-address "198.18.0.1")
                 :remote-ip (ip:make-ipv4-address "198.18.0.2")
                 :snd.una 10 :snd.nxt 11 :rcv.nxt 20 :rcv.wnd 8192
                 :boot-id (sup:current-boot-id)))

(defun call-with-connection (function &key (state :syn-sent) (register t))
  (let ((connection (make-connection state))
        (interface (make-instance 'packet-interface)))
    (unwind-protect
         (progn
           (dispatch:cancel (tcp::tcp-connection-retransmit-source connection))
           (dispatch:cancel (tcp::tcp-connection-timeout-source connection))
           (await (lambda ()
                    (and (dispatch:canceled-p
                          (tcp::tcp-connection-retransmit-source connection))
                         (dispatch:canceled-p
                          (tcp::tcp-connection-timeout-source connection)))))
           (when register
             (assert (null (tcp::get-tcp-connection
                            (tcp:tcp-connection-remote-ip connection) 41002
                            (tcp:tcp-connection-local-ip connection) 41001)))
             (sup:with-mutex (tcp::*tcp-connection-lock*)
               (push connection tcp::*tcp-connections*)))
           (funcall function connection interface))
      (on-network
       (lambda ()
         (sup:with-mutex ((tcp::tcp-connection-lock connection))
           (tcp::detach-tcp-connection connection)))
       interface)
      (assert-detached connection))))

(defun assert-detached (connection)
  (assert (null (sup::timer-deadline
                 (tcp::tcp-connection-retransmit-timer connection))))
  (assert (null (sup::timer-deadline
                 (tcp::tcp-connection-timeout-timer connection))))
  (sup:with-mutex (tcp::*tcp-connection-lock*)
    (assert (not (member connection tcp::*tcp-connections*)))))

(defun incoming (connection seq ack &key ack-p rst-p syn-p fin-p (data #()))
  (let* ((data (make-array (length data) :element-type '(unsigned-byte 8)
                                        :initial-contents data))
         (parts (tcp::assemble-tcp4-packet
                 (tcp:tcp-connection-remote-ip connection) 41002
                 (tcp:tcp-connection-local-ip connection) 41001
                 seq ack 8192 data :ack-p ack-p :rst-p rst-p
                 :syn-p syn-p :fin-p fin-p))
         (packet (make-array (net:packet-length parts)
                             :element-type '(unsigned-byte 8))))
    (net:copy-packet packet parts)
    packet))

(defun assert-reset (packet seq ack ack-p)
  (let* ((start (* (ldb (byte 4 0) (aref packet 0)) 4))
         (end (length packet)))
    (assert (= end (+ start 20)))
    (assert (= (tcp::tcp-packet-sequence-number packet start end) seq))
    (assert (= (tcp::tcp-packet-acknowledgment-number packet start end) ack))
    (assert (= (tcp::tcp-packet-flags packet start end)
               (logior tcp::+tcp4-flag-rst+ (if ack-p tcp::+tcp4-flag-ack+ 0))))
    (assert (zerop (tcp::ub16ref/be packet (+ start tcp::+tcp4-header-window-size+))))
    (assert (= (tcp::ub16ref/be packet start) 41001))
    (assert (= (tcp::ub16ref/be packet (+ start 2)) 41002))))

(defun packet-tests ()
  (dolist (unknown '(nil t))
    (call-with-connection
     (lambda (connection interface)
       (on-network
        (lambda ()
          (dolist (case '((77 88 (:rst-p t) nil)
                          (77 88 (:ack-p t :rst-p t) nil)
                          (77 88 (:ack-p t) (88 0 nil))
                          (77 88 () (0 77 t))
                          (77 88 (:data #(1 2 3)) (0 80 t))
                          (#xffffffff 88 (:syn-p t) (0 0 t))
                          (#xfffffffe 88 (:fin-p t :data #(1 2 3)) (0 2 t))
                          (#xfffffffe 88 (:syn-p t :fin-p t :data #(1 2 3)) (0 3 t))))
            (destructuring-bind (seq ack options expected) case
              (let ((packet (apply #'incoming connection seq ack options)))
                (setf (interface-packets interface) nil)
                (if unknown
                    (ip:ipv4-receive ip:+ip-protocol-tcp+ packet
                                     (tcp:tcp-connection-local-ip connection)
                                     (tcp:tcp-connection-remote-ip connection)
                                     0 (length packet))
                    (tcp::tcp4-connection-receive connection packet 0 (length packet) nil))
                (if expected
                    (progn
                      (assert (= (length (interface-packets interface)) 1))
                      (apply #'assert-reset (first (interface-packets interface)) expected))
                    (assert (null (interface-packets interface))))))))
        interface))
     :state :closed :register (not unknown)))
  (format t "PASS CLOSED and unknown-connection reset fields, RST discard, and wrap.~%"))

(defun await-mutex (task connection)
  (await (lambda ()
           (or (sup:event-state (task-done task))
               (and (task-thread task)
                    (eq (sup:thread-wait-item (task-thread task))
                        (tcp::tcp-connection-lock connection))))))
  (when (sup:event-state (task-done task))
    (finish task)
    (error "TCP callback returned before waiting for the connection mutex.")))

(defun receive-abort-test ()
  (call-with-connection
   (lambda (connection interface)
     (let ((captured (sup:make-event)) (task nil) (abort-error nil))
       (sup:with-mutex ((tcp::tcp-connection-lock connection))
         (sup:timer-arm 60 (tcp::tcp-connection-retransmit-timer connection))
         (sup:timer-arm 60 (tcp::tcp-connection-timeout-timer connection))
         (let ((retransmit (sup::timer-deadline (tcp::tcp-connection-retransmit-timer connection)))
               (timeout (sup::timer-deadline (tcp::tcp-connection-timeout-timer connection))))
           (setf task
                 (enqueue
                  (lambda ()
                    (let ((found (tcp::get-tcp-connection
                                  (tcp:tcp-connection-remote-ip connection) 41002
                                  (tcp:tcp-connection-local-ip connection) 41001))
                          (packet (incoming connection 77 88 :ack-p t)))
                      (assert (eq found connection))
                      (setf (sup:event-state captured) t)
                      (tcp::tcp4-connection-receive found packet 0 (length packet) nil)
                      (assert (eq (tcp::tcp-connection-state connection) :closed))
                      (assert (eq (tcp::tcp-connection-pending-error connection) abort-error))
                      (assert (null (tcp::tcp-connection-rx-data connection)))
                      (assert (= (sup::timer-deadline (tcp::tcp-connection-retransmit-timer connection)) retransmit))
                      (assert (= (sup::timer-deadline (tcp::tcp-connection-timeout-timer connection)) timeout))))
                  interface)))
         (await (lambda () (sup:event-state captured)))
         (await-mutex task connection)
         (tcp::abort-connection connection)
         (setf abort-error (tcp::tcp-connection-pending-error connection))
         (assert (typep abort-error 'tcp::connection-aborted)))
       (finish task)
       (on-network (lambda () (values)) interface)
       (assert-detached connection)
       (assert (= (length (interface-packets interface)) 1))
       (assert-reset (first (interface-packets interface)) 88 0 nil))))
  (format t "PASS captured receive blocked by abort before queued detach.~%"))

(defun detached-receive-test ()
  (call-with-connection
   (lambda (connection interface)
     (on-network
      (lambda ()
        (let ((found (tcp::get-tcp-connection
                      (tcp:tcp-connection-remote-ip connection) 41002
                      (tcp:tcp-connection-local-ip connection) 41001))
              (packet (incoming connection #xffffffff 0 :fin-p t)))
          (assert (eq found connection))
          (sup:with-mutex ((tcp::tcp-connection-lock connection))
            (tcp::detach-tcp-connection connection))
          (assert (null (tcp::get-tcp-connection
                         (tcp:tcp-connection-remote-ip connection) 41002
                         (tcp:tcp-connection-local-ip connection) 41001)))
          (tcp::tcp4-connection-receive found packet 0 (length packet) nil)
          (assert (= (length (interface-packets interface)) 1))
          (assert-reset (first (interface-packets interface)) 0 0 t)))
      interface)))
  (format t "PASS receive through a captured, detached connection.~%"))

(defun timer-test (kind abort-p)
  (call-with-connection
   (lambda (connection interface)
     (let* ((timer (ecase kind
                     (:retransmit (tcp::tcp-connection-retransmit-timer connection))
                     (:timeout (tcp::tcp-connection-timeout-timer connection))))
            (handler (ecase kind
                       (:retransmit #'tcp::retransmit-timer-handler)
                       (:timeout #'tcp::timeout-timer-handler)))
            (deadline nil) (abort-error nil) (task nil))
       (sup:with-mutex ((tcp::tcp-connection-lock connection))
         (sup::timer-arm-absolute 0 timer)
         (assert (sup:timer-expired-p timer))
         (setf task
               (enqueue
                (lambda ()
                  (funcall handler connection)
                  (if abort-p
                      (progn
                        (assert (null (sup::timer-deadline timer)))
                        (assert (eq (tcp::tcp-connection-pending-error connection) abort-error))
                        (assert (eq (tcp::tcp-connection-state connection) :closed)))
                      (progn
                        (assert (= (sup::timer-deadline timer) deadline))
                        (assert (null (tcp::tcp-connection-pending-error connection)))
                        (assert (eq (tcp::tcp-connection-state connection) :syn-sent)))))
                interface))
         (await-mutex task connection)
         (if abort-p
             (progn
               (tcp::abort-connection connection)
               (setf abort-error (tcp::tcp-connection-pending-error connection)))
             (progn
               (sup:timer-arm 60 timer)
               (setf deadline (sup::timer-deadline timer)))))
       (finish task)
       (on-network (lambda () (values)) interface)
       (when abort-p (assert-detached connection))
       (assert (null (interface-packets interface)))))))

(defun run ()
  (packet-tests)
  (receive-abort-test)
  (detached-receive-test)
  (dolist (kind '(:retransmit :timeout))
    (timer-test kind nil)
    (timer-test kind t))
  (format t "PASS expired retransmit/timeout callbacks after mutex-blocked rearm or abort.~%")
  t)
