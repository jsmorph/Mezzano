(load (merge-pathnames "debugger-client.lisp" *load-truename*))
(defpackage #:lispm-reconnect-test (:use #:cl #:lispm-debugger-client))
(in-package #:lispm-reconnect-test)

(defparameter *port*
  (if (cdr sb-ext:*posix-argv*) (parse-integer (second sb-ext:*posix-argv*)) 4005))

(defun connected (session function)
  (call-with-session session function :port *port* :seconds 120))

(defun evaluate (source)
  (call-rpc (format nil "(swank:eval-and-grab-output ~S)" source)))

(defun await (function)
  (let ((deadline (+ (get-internal-real-time) (* 20 internal-time-units-per-second))))
    (loop
      (let ((result (funcall function)))
        (when result (return result)))
      (when (> (get-internal-real-time) deadline) (error "Reconnect test timed out."))
      (sleep 0.01))))

(defun expect-error (reason function)
  (handler-case
      (progn (funcall function) (error "Expected ~S." reason))
    (request-error (condition)
      (assert (eq reason (request-error-reason condition))))))

(defun target-stop ()
  (find-if (lambda (stop)
             (equal (getf (request :information stop) :thread) "Debugger reconnect test"))
           (request :stops)))

(defun command (stop lease operation &optional argument)
  (let ((id (getf (request :information stop) :next-command-id)))
    (request :submit lease id operation argument)
    (getf (await (lambda ()
                  (let ((reply (request :result stop id)))
                    (when (eq (getf reply :state) :returned) reply))))
          :result)))

(defun restart-index (stop lease name)
  (let ((entry (find name (command stop lease :restarts)
                     :key (lambda (entry) (getf entry :name))
                     :test #'string=)))
    (assert entry)
    (getf entry :index)))

(defun run-tests ()
  (let ((session (make-session))
        (observer (make-session))
        (stop nil)
        (lease nil)
        (old-lease nil)
        (frame nil)
        (probe nil)
        (probe-id nil)
        (continue nil)
        (continue-id nil))
    (unwind-protect
         (progn
           (connected
            session
            (lambda ()
              (evaluate "(load (compile-file \"SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE.LISP\"))")
              (evaluate "(defparameter lispm-service-test::*remote-thread* (lispm-service-test::start-test-thread \"Debugger reconnect test\"))")
              (setf stop (await #'target-stop)
                    old-lease (request :attach stop))
              (assert (zerop (getf (request :information stop) :next-command-id)))
              (connected
               observer
               (lambda ()
                 (expect-error :invalid-handle (lambda () (request :information stop)))
                 (expect-error :already-controlled
                               (lambda () (request :attach (target-stop))))))))
           (connected
            session
            (lambda ()
              (setf lease (request :attach stop))
              (expect-error :expired-controller (lambda () (request :submit old-lease 0 :frames)))
              (let ((frames (command stop lease :frames)))
                (setf frame
                      (getf (find-if (lambda (entry)
                                       (search "CALL-MISSING" (getf entry :function)))
                                     frames)
                            :frame)))
              (assert frame)
              (evaluate "(mezzano.extensions:gc :full t) (values)")
              (let ((locals (command stop lease :locals frame)))
                (dolist (value '("111" "222"))
                  (assert (find value locals :key (lambda (entry) (getf entry :value))
                                            :test #'equal))))
              (setf probe (restart-index stop lease "LISPM-SERVICE-TEST::PROBE")
                    probe-id (getf (request :information stop) :next-command-id))
              (send-request :submit lease probe-id :invoke-restart probe)
              (connected
               observer
               (lambda ()
                 (await (lambda ()
                          (equal (evaluate "lispm-service-test::*probe-count*")
                                 '("" "1"))))))))
           (connected
            session
            (lambda ()
              (setf lease (request :attach stop))
              (assert (eq (getf (request :result stop probe-id) :state) :running))
              (assert (= (request :submit lease probe-id :invoke-restart probe) probe-id))
              (expect-error :request-conflict
                            (lambda () (request :submit lease probe-id :frames)))
              (evaluate "(setf (mezzano.supervisor:event-state lispm-service-test::*probe-gate*) t) (values)")
              (let ((result (await (lambda ()
                                     (let ((result (request :result stop probe-id)))
                                       (when (eq (getf result :state) :returned) result))))))
                (assert (equal (getf result :result) '("42" ":PROBE"))))
              (request :submit lease probe-id :invoke-restart probe)
              (assert (equal (evaluate "lispm-service-test::*probe-count*") '("" "1")))
              (evaluate "(setf (symbol-function 'lispm-service-test::missing) (compile nil '(lambda (a b object) (declare (ignore object)) (values (+ a b) :resumed)))) (values)")
              (setf continue (restart-index stop lease "CONTINUE")
                    continue-id (getf (request :information stop) :next-command-id))
              (send-request :submit lease continue-id :invoke-restart continue)
              (connected
               observer
               (lambda ()
                 (await (lambda ()
                          (equal (evaluate "lispm-service-test::*cleanup-count*")
                                 '("" "1"))))))))
           (connected
            session
            (lambda ()
              (setf lease (request :attach stop))
              (assert (eq (getf (request :information stop) :state) :closed))
              (assert (eq (getf (request :result stop continue-id) :state) :unwound))
              (assert (= (request :submit lease continue-id :invoke-restart continue)
                         continue-id))
              (assert (equal (evaluate "(mezzano.supervisor:thread-join lispm-service-test::*remote-thread*)")
                             (list "" (format nil "(333 :RESUMED)~%T"))))
              (assert (equal (evaluate "lispm-service-test::*cleanup-count*") '("" "1")))
              (expect-error :stop-closed
                            (lambda () (request :submit lease (1+ continue-id) :locals frame)))
              (request :release-stop lease)
              (expect-error :released-stop (lambda () (request :information stop)))
              (request :release-session)))
           (expect-error :expired-session (lambda () (connected session (lambda () nil))))
           (connected observer (lambda () (request :release-session)))
           (format t "PASS SWANK disconnect before commands, lost restart replies, reconnect, exclusive control, stale and foreign handles, at-most-once restart execution, application values, and cleanup~%"))
      (when stop
        (let ((cleanup (make-session)))
          (connected
           cleanup
           (lambda ()
             (evaluate "(when (boundp 'lispm-service-test::*remote-thread*) (unless (nth-value 1 (mezzano.supervisor:thread-join lispm-service-test::*remote-thread* nil)) (mezzano.supervisor:terminate-thread lispm-service-test::*remote-thread*))) (values)")
             (request :release-session))))))))

(run-tests)
