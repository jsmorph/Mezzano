(defpackage #:lispm-debugger-interrupt-test
  (:use #:cl #:mezzano.debug)
  (:import-from #:lispm-debugger-control-test
                #:await #:fresh-name #:terminal-command #:submit #:run-command
                #:restart-index #:stopped #:wait-job)
  (:export #:run))
(in-package #:lispm-debugger-interrupt-test)

(defvar *gate* nil)
(defvar *reader-gate* nil)
(defvar *printer-entered* nil)
(defvar *reader-entered* nil)
(defvar *cycles* 0)
(defvar *printer-cleanups* 0)
(defvar *reader-cleanups* 0)
(defvar *body-cleanups* 0)
(defvar *supplied* nil)
(defvar *jobs* nil)
(defvar *leases* nil)

(define-condition computing-printer (error) ()
  (:report (lambda (condition stream)
             (declare (ignore condition))
             (unwind-protect
                  (progn
                    (setf *printer-entered* t)
                    (loop until (mezzano.supervisor:event-state *gate*)
                          do (incf *cycles*))
                    (write-string "Completed condition report." stream))
               (incf *printer-cleanups*)))))

(defun read-number ()
  (unwind-protect
       (progn
         (when *reader-gate*
           (mezzano.supervisor:without-footholds
             (setf *reader-entered* t)
             (mezzano.supervisor:event-wait *reader-gate*)))
         (format *query-io* "Number: ")
         (finish-output *query-io*)
         (list (read *query-io*)))
    (incf *reader-cleanups*)))

(defun start (source &key interactive)
  (let ((job (start-evaluation-job (fresh-name) source :interactive interactive)))
    (push job *jobs*)
    job))

(defun attach (stop controller)
  (let ((lease (attach-debugger-stop stop controller)))
    (push lease *leases*)
    lease))

(defun child-stop (parent)
  (await "debugger-command interruption"
         (lambda () (getf (debugger-stop-information parent) :child))))

(defun interrupt-result (job id)
  (await "interrupt outcome"
         (lambda ()
           (let ((result (evaluation-job-interrupt-result job id)))
             (unless (member (getf result :state) '(:pending :running))
               result)))))

(defun expect-busy (function)
  (handler-case
      (progn (funcall function) (error "Expected :INTERRUPT-BUSY."))
    (debugger-service-error (condition)
      (assert (eq (debugger-service-error-reason condition) :interrupt-busy)))))

(defun invoke-continue (stop lease)
  (run-command stop lease :invoke-restart-interactively
               (restart-index stop lease "CONTINUE")))

(defun input-waiters (job)
  (mezzano.debug::with-service-lock
    (mezzano.debug::evaluation-input-waiting-readers
     (mezzano.debug::evaluation-job-input-stream
      (mezzano.debug::check-evaluation-handle job)))))

(defun run ()
  (setf *jobs* nil *leases* nil *cycles* 0
        *printer-cleanups* 0 *reader-cleanups* 0 *body-cleanups* 0
        *printer-entered* nil *reader-entered* nil *supplied* nil
        *gate* (mezzano.supervisor:make-event)
        *reader-gate* nil)
  (let ((controller (make-debugger-controller)))
    (let* ((job (start "(unwind-protect
                         (progn
                           (cerror \"Continue original evaluation.\"
                                   'lispm-debugger-interrupt-test::computing-printer)
                           (values 333 :done))
                        (incf lispm-debugger-interrupt-test::*body-cleanups*))"))
           (parent (stopped job))
           (lease (attach parent controller))
           (id (submit parent lease :condition)))
      (await "condition printer entry" (lambda () *printer-entered*))
      (assert (getf (evaluation-job-information job) :interruptible-p))
      (interrupt-evaluation-job job 0)
      (let* ((child (child-stop parent))
             (child-lease (attach child controller)))
        (assert (= (getf (debugger-stop-information child) :depth) 2))
        (assert (null (getf (evaluation-job-information job) :interruptible-p)))
        (assert (= (interrupt-evaluation-job job 0) 0))
        (setf (mezzano.supervisor:event-state *gate*) t)
        (invoke-continue child child-lease))
      (assert (eq (getf (interrupt-result job 0) :state) :returned))
      (let ((result (terminal-command parent id)))
        (assert (eq (getf result :state) :returned))
        (assert (equal (getf result :result) "Completed condition report.")))
      (assert (= *printer-cleanups* 1))
      (assert (zerop *body-cleanups*))
      (assert (eq (getf (debugger-stop-information parent) :state) :stopped))
      (invoke-continue parent lease)
      (assert (equal (getf (wait-job job :returned) :values) '("333" ":DONE")))
      (assert (= *body-cleanups* 1)))
    (let* ((job (start "(restart-bind
                         ((lispm-debugger-interrupt-test::supply-number
                           (lambda (value)
                             (setf lispm-debugger-interrupt-test::*supplied* value))
                           :interactive-function #'lispm-debugger-interrupt-test::read-number))
                         (break \"Interrupt the restart argument reader.\"))
                        lispm-debugger-interrupt-test::*supplied*"
                       :interactive t))
           (parent (stopped job))
           (lease (attach parent controller))
           (index (restart-index parent lease "LISPM-DEBUGGER-INTERRUPT-TEST::SUPPLY-NUMBER"))
           (id (submit parent lease :invoke-restart-interactively index)))
      (await "restart argument read"
             (lambda () (getf (evaluation-job-information job) :input-waiting-p)))
      (interrupt-evaluation-job job 0)
      (let* ((child (child-stop parent))
             (child-lease (attach child controller)))
        (run-command child child-lease :abort))
      (assert (eq (getf (interrupt-result job 0) :state) :unwound))
      (assert (eq (getf (terminal-command parent id) :state) :unwound))
      (assert (= *reader-cleanups* 1))
      (assert (null *supplied*))
      (assert (null (getf (evaluation-job-information job) :input-waiting-p)))
      (assert (eq (getf (debugger-stop-information parent) :state) :stopped))
      (let ((next (submit parent lease :invoke-restart-interactively index)))
        (await "replacement restart argument read"
               (lambda () (getf (evaluation-job-information job) :input-waiting-p)))
        (supply-evaluation-input job 0 (format nil "44~%"))
        (assert (equal (getf (terminal-command parent next) :result) '("44"))))
      (assert (= *reader-cleanups* 2))
      (invoke-continue parent lease)
      (assert (equal (getf (wait-job job :returned) :values) '("44"))))
    (setf *gate* (mezzano.supervisor:make-event)
          *reader-gate* (mezzano.supervisor:make-event)
          *cycles* 0 *reader-entered* nil)
    (let ((job (start "(restart-bind
                        ((lispm-debugger-interrupt-test::supply-number
                          (lambda (value)
                            (setf lispm-debugger-interrupt-test::*supplied* value))
                          :interactive-function #'lispm-debugger-interrupt-test::read-number))
                        (unwind-protect
                             (progn
                               (loop until (mezzano.supervisor:event-state
                                             lispm-debugger-interrupt-test::*gate*)
                                     do (incf lispm-debugger-interrupt-test::*cycles*))
                               :finished)
                          (incf lispm-debugger-interrupt-test::*body-cleanups*)))"
                      :interactive t)))
      (await "evaluation loop" (lambda () (plusp *cycles*)))
      (interrupt-evaluation-job job 0)
      (let* ((parent (stopped job))
             (lease (attach parent controller))
             (index (restart-index parent lease "LISPM-DEBUGGER-INTERRUPT-TEST::SUPPLY-NUMBER"))
             (id (submit parent lease :invoke-restart-interactively index)))
        (await "inhibited restart argument reader" (lambda () *reader-entered*))
        (assert (getf (evaluation-job-information job) :interruptible-p))
        (interrupt-evaluation-job job 1)
        (assert (eq (getf (evaluation-job-interrupt-result job 1) :state) :pending))
        (assert (= (interrupt-evaluation-job job 1) 1))
        (assert (null (getf (evaluation-job-information job) :interruptible-p)))
        (expect-busy (lambda () (interrupt-evaluation-job job 2)))
        (setf (mezzano.supervisor:event-state *reader-gate*) t)
        (let* ((child (child-stop parent))
               (child-lease (attach child controller)))
          (assert (= (getf (evaluation-job-information job) :interrupt-id) 1))
          (assert (eq (getf (evaluation-job-interrupt-result job 0) :state) :running))
          (run-command child child-lease :abort))
        (assert (eq (getf (terminal-command parent id) :state) :unwound))
        (assert (eq (getf (interrupt-result job 1) :state) :unwound))
        (assert (= (getf (evaluation-job-information job) :interrupt-id) 0))
        (assert (eq (getf (evaluation-job-interrupt-result job 0) :state) :running))
        (assert (= *reader-cleanups* 3))
        (expect-busy (lambda () (interrupt-evaluation-job job 2)))
        (setf (mezzano.supervisor:event-state *gate*) t)
        (invoke-continue parent lease))
      (assert (eq (getf (interrupt-result job 0) :state) :returned))
      (assert (null (getf (evaluation-job-information job) :interrupt-id)))
      (assert (equal (getf (wait-job job :returned) :values) '(":FINISHED")))
      (assert (= *body-cleanups* 2)))
    (setf *reader-gate* nil)
    (let ((job (start "(restart-bind
                        ((lispm-debugger-interrupt-test::supply-number
                          (lambda (value) value)
                          :interactive-function #'lispm-debugger-interrupt-test::read-number))
                        (unwind-protect (read-line)
                          (incf lispm-debugger-interrupt-test::*body-cleanups*)))"
                      :interactive t)))
      (await "outer input wait" (lambda () (= (input-waiters job) 1)))
      (interrupt-evaluation-job job 0)
      (let* ((parent (stopped job))
             (lease (attach parent controller))
             (index (restart-index parent lease "LISPM-DEBUGGER-INTERRUPT-TEST::SUPPLY-NUMBER"))
             (id (submit parent lease :invoke-restart-interactively index)))
        (await "nested input wait" (lambda () (= (input-waiters job) 2)))
        (interrupt-evaluation-job job 1)
        (let* ((child (child-stop parent))
               (child-lease (attach child controller)))
          (run-command child child-lease :abort))
        (assert (eq (getf (terminal-command parent id) :state) :unwound))
        (assert (= (input-waiters job) 1))
        (assert (getf (evaluation-job-information job) :input-waiting-p))
        (assert (= *reader-cleanups* 4))
        (invoke-continue parent lease))
      (assert (eq (getf (interrupt-result job 0) :state) :returned))
      (assert (getf (evaluation-job-information job) :input-waiting-p))
      (supply-evaluation-input job 0 (format nil "finish~%"))
      (assert (equal (progn (wait-job job :returned)
                             (evaluation-job-result-values job))
                     '("finish" nil)))
      (assert (zerop (input-waiters job)))
      (assert (= *body-cleanups* 3)))
    (dolist (lease *leases*) (release-debugger-stop lease))
    (dolist (job *jobs*) (release-evaluation-job job))
    (close-debugger-controller controller)
    (setf *leases* nil *jobs* nil)
    (format t "PASS debugger printer and input interruption, continuation, command abort, nested interrupt restoration, nested input wait accounting, inhibited delivery, replay, and cleanup.~%")
    :passed))
