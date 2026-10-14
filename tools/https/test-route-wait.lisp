(defpackage #:lispm-route-wait-test
  (:use #:cl)
  (:local-nicknames (:ip :mezzano.network.ip)
                    (:net :mezzano.network)
                    (:tcp :mezzano.network.tcp)
                    (:sup :mezzano.supervisor))
  (:export #:run))

(in-package #:lispm-route-wait-test)

(define-condition cancelled-route-wait (error) ())

(defun run ()
  (let* ((destination (ip:make-ipv4-address "198.51.100.77"))
         (defaults (remove-if-not (lambda (route)
                                    (zerop (ip::route-prefix-length route)))
                                  ip::*routing-table*))
         (thread nil))
    (assert defaults)
    (flet ((restore-defaults ()
             (dolist (route defaults)
               (ip:add-route (ip::route-network route) 0
                             (ip::route-gateway route) (ip::route-tag route))))
           (start-waiter ()
             (sup:make-thread
              (lambda ()
                (handler-case
                    (list :returned
                          (multiple-value-list
                           (ip::wait-for-ipv4-route destination (net::deadline-after 2))))
                  (cancelled-route-wait () :cancelled)
                  (error (condition) condition)))
              :name "Route availability test"))
           (join-waiter (thread)
             (lispm-network-test::await
              (lambda () (nth-value 1 (sup:thread-join thread nil))))
             (let ((result (first (sup:thread-join thread))))
               (when (typep result 'error) (error result))
               result))
           (await-waiter (thread)
             (lispm-network-test::await
              (lambda () (eq (sup:thread-wait-item thread)
                             ip::*routing-table-changed*)))))
      (unwind-protect
           (progn
             (ip:remove-route "0.0.0.0" 0 t)
             (assert
              (handler-case
                  (progn (tcp:tcp-stream-connect destination 1 :connect-timeout 1/20)
                         nil)
                (ip:no-route-to-host () t)))
             (let ((start (get-internal-run-time)))
               (assert
                (handler-case
                    (progn (tcp:tcp-stream-connect destination 1
                                                   :connect-timeout 1/20
                                                   :wait-for-route t)
                           nil)
                  (net:network-timeout () t)))
               (assert (<= (* 1/20 internal-time-units-per-second)
                           (- (get-internal-run-time) start)
                           (* 2 internal-time-units-per-second))))
             (setf thread (start-waiter))
             (await-waiter thread)
             (restore-defaults)
             (let ((result (join-waiter thread)))
               (assert (eq (first result) :returned))
               (multiple-value-bind (host interface) (ip:ipv4-route destination)
                 (assert (ip:address-equal host (first (second result))))
                 (assert (eq interface (second (second result))))))
             (setf thread nil)
             (ip:remove-route "0.0.0.0" 0 t)
             (setf thread (start-waiter))
             (await-waiter thread)
             (sup:establish-thread-foothold
              thread (lambda () (error 'cancelled-route-wait)))
             (assert (eq (join-waiter thread) :cancelled))
             (setf thread nil))
        (restore-defaults)
        (when thread (join-waiter thread)))))
  (let ((listener (tcp:tcp-listen "127.0.0.1" 0))
        (client nil) (server nil))
    (unwind-protect
         (progn
           (setf client (tcp:tcp-stream-connect
                         "127.0.0.1" (tcp::tcp-listener-local-port listener)
                         :element-type '(unsigned-byte 8)
                         :connect-timeout 2 :wait-for-route t)
                 server (tcp:tcp-accept listener :element-type '(unsigned-byte 8)))
           (write-byte 73 client)
           (finish-output client)
           (assert (= (read-byte server) 73)))
      (when client (close client :abort t))
      (when server (close server :abort t))
      (tcp:close-tcp-listener listener)))
  (format t "PASS route arrival, deadline, cancellation, immediate error, and TCP data.~%")
  (values))
