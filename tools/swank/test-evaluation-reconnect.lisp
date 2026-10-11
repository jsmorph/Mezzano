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

(defun prepare-restore (path)
  (let ((session (make-session))
        (name (fresh-name))
        (complete-name (fresh-name))
        (source "(incf cl-user::*evaluation-restore-count*)
                 (unwind-protect
                      (let ((first (read-line)))
                        (write-string first)
                        (cerror \"Continue the restored job.\" \"Evaluation restore stop.\")
                        (values first (read-line)
                                (read-line *standard-input* nil :eof)
                                cl-user::*evaluation-restore-count*))
                   (incf cl-user::*evaluation-restore-cleanup*))"))
    (connected
     session
     (lambda ()
       (evaluate "(defparameter cl-user::*evaluation-restore-count* 0)
                  (defparameter cl-user::*evaluation-restore-cleanup* 0)
                  (values)")
       (let ((finished (request :start-evaluation complete-name
                                "(write-string \"completed\") (values 17 :complete)"))
             (job (request :start-evaluation name source :input (format nil "one~%two"))))
         (assert (eq (getf (completed finished) :state) :returned))
         (await (lambda () (getf (request :job-information job) :stops)))
         (assert (equal (request :job-output job 0) '(:text "one" :end 3)))
         (evaluate
          (format nil
                  "(defparameter cl-user::*evaluation-restore-old-handle*
                     (find ~S (mezzano.debug:evaluation-jobs)
                           :key (lambda (job)
                                  (getf (mezzano.debug:evaluation-job-information job) :name))
                           :test #'equal)) (values)"
                  name))
         (with-open-file (out path :direction :output :if-exists :supersede)
           (let ((*print-readably* t))
             (write (list :session (session-name session) :name name
                          :complete-name complete-name :source source :token job)
                    :stream out)
             (terpri out)))
         (evaluate "(mezzano.supervisor:snapshot)
                    (mezzano.supervisor:wait-for-snapshot-completion)
                    (values)"))))
    (format t "Prepared completed and stopped evaluation jobs for restore.~%")))

(defun finish-restore (path)
  (let* ((state (with-open-file (in path)
                  (let ((*read-eval* nil)) (read in))))
         (fresh (make-session)))
    (expect-error :expired-session
                  (lambda ()
                    (connected (make-session :resume (getf state :session))
                               (lambda () nil))))
    (connected
     fresh
     (lambda ()
       (expect-error :invalid-handle
                     (lambda () (request :job-information (getf state :token))))
       (assert
        (equal
         (evaluate
          "(handler-case
               (mezzano.debug:evaluation-job-information
                cl-user::*evaluation-restore-old-handle*)
             (mezzano.debug:debugger-service-error (condition)
               (mezzano.debug:debugger-service-error-reason condition)))")
         '("" ":EXPIRED-JOB")))
       (evaluate
        "(maphash
          (lambda (name session)
            (declare (ignore name))
            (unless (eq (swank/mezzano-debugger::session-boot session)
                        (mezzano.supervisor:current-boot-id))
              (assert (zerop (hash-table-count
                              (swank/mezzano-debugger::session-jobs session))))))
          swank/mezzano-debugger::*sessions*)
         (values)")
       (let* ((job (find-job (getf state :name)))
              (finished (find-job (getf state :complete-name)))
              (info (request :job-information job))
              (stop (first (getf info :stops)))
              (lease (request :attach stop)))
         (assert (eq (getf info :state) :running))
         (assert (null (getf info :current-boot-p)))
         (assert (equal (request :job-output job 0) '(:text "one" :end 3)))
         (let ((info (request :job-information finished)))
           (assert (eq (getf info :state) :returned))
           (assert (null (getf info :current-boot-p)))
           (assert (equal (getf info :values) '("17" ":COMPLETE"))))
         (assert (equal (request :job-output finished 0)
                        '(:text "completed" :end 9)))
         (expect-error :request-conflict
                       (lambda ()
                         (request :start-evaluation (getf state :name)
                                  (getf state :source) :input (format nil "one~%two"))))
         (evaluate "(mezzano.extensions:gc :full t) (values)")
         (let* ((restarts (getf (command stop lease :restarts) :result))
                (restart (find "CONTINUE" restarts
                               :key (lambda (entry) (getf entry :name))
                               :test #'equal)))
           (assert restart)
           (assert (eq (getf (command stop lease :invoke-restart (getf restart :index))
                            :state)
                       :unwound)))
         (let ((info (completed job)))
           (assert (eq (getf info :state) :returned))
           (assert (null (getf info :current-boot-p)))
           (assert (equal (getf info :values) '("\"one\"" "\"two\"" ":EOF" "1"))))
         (assert (equal (evaluate "cl-user::*evaluation-restore-cleanup*") '("" "1")))
         (request :release-stop lease)
         (request :release-job job)
         (request :release-job finished)
         (request :release-session))))
    (format t "PASS evaluation restore, completed results, output, input position, expired handles, rejected replay, retired token tables, GC, continuation, and cleanup~%")))

(let ((mode (or (third sb-ext:*posix-argv*) "run"))
      (path (fourth sb-ext:*posix-argv*)))
  (cond ((string= mode "run") (run-tests))
        ((string= mode "prepare") (assert path) (prepare-restore path))
        ((string= mode "finish") (assert path) (finish-restore path))
        (t (error "Unknown evaluation test mode ~S." mode))))
