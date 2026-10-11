(load (merge-pathnames "debugger-client.lisp" *load-truename*))
(defpackage #:lispm-evaluation-reconnect-test
  (:use #:cl #:lispm-debugger-client))
(in-package #:lispm-evaluation-reconnect-test)

(defparameter *port*
  (if (cdr sb-ext:*posix-argv*) (parse-integer (second sb-ext:*posix-argv*)) 4005))

(defun connected (session function)
  (call-with-session session function :port *port* :seconds 120))

(defun evaluate (source)
  (call-rpc (format nil "(swank:eval-and-grab-output ~S)"
                    (format nil "(progn ~A)" source))))

(defun await (function)
  (let ((deadline (+ (get-internal-real-time) (* 20 internal-time-units-per-second))))
    (loop
      (let ((result (funcall function)))
        (when result (return result)))
      (when (> (get-internal-real-time) deadline)
        (error "Evaluation reconnect test timed out."))
      (sleep 0.01))))

(defun expect-error (reason function)
  (handler-case
      (progn (funcall function) (error "Expected ~S." reason))
    (request-error (condition)
      (assert (eq reason (request-error-reason condition))))))

(defun find-job (name)
  (find name (request :jobs)
        :key (lambda (job) (getf (request :job-information job) :name))
        :test #'equal))

(defun completed (job)
  (await (lambda ()
           (let ((info (request :job-information job)))
             (unless (eq (getf info :state) :running) info)))))

(defun command (stop lease operation &optional argument)
  (let ((id (getf (request :information stop) :next-command-id)))
    (request :submit lease id operation argument)
    (await (lambda ()
             (let ((result (request :result stop id)))
               (unless (member (getf result :state) '(:pending :running))
                 result))))))

(defun run-tests ()
  (let ((creator (make-session))
        (observer (make-session))
        (recovery (make-session))
        (name (fresh-name))
        (job nil)
        (source "(incf cl-user::*evaluation-remote-count*)
                 (write-string \"waiting\")
                 (mezzano.supervisor:event-wait cl-user::*evaluation-remote-gate*)
                 (write-string \"done\")
                 (values cl-user::*evaluation-remote-count*
                         (read-line) (read-line *standard-input* nil :eof))"))
    (connected
     creator
     (lambda ()
       (evaluate "(defparameter cl-user::*evaluation-remote-count* 0)
                  (defparameter cl-user::*evaluation-remote-cleanup* 0)
                  (defparameter cl-user::*evaluation-remote-gate*
                    (mezzano.supervisor:make-event))
                  (values)")
       (send-request :start-evaluation name source :input "λ")
       (connected
        observer
        (lambda ()
          (let ((observed (await (lambda () (find-job name)))))
            (await (lambda ()
                     (equal (request :job-output observed 0)
                            '(:text "waiting" :end 7)))))))))
    (connected
     creator
     (lambda ()
       (setf job (request :start-evaluation name source :input "λ"))
       (assert (equal job (find-job name)))
       (assert (equal (evaluate "cl-user::*evaluation-remote-count*") '("" "1")))
       (expect-error :request-conflict
                     (lambda () (request :start-evaluation name source :input "")))
       (request :release-session)))
    (connected
     observer
     (lambda ()
       (expect-error :invalid-handle (lambda () (request :job-information job)))
       (let ((observed (find-job name)))
         (assert observed)
         (expect-error :job-active (lambda () (request :release-job observed)))
         (evaluate "(setf (mezzano.supervisor:event-state cl-user::*evaluation-remote-gate*) t)
                    (values)")
         (let ((info (completed observed)))
           (assert (eq (getf info :state) :returned))
           (assert (equal (getf info :values) '("1" "\"λ\"" ":EOF"))))
         (assert (equal (request :job-output observed 7) '(:text "done" :end 11)))
         (assert (equal (request :job-output observed 7) '(:text "done" :end 11)))
         (request :release-job observed)
         (expect-error :released-job (lambda () (request :job-information observed)))
         (assert (null (find-job name))))
       (setf name (fresh-name)
             job (request
                  :start-evaluation name
                  "(unwind-protect
                       (progn (write-string \"before\")
                              (cerror \"Continue evaluation.\" \"Remote evaluation stopped.\")
                              (write-string \"after\")
                              (values 44 :continued))
                     (incf cl-user::*evaluation-remote-cleanup*))"))
       (await (lambda () (getf (request :job-information job) :stops)))))
    (connected
     recovery
     (lambda ()
       (let* ((recovered (find-job name))
              (stop (first (getf (request :job-information recovered) :stops)))
              (lease (request :attach stop))
              (restarts (getf (command stop lease :restarts) :result))
              (restart (find "CONTINUE" restarts
                             :key (lambda (entry) (getf entry :name))
                             :test #'equal)))
         (assert restart)
         (expect-error :invalid-handle (lambda () (request :job-information job)))
         (assert (equal (request :job-output recovered 0) '(:text "before" :end 6)))
         (evaluate "(mezzano.extensions:gc :full t) (values)")
         (assert (eq (getf (command stop lease :invoke-restart (getf restart :index))
                          :state)
                     :unwound))
         (let ((info (completed recovered)))
           (assert (eq (getf info :state) :returned))
           (assert (equal (getf info :values) '("44" ":CONTINUED"))))
         (assert (equal (request :job-output recovered 0) '(:text "beforeafter" :end 11)))
         (assert (equal (evaluate "cl-user::*evaluation-remote-cleanup*") '("" "1")))
         (request :release-stop lease)
         (request :release-job recovered)
         (request :release-session))))
    (connected observer (lambda () (request :release-session)))
    (format t "PASS unread creation reply, duplicate submission, session release during evaluation, retained output and values, fresh-session condition recovery, foreign tokens, GC, cleanup, and job release~%")))

(run-tests)
