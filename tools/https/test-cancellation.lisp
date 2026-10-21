(defpackage :lispm-cancellation-test
  (:use :cl)
  (:export :run))
(in-package :lispm-cancellation-test)

(defun monitors ()
  (count "cancel-stream-monitor" (bordeaux-threads:all-threads)
         :key #'bordeaux-threads:thread-name :test #'equal))

(defun call-with-pair (function)
  (let ((listener (usocket:socket-listen "127.0.0.1" 0 :element-type '(unsigned-byte 8)))
        (client nil)
        (server nil))
    (unwind-protect
         (progn
           (setf client (usocket:socket-connect
                         "127.0.0.1" (usocket:get-local-port listener)
                         :element-type '(unsigned-byte 8) :timeout 2))
           (setf server (usocket:socket-accept listener :element-type '(unsigned-byte 8)))
           (funcall function (usocket:socket-stream client) (usocket:socket-stream server)))
      (when client (close (usocket:socket-stream client) :abort t))
      (when server (close (usocket:socket-stream server) :abort t))
      (usocket:socket-close listener))))

(defun gc-time ()
  #+mezzano mezzano.internals::*gc-time*
  #-mezzano 0)

(defun check-elapsed-time (elapsed gc minimum)
  (format t "Cancellation elapsed ~S seconds, including ~S seconds of GC.~%" elapsed gc)
  (assert (and (<= minimum elapsed) (<= (- elapsed gc) 3)) ()
          "Cancellation elapsed ~S seconds, including ~S seconds of GC." elapsed gc))

(defun timed-cancellation (function &optional (condition-type 'error))
  (let ((start (get-internal-real-time))
        (gc (gc-time)))
    (cl-cancel:with-timeout-context (context 0.1)
      (assert
       (handler-case (progn (funcall function context) nil)
         (error (condition)
           (assert (typep condition condition-type) ()
                   "Expected ~S, received ~A." condition-type condition)
           (assert (typep (cl-cancel:err context) 'cl-cancel:deadline-exceeded)
                   () "Unexpected failure before deadline: ~A" condition)
           t))))
    (let ((elapsed (/ (- (get-internal-real-time) start) internal-time-units-per-second)))
      (check-elapsed-time elapsed (- (gc-time) gc) 9/100))))

(defclass failing-close-stream (trivial-gray-streams:fundamental-binary-input-stream)
  ((attempted :initform nil :accessor attempted)))
(define-condition close-failure (error) ())
(defmethod close ((stream failing-close-stream) &key abort)
  (declare (ignore abort))
  (setf (attempted stream) t)
  (error 'close-failure))

(defun deadline-tests ()
  (let ((start (get-internal-real-time))
        (previous (cl-cancel:get-current-time)))
    (loop while (< (- (get-internal-real-time) start) (* 2 internal-time-units-per-second))
          do (let ((now (cl-cancel:get-current-time)))
               (assert (>= now previous) () "Clock moved backward.")
               (setf previous now))
             (sleep 0.005)))
  (dolist (duration '(1/4 0.25 0.25d0))
    (let ((start (get-internal-real-time))
          (gc (gc-time))
          (before (cl-cancel:get-current-time)))
      (cl-cancel:with-timeout-context (context duration)
        (let ((deadline (cl-cancel:deadline context))
              (after (cl-cancel:get-current-time)))
          (assert (rationalp deadline))
          (assert (<= (+ before (rational duration))
                      deadline
                      (+ after (rational duration)))))
        (cl-cancel:wait-until-done context 3)
        (assert (typep (cl-cancel:err context) 'cl-cancel:deadline-exceeded)))
      (let ((elapsed (/ (- (get-internal-real-time) start) internal-time-units-per-second)))
        (check-elapsed-time elapsed (- (gc-time) gc) 6/25)))))

(defun collection-cancellation-test ()
  (dolist (elapsed '(0 4))
    (assert (handler-case
                (progn (check-elapsed-time elapsed 0 9/100) nil)
              (error () t))))
  #+mezzano
  (let ((cycles mezzano.internals::*gc-major-cycles*))
    (timed-cancellation
     (lambda (context)
       (mezzano.internals::gc :full t)
       (cl-cancel:wait-until-done context 3)
       (pure-tls::check-tls-context context))
     'pure-tls::tls-deadline-exceeded)
    (assert (< cycles mezzano.internals::*gc-major-cycles*))))

(defun tls-initialization-tests ()
  (let ((pure-tls::*default-tls-context* nil))
    (let ((context (pure-tls::ensure-default-context pure-tls:+verify-none+)))
      (assert (= pure-tls:+verify-required+
                 (pure-tls::tls-context-verify-mode context)))
      (assert (null (pure-tls::tls-context-trust-store context))))
    (let ((context (pure-tls::ensure-default-context)))
      (assert (pure-tls::tls-context-trust-store context))
      (assert (eq context (pure-tls::ensure-default-context)))))
  (let ((pure-tls::*default-tls-context* nil))
    (timed-cancellation
     (lambda (context)
       (let ((cl-cancel:*current-cancel-context* context))
         (pure-tls::ensure-default-context)))
     'pure-tls::tls-deadline-exceeded)
    (assert (null pure-tls::*default-tls-context*)))
  (dolist (verify (list pure-tls:+verify-none+ pure-tls:+verify-required+))
    (call-with-pair
     (lambda (client server)
       (declare (ignore server))
       (let ((pure-tls::*default-tls-context* nil))
         (cl-cancel:with-cancel-context (context (cl-cancel:background))
           (cl-cancel:cancel context)
           (assert
            (handler-case
                (progn
                  (pure-tls:make-tls-client-stream client :hostname "localhost"
                                                        :verify verify
                                                        :request-context context)
                  nil)
              (pure-tls::tls-context-cancelled () t))))
         (assert (null pure-tls::*default-tls-context*)))
       (assert (not (open-stream-p client))))))
  t)

(defun tls-client-ownership-tests ()
  (let ((baseline (monitors)))
    (call-with-pair
     (lambda (client server)
       (declare (ignore server))
       (let ((pure-tls::*default-tls-context* nil))
         (timed-cancellation
          (lambda (context)
            (let ((cl-cancel:*current-cancel-context* context))
              (pure-tls:make-tls-client-stream client :hostname "localhost"
                                                    :verify pure-tls:+verify-none+)))))
       (assert (not (open-stream-p client)))))
    (assert (= baseline (monitors)))
    (call-with-pair
     (lambda (client server)
       (declare (ignore server))
       (let ((missing (merge-pathnames "tls-test-absent-client-certificate.pem"
                                       (user-homedir-pathname))))
         (assert (not (probe-file missing)))
         (cl-cancel:with-cancel-context (context (cl-cancel:background))
           (assert
            (handler-case
                (progn
                  (pure-tls:make-tls-client-stream client :hostname "localhost"
                                                        :verify pure-tls:+verify-none+
                                                        :client-certificate missing
                                                        :request-context context)
                  nil)
              (file-error () t)))))
       (assert (not (open-stream-p client)))))
    (assert (= baseline (monitors))))
  t)

(defun run ()
  (deadline-tests)
  (collection-cancellation-test)
  (let ((baseline (monitors)))
    (tls-initialization-tests)
    (tls-client-ownership-tests)
    (assert (= baseline (monitors)))
    (cl-cancel:with-cancel-context (parent (cl-cancel:background))
      (let* ((stream (make-string-output-stream))
             (cleanup (cl-cancel:close-stream-on-cancel stream parent)))
        (funcall cleanup)
        (assert (not (cl-cancel:done-p parent)))
        (assert (open-stream-p stream))
        (cl-cancel:cancel parent)
        (assert (open-stream-p stream))
        (close stream)))
    (assert (= baseline (monitors)))
    (let ((stream (make-instance 'failing-close-stream)))
      (cl-cancel:with-cancel-context (parent (cl-cancel:background))
        (let ((cleanup (cl-cancel:close-stream-on-cancel stream parent)))
          (cl-cancel:cancel parent)
          (let ((deadline (+ (get-internal-real-time) (* 3 internal-time-units-per-second))))
            (loop until (attempted stream)
                  do (assert (< (get-internal-real-time) deadline))
                     (sleep 0.01)))
          (assert (handler-case (progn (funcall cleanup) nil)
                    (close-failure () t))))))
    (assert (= baseline (monitors)))
    (call-with-pair
     (lambda (client server)
       (declare (ignore server))
       (timed-cancellation
        (lambda (context)
          (let ((cleanup (cl-cancel:close-stream-on-cancel client context)))
            (unwind-protect (read-byte client)
              (funcall cleanup)))))
       (assert (not (open-stream-p client)))))
    (assert (= baseline (monitors)))
    (call-with-pair
     (lambda (client server)
       (declare (ignore server))
       (let ((pure-tls::*default-tls-context* nil))
         (timed-cancellation
          (lambda (context)
            (pure-tls:make-tls-client-stream client :hostname "localhost"
                                                  :verify pure-tls:+verify-none+
                                                  :request-context context)))
         (assert (null (pure-tls::tls-context-trust-store
                        pure-tls::*default-tls-context*))))
       (assert (not (open-stream-p client)))))
    (call-with-pair
     (lambda (client server)
       (declare (ignore server))
       (let ((pure-tls::*default-tls-context* nil))
         (timed-cancellation
          (lambda (context)
            (pure-tls:make-tls-client-stream client :hostname "localhost"
                                                  :verify pure-tls:+verify-required+
                                                  :request-context context))
          'pure-tls::tls-deadline-exceeded)
         (assert (null pure-tls::*default-tls-context*)))
       (assert (not (open-stream-p client)))))
    (assert (= baseline (monitors))))
  (format t "PASS cancellation, fresh TLS initialization, CA deadlines, close errors, and blocked I/O.~%")
  t)
(in-package :cl-user)
