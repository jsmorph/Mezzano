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
                               (loop repeat (if (eq mode :repeat) 2 1)
                                     do (loop until done
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
                                          (when (member mode '(:mutation :stale-mutation))
                                            (let ((command (read peer)))
                                              (assert (eq (first command) :create))
                                              (push command commands)))
                                          (close peer)
                                          (setf peer nil))))
                          (when peer (close peer)))
                      (error (condition) condition)))
                  :name "Remote EOF test peer"))
           (setf result
                 (handler-case
                     (list :returned
                           (mezzano.file-system:open-using-host
                            host pathname
                            :direction (if (member mode '(:mutation :stale-mutation)) :output :input)
                            :element-type '(unsigned-byte 8)
                            :if-exists :error
                            :if-does-not-exist (when (member mode '(:mutation :stale-mutation)) :create)
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
    (assert (equal (mapcar #'first commands) '(:probe :probe))))
  (multiple-value-bind (result commands) (probe :mutation)
    (assert (eq result :eof))
    (assert (equal (mapcar #'first commands) '(:probe :create))))
  (multiple-value-bind (result commands) (probe :stale-mutation)
    (assert (eq result :eof))
    (assert (equal (mapcar #'first commands) '(:probe :create))))
  (assert (run-connection-boundaries))
  (format t "PASS orderly EOF probe recovery, one retry, and no CREATE replay.~%")
  t)

(defclass close-error-stream (tcp::tcp-stream)
  ((failure :initarg :failure :reader close-failure)))

(defmethod close ((stream close-error-stream) &key abort)
  (declare (ignore abort))
  (error (close-failure stream)))

(defun call-with-pair (function)
  (let* ((listener (tcp:tcp-listen "127.0.0.1" 0))
         (port (tcp::tcp-listener-local-port listener))
         (host (make-instance 'remote::remote-file-host
                              :name "CONNECTION-TEST" :address "127.0.0.1" :port port))
         (client nil)
         (peer nil))
    (unwind-protect
         (progn
           (setf client (tcp:tcp-stream-connect "127.0.0.1" port :connect-timeout 2)
                 peer (await (lambda () (tcp:tcp-accept listener :wait-p nil)))
                 (remote::remote-host-connection host) client)
           (funcall function host client peer))
      (let ((cached (shiftf (remote::remote-host-connection host) nil)))
        (when (and cached (not (typep cached 'close-error-stream)))
          (close cached :abort t)))
      (when client (close client :abort t))
      (when peer (close peer :abort t))
      (loop for pending = (tcp:tcp-accept listener :wait-p nil)
            while pending do (close pending :abort t))
      (tcp:close-tcp-listener listener))))

(defun observe-error-boundary ()
  (call-with-pair
   (lambda (host client peer)
     (declare (ignore peer))
     (let ((primary (make-condition 'end-of-file :stream client))
           (observed nil))
       (handler-case
           (handler-bind
               ((end-of-file
                  (lambda (condition)
                    (setf observed
                          (list (sup::mutex-held-p (remote::remote-host-lock host))
                                (not (null (find-restart 'remote::retry)))
                                (eq primary condition))))))
             (remote::call-with-connection host
                                           (lambda (stream)
                                             (declare (ignore stream))
                                             (error primary))
                                           nil))
         (end-of-file (condition) (assert (eq condition primary))))
       observed))))

(defun run-connection-boundaries ()
  (assert (equal (observe-error-boundary) '(nil t t)))
  (call-with-pair
   (lambda (host client peer)
     (declare (ignore client peer))
     (assert (equal (multiple-value-list
                     (remote::call-with-connection
                      host (lambda (stream) (declare (ignore stream))
                             (values 17 nil :third)) nil))
                    '(17 nil :third)))
     (assert (eq (block escaped
                   (remote::call-with-connection
                    host (lambda (stream) (declare (ignore stream))
                           (return-from escaped :escaped)) nil))
                 :escaped))
     (assert (not (sup::mutex-held-p (remote::remote-host-lock host))))))
  (call-with-pair
   (lambda (host client peer)
     (declare (ignore peer))
     (let ((primary (make-condition 'mezzano.file-system::simple-file-error
                                    :pathname #p"SYS:HOME;MISSING"
                                    :format-control "Expected server reply"))
           (observed nil))
       (handler-case
           (handler-bind
               ((error (lambda (condition)
                         (setf observed
                               (list (eq primary condition)
                                     (sup::mutex-held-p (remote::remote-host-lock host)))))))
             (remote::call-with-connection
              host (lambda (stream) (declare (ignore stream)) (error primary)) nil))
         (error (condition) (assert (eq condition primary))))
       (assert (equal observed '(t nil)))
       (assert (eq (remote::remote-host-connection host) client)))))
  (call-with-pair
   (lambda (host client peer)
     (declare (ignore peer))
     (let ((primary (make-condition 'end-of-file :stream client))
           (attempts 0))
       (assert
        (equal
         (multiple-value-list
          (handler-bind
              ((end-of-file
                 (lambda (condition)
                   (assert (eq primary condition))
                   (assert (not (sup::mutex-held-p (remote::remote-host-lock host))))
                   (assert (= attempts 1))
                   (invoke-restart 'remote::retry))))
            (remote::call-with-connection
             host (lambda (stream)
                    (incf attempts)
                    (when (= attempts 1) (error primary))
                    (assert (not (eq stream client)))
                    (values :retried 2))
             nil)))
         '(:retried 2)))
       (assert (= attempts 2)))))
  (dolist (repeat '(nil t))
    (call-with-pair
     (lambda (host client peer)
       (declare (ignore client peer))
       (let ((primary (make-condition 'tcp::connection-reset :host "127.0.0.1" :port 0))
             (attempts 0)
             (observed nil))
         (handler-case
             (assert
              (eq (remote::call-with-connection
                   host (lambda (stream)
                          (declare (ignore stream))
                          (incf attempts)
                          (when (or repeat (= attempts 1)) (error primary))
                          :recovered)
                   t)
                  :recovered))
           (tcp::connection-reset (condition)
             (setf observed condition)
             (assert (not (sup::mutex-held-p (remote::remote-host-lock host))))))
         (assert (= attempts 2))
         (assert (eq observed (and repeat primary)))))))
  (call-with-pair
   (lambda (host client peer)
     (declare (ignore peer))
     (let* ((primary (make-condition 'end-of-file :stream client))
            (cleanup (make-condition 'simple-error :format-control "Expected abort failure"))
            (replacement (make-instance 'close-error-stream
                                        :connection (tcp:tcp-stream-connection client)
                                        :failure cleanup))
            (observed nil))
       (setf (remote::remote-host-connection host) replacement)
       (handler-case
           (remote::call-with-connection
            host (lambda (stream) (declare (ignore stream)) (error primary)) nil)
         (simple-error (condition) (setf observed condition)))
       (assert observed)
       (assert (equal (simple-condition-format-arguments observed) (list primary cleanup)))
       (assert (null (remote::remote-host-connection host)))
       (assert (not (sup::mutex-held-p (remote::remote-host-lock host)))))))
  (call-with-pair
   (lambda (host client peer)
     (declare (ignore host peer))
     (assert (remote::reusable-remote-connection-p client))
     (let ((connection (tcp:tcp-stream-connection client)))
       (tcp::with-tcp-connection-locked connection
         (setf (tcp::tcp-connection-pending-error connection)
               (make-condition 'tcp::connection-reset :host "127.0.0.1" :port 0)))
       (assert (not (remote::reusable-remote-connection-p client))))))
  (format t "PASS remote cache eligibility, error identity, unlocked signaling, RETRY, and abort failures.~%")
  t)

(defvar *parked-failure* nil)

(defun prepare-parked-failure ()
  (assert (null *parked-failure*))
  (let* ((listener (tcp:tcp-listen "127.0.0.1" 0))
         (port (tcp::tcp-listener-local-port listener))
         (host (make-instance 'remote::remote-file-host
                              :name "PARKED-EOF-TEST" :address "127.0.0.1" :port port))
         (pathname (make-pathname :host host :directory '(:absolute) :name "missing"))
         (client (tcp:tcp-stream-connect "127.0.0.1" port :connect-timeout 2))
         (peer (await (lambda () (tcp:tcp-accept listener :wait-p nil))))
         (state (list :host host :client client :peer peer :listener listener
                      :condition nil :commands nil :server nil :worker nil)))
    (setf (remote::remote-host-connection host) client
          *parked-failure* state)
    (setf (getf state :server)
          (sup:make-thread
           (lambda ()
             (unwind-protect
                  (let ((command (read peer)))
                    (assert (eq (first command) :probe))
                    (setf (getf state :commands) (list command)))
               (close peer)))
           :name "Parked remote EOF peer"))
    (setf (getf state :worker)
          (sup:make-thread
           (lambda ()
             (mezzano.debug:call-with-debugger-service
              (lambda ()
                (with-simple-restart (abort "Abort the owned remote EOF probe.")
                  (handler-bind
                      ((end-of-file
                         (lambda (condition) (setf (getf state :condition) condition))))
                    (mezzano.file-system::probe-using-host host pathname))))))
           :name "Parked remote EOF probe"))
    t))

(defun finish-parked-failure ()
  (let ((state *parked-failure*))
    (assert state)
    (assert (typep (getf state :condition) 'end-of-file))
    (assert (not (sup::mutex-held-p (remote::remote-host-lock (getf state :host)))))
    (assert (null (remote::remote-host-connection (getf state :host))))
    (dolist (key '(:server :worker))
      (await (lambda () (nth-value 1 (sup:thread-join (getf state key) nil))))
      (sup:thread-join (getf state key)))
    (assert (equal (mapcar #'first (getf state :commands)) '(:probe)))
    (close (getf state :client) :abort t)
    (close (getf state :peer) :abort t)
    (tcp:close-tcp-listener (getf state :listener))
    (setf *parked-failure* nil)
    (format t "PASS parked remote EOF probe, one request, and owned cleanup.~%")
    t))
