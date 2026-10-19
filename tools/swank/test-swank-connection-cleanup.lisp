(defpackage :lispm-swank-connection-cleanup-test
  (:use :cl)
  (:local-nicknames (:sup :mezzano.supervisor)
                    (:net :mezzano.network)
                    (:tcp :mezzano.network.tcp)
                    (:gray :mezzano.gray))
  (:export #:run #:prepare-restore #:finish-restore))

(in-package :lispm-swank-connection-cleanup-test)

(defvar *case* nil)

(defun await (predicate)
  (let ((deadline (net::deadline-after 20)))
    (loop
      (let ((value (funcall predicate)))
        (when value (return value)))
      (net::deadline-remaining deadline)
      (sleep 0.01))))

(defun dead-p (thread)
  (eq (sup::sample-thread-state thread) :dead))

(defun owned-threads (connection)
  (swank/backend:call-with-lock-held
   (swank::mconn.lifecycle-lock connection)
   (lambda () (copy-list (swank::mconn.owned-threads connection)))))

(defun make-case-state (name)
  (list :name name :cleanup 0 :connection nil :worker nil :owner nil
        :borrowed nil :release nil :ready nil :hold nil :creator nil :closer nil
        :threads nil :later-hook-ran nil :observed-failure nil :expected-failures nil
        :rejection nil
        :rejected-while-live nil :unwind-complete nil
        :listener nil :client nil :peer nil :boot nil))

(defun new-case (name)
  (assert (null *case*))
  (setf *case* (make-case-state name))
  (setf (getf *case* :connection)
        (swank::make-multithreaded-connection
         :socket nil :socket-io (make-string-output-stream)
         :user-io (make-two-way-stream (make-string-input-stream "")
                                      (make-string-output-stream))
         :communication-style :spawn))
  *case*)

(defun close-case (case &rest hooks)
  (let ((swank::*connection-closed-hook* hooks)
        (swank::*log-output* (make-string-output-stream)))
    (swank::close-connection% (getf case :connection) nil nil)))

(defun finish-case ()
  (let* ((case *case*)
         (connection (getf case :connection)))
    (assert (not (swank::connection-open-p connection)))
    (assert (not (open-stream-p (swank::connection.socket-io connection))))
    (assert (notany #'swank/backend:thread-alive-p (owned-threads connection)))
    (format t "PASS SWANK connection ~A.~%" (getf case :name))
    (setf *case* nil)))

(defun normal-exit-test ()
  (let* ((case (new-case :normal-exit))
         (connection (getf case :connection))
         (thread (setf (getf case :worker)
                       (swank::spawn-connection-thread
                        connection (lambda () :normal) :name "Owned normal exit"))))
    (await (lambda () (dead-p thread)))
    (assert (not (member thread (owned-threads connection))))
    (close-case case)
    (finish-case)))

(defun borrowed-thread-test ()
  (let* ((case (new-case :borrowed-thread))
         (connection (getf case :connection))
         (release (setf (getf case :release)
                        (sup:make-event :name "Borrowed thread release")))
         (ready (setf (getf case :ready)
                      (sup:make-event :name "Owned worker ready")))
         (borrowed (setf (getf case :borrowed)
                         (sup:make-thread (lambda () (sup:event-wait release))
                                          :name "Borrowed connection test thread")))
         (worker (swank::spawn-connection-thread
                  connection
                  (lambda ()
                    (unwind-protect
                         (progn
                           (setf (sup:event-state ready) t)
                           (sup:event-wait release))
                      (incf (getf case :cleanup))))
                  :name "Owned connection test worker")))
    (setf (getf case :borrowed) borrowed
          (getf case :release) release
          (getf case :worker) worker)
    (assert (eq (swank::thread-for-evaluation
                 connection (swank/backend:thread-id borrowed)) borrowed))
    (swank::add-active-thread connection borrowed)
    (swank::add-active-thread connection borrowed)
    (assert (not (member borrowed (owned-threads connection))))
    (await (lambda () (sup:event-state ready)))
    (close-case case)
    (await (lambda () (dead-p worker)))
    (assert (= (getf case :cleanup) 1))
    (assert (not (dead-p borrowed)))
    (setf (sup:event-state release) t)
    (await (lambda () (dead-p borrowed)))
    (finish-case)))

(defun close-before-spawn-test ()
  (let* ((case (new-case :close-before-spawn))
         (connection (getf case :connection))
         (calls 0))
    (close-case case)
    (assert
     (handler-case
         (progn
           (swank::call-with-connection-thread
            connection (lambda () (incf calls) (error "Creator ran after close.")))
           nil)
       (swank::connection-closed (condition)
         (eq (swank::connection-closed.connection condition) connection))))
    (assert (zerop calls))
    (close-case case)
    (finish-case)))

(defun spawn-before-close-test ()
  (let* ((case (new-case :spawn-before-close))
         (connection (getf case :connection))
         (admitted (sup:make-event :name "Owned spawn admitted"))
         (release (sup:make-event :name "Owned constructor release"))
         (closing (sup:make-event :name "Close requested"))
         (hold (sup:make-event :name "Owned worker hold")))
    (setf (getf case :release) release
          (getf case :hold) hold
          (getf case :creator)
          (sup:make-thread
           (lambda ()
             (swank::call-with-open-connection
              connection
              (lambda ()
                (setf (sup:event-state admitted) t)
                (sup:event-wait release)
                (setf (getf case :worker)
                      (swank::spawn-connection-thread
                       connection (lambda () (sup:event-wait hold))
                       :name "Admitted connection worker")))))
           :name "Owned connection constructor"))
    (await (lambda () (sup:event-state admitted)))
    (setf (getf case :closer)
          (sup:make-thread
           (lambda ()
             (setf (sup:event-state closing) t)
             (close-case case))
           :name "Owned connection closer"))
    (await (lambda () (sup:event-state closing)))
    (assert (swank::connection-open-p connection))
    (setf (sup:event-state release) t)
    (await (lambda () (dead-p (getf case :creator))))
    (await (lambda () (dead-p (getf case :closer))))
    (assert (getf case :worker))
    (await (lambda () (dead-p (getf case :worker))))
    (finish-case)))

(defun repeated-helper-test ()
  (let* ((case (new-case :repeated-helpers))
         (connection (getf case :connection))
         (first (swank-repl::spawn-repl-thread connection "First owned REPL"))
         (second (swank-repl::spawn-repl-thread connection "Second owned REPL")))
    (swank-repl::open-streams connection nil)
    (let ((first-flush (swank::mconn.auto-flush-thread connection)))
      (swank-repl::open-streams connection nil)
      (let* ((second-flush (swank::mconn.auto-flush-thread connection))
             (threads (list first second first-flush second-flush)))
        (setf (getf case :threads) threads)
        (assert (not (eq first second)))
        (assert (not (eq first-flush second-flush)))
        (assert (every (lambda (thread) (member thread (owned-threads connection)))
                       threads))
        (close-case case)
        (await (lambda () (every #'dead-p threads)))))
    (finish-case)))

(defclass close-error-stream (gray:fundamental-character-output-stream)
  ((failure :initarg :failure :reader close-failure)
   (calls :initform 0 :accessor close-calls)))

(defmethod close ((stream close-error-stream) &key abort)
  (incf (close-calls stream))
  (call-next-method stream :abort abort)
  (error (close-failure stream)))

(defun cleanup-error-test ()
  (let* ((case (new-case :cleanup-errors))
         (failure (make-condition 'simple-error :format-control "Owned close failure."))
         (hook-failure (make-condition 'simple-error
                                       :format-control "Owned hook failure."))
         (stream (make-instance 'close-error-stream :failure failure))
         (dedicated (make-string-output-stream))
         (connection (swank::make-multithreaded-connection
                      :socket nil :socket-io stream :communication-style :spawn))
         (hooks 0))
    (setf (getf case :connection) connection
          (getf case :expected-failures) (list failure hook-failure)
          (swank::connection.dedicated-output connection) dedicated)
    (assert
     (handler-case
         (progn
           (close-case case (lambda (closed)
                              (assert (eq closed connection))
                              (incf hooks)
                              (error hook-failure))
                       (lambda (closed)
                         (assert (eq closed connection))
                         (setf (getf case :later-hook-ran) t)))
           nil)
       (swank::connection-cleanup-error (condition)
         (setf (getf case :observed-failure) condition)
         (and (eq (swank::connection-cleanup-error.connection condition) connection)
              (equal (swank::connection-cleanup-error.conditions condition)
                     (getf case :expected-failures))))))
    (assert (= hooks 1))
    (assert (getf case :later-hook-ran))
    (assert (= (close-calls stream) 1))
    (assert (not (open-stream-p dedicated)))
    (close-case case (lambda (closed) (declare (ignore closed)) (incf hooks)))
    (assert (= hooks 1))
    (assert (= (close-calls stream) 1))
    (finish-case)))

(defun current-thread-test ()
  (let* ((case (new-case :current-owned-thread))
         (connection (getf case :connection))
         (release (sup:make-event :name "Current owned close release"))
         (hold (sup:make-event :name "Current owned close hold")))
    (setf (getf case :release) release
          (getf case :hold) hold)
    (swank::register-connection connection)
    (setf (getf case :worker)
          (swank::spawn-connection-thread
           connection
           (lambda ()
             (unwind-protect
                  (progn
                    (sup:event-wait release)
                    (assert
                     (handler-case (progn (close-case case) nil)
                       (simple-error (condition)
                         (setf (getf case :rejection) condition)
                         (equal (simple-condition-format-control condition)
                                "Owned SWANK threads must use CLOSE-CONNECTION."))))
                    (assert (swank::connection-open-p connection))
                    (assert (open-stream-p (swank::connection.socket-io connection)))
                    (assert (member (sup:current-thread) (owned-threads connection)))
                    (assert (member connection swank::*connections*))
                    (setf (getf case :rejected-while-live) t)
                    (swank::close-connection connection nil nil)
                    (sup:event-wait hold))
               (assert (not (swank::connection-open-p connection)))
               (incf (getf case :cleanup))))
           :name "Owned close requester")
          (sup:event-state release) t)
    (await (lambda () (dead-p (getf case :worker))))
    (assert (getf case :rejected-while-live))
    (assert (= (getf case :cleanup) 1))
    (await (lambda () (not (open-stream-p (swank::connection.socket-io connection)))))
    (await (lambda () (not (member connection swank::*connections*))))
    (finish-case)))

(defun stopped-body ()
  (let ((case *case*))
    (setf (getf case :worker) (sup:current-thread)
          (getf case :owner) swank::*emacs-connection*)
    (unwind-protect
         (error "Owned raw SWANK connection test stop.")
      (incf (getf case :cleanup))
      (setf swank::*send-counter* swank::send-counter-limit)
      (swank::send-to-emacs '(:write-string "Owned unwind output."))
      (swank::ping-pong)
      (setf (getf case :unwind-complete) t))))

(defun start-loopback-sldb (name)
  (assert (null *case*))
  (let* ((case (setf *case* (make-case-state name)))
         (listener (setf (getf case :listener) (tcp:tcp-listen "127.0.0.1" 0)))
         (client (setf (getf case :client)
                       (tcp:tcp-stream-connect
                        "127.0.0.1" (tcp::tcp-listener-local-port listener)
                        :element-type '(unsigned-byte 8)
                        :connect-timeout 5 :timeout 20))))
    (let* ((peer (await (lambda ()
                          (tcp:tcp-accept listener :wait-p nil
                                         :element-type '(unsigned-byte 8)))))
           (connection (swank::make-connection listener peer :spawn)))
      (setf (getf case :connection) connection
            (getf case :peer) peer)
      (swank::serve-requests connection)
      (swank/rpc:write-message
       '(:emacs-rex
         (swank:eval-and-grab-output
          "(lispm-swank-connection-cleanup-test::stopped-body)")
         "CL-USER" t 1)
       swank::*swank-io-package* client)
      (loop repeat 30
            for message = (swank/rpc:read-message client swank::*swank-io-package*)
            when (eq (first message) :debug-activate)
              do (assert (eq (swank/backend:find-thread (second message))
                             (getf case :worker)))
                 (return)
            when (eq (first message) :ping)
              do (swank/rpc:write-message
                  (list :emacs-pong (second message) (third message))
                  swank::*swank-io-package* client)
            finally (error "Owned worker did not enter SLDB."))
      (assert (eq connection (getf case :owner)))
      (setf (getf case :threads) (owned-threads connection))
      (assert (member (getf case :worker) (getf case :threads)))
      case)))

(defun await-loopback-shutdown (case)
  (let ((connection (getf case :connection))
        (threads (getf case :threads)))
    (assert (member (getf case :worker) threads))
    (await (lambda () (not (swank::connection-open-p connection))))
    (await (lambda () (every #'dead-p threads)))
    (await (lambda () (not (member connection swank::*connections*))))
    (assert (= (getf case :cleanup) 1))
    (assert (getf case :unwind-complete))
    (assert (null (owned-threads connection)))))

(defun loopback-sldb-test ()
  (let ((case (start-loopback-sldb :tcp-sldb-disconnect)))
    (close (getf case :client) :abort t)
    (await-loopback-shutdown case)
    (tcp:close-tcp-listener (getf case :listener))
    (finish-case)))

(defun check-parked-tcp (stream boot)
  (let ((connection (tcp::tcp-stream-connection stream)))
    (tcp::with-tcp-connection-locked connection
      (assert (eq (tcp::tcp-connection-boot-id connection) boot))
      (assert (eq (tcp::tcp-connection-state connection) :established))
      (assert (null (tcp::tcp-connection-pending-error connection))))))

(defun stale-tcp-p (stream)
  (let ((connection (tcp::tcp-stream-connection stream)))
    (tcp::with-tcp-connection-locked connection
      (and (eq (tcp::tcp-connection-state connection) :closed)
           (typep (tcp::tcp-connection-pending-error connection)
                  'tcp::connection-stale)))))

(defun prepare-restore ()
  (let* ((case (start-loopback-sldb :tcp-sldb-restore))
         (connection (getf case :connection))
         (threads (getf case :threads))
         (boot (sup:current-boot-id)))
    (setf (getf case :boot) boot
          (tcp:tcp-connection-timeout
           (tcp::tcp-stream-connection (getf case :client))) nil)
    (check-parked-tcp (getf case :client) boot)
    (check-parked-tcp (getf case :peer) boot)
    (assert (zerop (getf case :cleanup)))
    (assert (not (getf case :unwind-complete)))
    (assert (swank::connection-open-p connection))
    (assert (member connection swank::*connections*))
    (assert (eq connection (getf case :owner)))
    (assert (every (lambda (thread) (member thread threads))
                   (list (getf case :worker)
                         (swank::mconn.control-thread connection)
                         (swank::mconn.reader-thread connection)
                         (swank::mconn.indentation-cache-thread connection))))
    (assert (every #'swank/backend:thread-alive-p threads))
    (assert (eq boot (sup:current-boot-id)))
    (values t (list :owned-threads (length threads)
                    :worker-id (swank/backend:thread-id (getf case :worker))
                    :cleanup 0))))

(defun finish-restore ()
  (let* ((case *case*)
         (threads (getf case :threads)))
    (assert (eq (getf case :name) :tcp-sldb-restore))
    (assert (getf case :boot))
    (assert (not (eq (getf case :boot) (sup:current-boot-id))))
    (await (lambda () (stale-tcp-p (getf case :client))))
    (await (lambda () (stale-tcp-p (getf case :peer))))
    (await-loopback-shutdown case)
    (close (getf case :client) :abort t)
    (tcp:close-tcp-listener (getf case :listener))
    (finish-case)
    (values t (list :boot-changed t :stale t
                    :owned-threads (length threads) :cleanup 1))))

(defun run ()
  (assert (null *case*))
  (normal-exit-test)
  (borrowed-thread-test)
  (close-before-spawn-test)
  (spawn-before-close-test)
  (repeated-helper-test)
  (cleanup-error-test)
  (current-thread-test)
  (loopback-sldb-test)
  t)
