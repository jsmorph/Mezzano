(load (merge-pathnames "debugger-client.lisp" *load-truename*))
(defpackage #:lispm-remote-restore-test (:use #:cl #:lispm-debugger-client))
(in-package #:lispm-remote-restore-test)

(defvar *port*)
(defvar *state-path*)

(defun connected (session function)
  (call-with-session session function :port *port* :seconds 180))

(defun evaluate (source)
  (call-rpc (format nil "(swank:eval-and-grab-output ~S)" source)))

(defun expect-error (reason function)
  (handler-case
      (progn (funcall function) (error "Expected ~S." reason))
    (request-error (condition)
      (assert (eq reason (request-error-reason condition))))))

(defun await (function)
  (let ((deadline (+ (get-internal-real-time) (* 20 internal-time-units-per-second))))
    (loop
      (let ((result (funcall function)))
        (when result (return result)))
      (when (> (get-internal-real-time) deadline) (error "Restore test timed out."))
      (sleep 0.01))))

(defun target-stop ()
  (find-if (lambda (stop)
             (equal (getf (request :information stop) :thread) "Debugger remote restore test"))
           (request :stops)))

(defun result (stop id)
  (await (lambda ()
           (let ((result (request :result stop id)))
             (unless (member (getf result :state) '(:pending :running))
               result)))))

(defun command (stop lease operation &optional argument)
  (let ((id (getf (request :information stop) :next-command-id)))
    (request :submit lease id operation argument)
    (let ((result (result stop id)))
      (assert (eq (getf result :state) :returned))
      (getf result :result))))

(defun application-frame (frames)
  (getf (find-if (lambda (entry) (search "CALL-MISSING" (getf entry :function))) frames)
        :frame))

(defun prepare ()
  (let ((early (make-session))
        (late (make-session))
        (state nil))
    (connected
     early
     (lambda ()
       (evaluate "(load (compile-file \"SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE.LISP\"))")
       (evaluate "(defparameter lispm-service-test::*remote-thread* (lispm-service-test::start-test-thread \"Debugger remote restore test\"))")
       (let* ((stop (await #'target-stop))
              (lease (request :attach stop))
              (frame (application-frame (command stop lease :frames))))
         (assert frame)
         (setf state (list :early (session-name early) :late (session-name late)
                           :stop stop :lease lease :frame frame))
         (evaluate "(mezzano.supervisor:snapshot) (mezzano.supervisor:wait-for-snapshot-completion) (values)"))))
    (connected late (lambda () (assert (target-stop))))
    (with-open-file (stream *state-path* :direction :output :if-exists :supersede)
      (let ((*print-readably* t)) (write state :stream stream)))
    (format t "Prepared a stopped thread, a session saved in the image, and a session created after the snapshot.~%")))

(defun finish ()
  (let ((state (with-open-file (stream *state-path*)
                 (let ((*read-eval* nil)) (read stream)))))
    (dolist (key '(:early :late))
      (expect-error :expired-session
                    (lambda () (connected (make-session :resume (getf state key))
                                          (lambda () nil)))))
    (connected
     (make-session)
     (lambda ()
       (evaluate
        "(swank/mezzano-debugger::with-lock
           (maphash
            (lambda (name session)
              (declare (ignore name))
              (unless (eq (swank/mezzano-debugger::session-boot session)
                          (mezzano.supervisor:current-boot-id))
                (assert (swank/mezzano-debugger::session-released-p session))
                (assert (null (swank/mezzano-debugger::session-controller session)))
                (assert (null (swank/mezzano-debugger::session-connection session)))
                (assert (zerop (hash-table-count
                                (swank/mezzano-debugger::session-handles session))))
                (assert (zerop (hash-table-count
                                (swank/mezzano-debugger::session-objects session))))
                (assert (zerop (hash-table-count
                                (swank/mezzano-debugger::session-stops session))))))
            swank/mezzano-debugger::*sessions*))
         (values)")
       (expect-error :invalid-handle
                     (lambda () (request :information (getf state :stop))))
       (let* ((stop (target-stop))
              (lease (request :attach stop))
              (old-result (request :result stop 0)))
         (assert stop)
         (assert (null (getf old-result :current-boot-p)))
         (expect-error :invalid-handle
                       (lambda () (request :submit lease 1 :locals (getf state :frame))))
         (expect-error :expired-stop
                       (lambda () (request :submit lease 1 :locals
                                           (application-frame (getf old-result :result)))))
         (let ((frame (application-frame (command stop lease :frames))))
           (assert frame)
           (evaluate "(mezzano.extensions:gc :full t) (values)")
           (let ((locals (command stop lease :locals frame)))
             (dolist (value '("111" "222"))
               (assert (find value locals :key (lambda (entry) (getf entry :value))
                                         :test #'equal)))))
         (evaluate "(setf (symbol-function 'lispm-service-test::missing) (compile nil '(lambda (a b object) (declare (ignore object)) (values (+ a b) :remote-restored)))) (values)")
         (let* ((restarts (command stop lease :restarts))
                (continue (getf (find "CONTINUE" restarts
                                     :key (lambda (entry) (getf entry :name))
                                     :test #'string=)
                               :index))
                (id (getf (request :information stop) :next-command-id)))
           (assert continue)
           (request :submit lease id :invoke-restart continue)
           (assert (eq (getf (result stop id) :state) :unwound)))
         (assert (equal (evaluate "(mezzano.supervisor:thread-join lispm-service-test::*remote-thread*)")
                        (list "" (format nil "(333 :REMOTE-RESTORED)~%T"))))
         (assert (equal (evaluate "lispm-service-test::*cleanup-count*") '("" "1")))
         (request :release-stop lease)
         (request :release-session))))
    (format t "PASS SWANK session expiration across restore, old wire and frame handles, retained stop, locals after GC, restart, and cleanup~%")))

(destructuring-bind (mode port path) (cdr sb-ext:*posix-argv*)
  (let ((*port* (parse-integer port))
        (*state-path* path))
    (cond ((string= mode "prepare") (prepare))
          ((string= mode "finish") (finish))
          (t (error "Expected prepare or finish.")))))
