(defpackage :lispm-clear-all-test
  (:use :cl)
  (:export :run))
(in-package :lispm-clear-all-test)

(defvar *cleanups* nil)
(defvar *running-started* nil)
(defvar *later-job* nil)
(defvar *later-name* nil)

(defun job-name ()
  (string-downcase (format nil "~64,'0X" (random (ash 1 256)))))

(defun await-state (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 10 internal-time-units-per-second))))
    (loop until (funcall predicate)
          do (when (> (get-internal-real-time) deadline)
               (error "Clear All test state was not reached."))
             (sleep 0.01))))

(defun information (job)
  (mezzano.debug:evaluation-job-information job))

(defun released-p (job)
  (handler-case
      (progn (information job) nil)
    (mezzano.debug:debugger-service-error (condition)
      (unless (eq (mezzano.debug:debugger-service-error-reason condition) :released-job)
        (error condition))
      t)))

(defun test-early-entry ()
  (let* ((entry (mezzano.supervisor:make-event :name 'evaluation-entry-test))
         (job (mezzano.debug::%make-evaluation-job
               :name (job-name) :package (find-package "CL-USER")
               :source "(read-line)" :input "" :interactive-p t
               :input-stream (make-instance 'mezzano.debug::evaluation-input-stream)
               :output-stream (make-instance 'mezzano.debug::evaluation-output-stream)))
         (thread (mezzano.supervisor:make-thread
                  (lambda ()
                    (mezzano.supervisor:event-wait entry)
                    (mezzano.debug::run-evaluation-job job))
                  :name 'evaluation-entry-test))
         (requester (mezzano.supervisor:make-thread
                     (lambda () (mezzano.debug::request-evaluation-termination job thread))
                     :name 'evaluation-termination-test)))
    (setf (mezzano.debug::evaluation-job-thread job) thread)
    (unwind-protect
         (progn
           (await-state (lambda ()
                          (eq (mezzano.supervisor::sample-thread-state requester) :sleeping)))
           (assert (not (mezzano.debug::evaluation-job-interrupt-ready-p job)))
           (assert (eq (mezzano.debug::evaluation-job-state job) :running))
           (assert (not (nth-value 1 (mezzano.supervisor:thread-join thread nil))))
           (setf (mezzano.supervisor:event-state entry) t)
           (assert (equal (mezzano.supervisor:thread-join requester) '(t)))
           (assert (eq (mezzano.supervisor:thread-join thread)
                       'mezzano.supervisor:terminate-thread))
           (assert (eq (mezzano.debug::evaluation-job-state job) :unwound))
           (assert (not (mezzano.gray:stream-open-p
                         (mezzano.debug::evaluation-job-input-stream job))))
           (assert (not (mezzano.gray:stream-open-p
                         (mezzano.debug::evaluation-job-output-stream job))))
           (mezzano.debug::with-service-lock
             (mezzano.debug::release-evaluation-record job)))
      (setf (mezzano.supervisor:event-state entry) t)))
  (let* ((job (mezzano.debug::%make-evaluation-job :state :returned))
         (thread (mezzano.supervisor:make-thread (lambda () 18) :name 'completed-evaluation-test)))
    (assert (not (mezzano.debug::request-evaluation-termination job thread)))
    (assert (equal (mezzano.supervisor:thread-join thread) '(18))))
  t)

(defun test-listener-state (current)
  (let* ((listener (mezzano.command-processor:make-listener))
         (job (mezzano.command-processor:start-listener
               listener (job-name)
               "(unwind-protect (read-line)
                  (setf *package* (find-package \"KEYWORD\")
                        *default-pathname-defaults* (pathname \"SYS:SOURCE;\")))"
               :interactive t)))
    (await-state (lambda () (getf (information job) :input-waiting-p)))
    (mezzano.command-processor::execute-input listener current "Clear All")
    (assert (released-p job))
    (assert (eq (mezzano.command-processor::listener-package listener)
                (find-package "KEYWORD")))
    (assert (equal (namestring (mezzano.command-processor::listener-pathname listener))
                   (namestring (pathname "SYS:SOURCE;"))))
    t))

(defun run (&key allow-global-clear)
  (unless allow-global-clear
    (error "This test deletes retained evaluations. Pass :ALLOW-GLOBAL-CLEAR T."))
  (test-early-entry)
  (setf *cleanups* (make-array 3 :initial-element nil)
        *running-started* nil *later-job* nil *later-name* (job-name))
  (let* ((current
           (mezzano.debug::with-service-lock
             (loop for job being the hash-values of mezzano.debug::*evaluation-jobs*
                   when (eq (mezzano.debug::evaluation-job-thread job)
                            (mezzano.supervisor:current-thread))
                     return job)))
         (returned (mezzano.debug:start-evaluation-job (job-name) "(values 12 34)"))
         (input (mezzano.debug:start-evaluation-job
                 (job-name)
                 "(unwind-protect (read-line) (setf (aref lispm-clear-all-test::*cleanups* 0) t))"
                 :interactive t))
         (stopped (mezzano.debug:start-evaluation-job
                   (job-name)
                   "(unwind-protect (cerror \"Continue.\" \"Clear All test stop.\")
                      (setf (aref lispm-clear-all-test::*cleanups* 1) t))"))
         (running (mezzano.debug:start-evaluation-job
                   (job-name)
                   "(unwind-protect (progn (setf lispm-clear-all-test::*running-started* t)
                                          (loop (sleep 0.01)))
                      (setf (aref lispm-clear-all-test::*cleanups* 2) t)
                      (setf lispm-clear-all-test::*later-job*
                            (mezzano.debug:start-evaluation-job
                             lispm-clear-all-test::*later-name* \"(+ 4 5)\")))")))
    (assert current)
    (await-state (lambda () (eq (getf (information returned) :state) :returned)))
    (await-state (lambda () (getf (information input) :input-waiting-p)))
    (await-state (lambda () (getf (information stopped) :stops)))
    (await-state (lambda () *running-started*))
    (let* ((stop (first (getf (information stopped) :stops)))
           (waiting nil)
           (captured-threads nil)
           (result
             (mezzano.supervisor:with-mutex (mezzano.debug::*clear-evaluation-lock*)
               (setf waiting (mezzano.command-processor:start-listener
                              (mezzano.command-processor:make-listener) (job-name) "Clear All"))
               (let ((thread (mezzano.debug::evaluation-job-thread
                              (mezzano.debug::evaluation-handle-job waiting))))
                 (await-state
                  (lambda ()
                    (multiple-value-bind (name state priority wait)
                        (mezzano.supervisor::sample-thread-information thread)
                      (declare (ignore name priority))
                      (and (eq state :sleeping)
                           (eq wait mezzano.debug::*clear-evaluation-lock*))))))
               (setf captured-threads
                     (mezzano.debug::with-service-lock
                       (loop for job being the hash-values of mezzano.debug::*evaluation-jobs*
                             when (and (not (eq job current))
                                       (eq (mezzano.debug::evaluation-job-state job) :running))
                               collect (mezzano.debug::evaluation-job-thread job))))
               (mezzano.debug::clear-evaluation-history-locked current))))
      (assert (every #'identity *cleanups*))
      (assert (released-p waiting))
      (assert (= (getf result :terminated)
                 (count 'mezzano.supervisor:terminate-thread captured-threads
                        :key #'mezzano.supervisor:thread-join)))
      (dolist (job (list returned input stopped running))
        (assert (released-p job)))
      (assert (>= (getf result :jobs) 4))
      (assert (>= (getf result :terminated) 3))
      (handler-case
          (progn (mezzano.debug:debugger-stop-information stop)
                 (error "Clear All retained a closed debugger stop."))
        (mezzano.debug:debugger-service-error (condition)
          (unless (eq (mezzano.debug:debugger-service-error-reason condition) :released-stop)
            (error condition))))
      (assert *later-job*)
      (await-state (lambda () (eq (getf (information *later-job*) :state) :returned)))
      (assert (equal (mezzano.debug:evaluation-job-result-values *later-job*) '(9)))
      (assert (not (member *later-name* (getf result :job-names) :test #'equal)))
      (mezzano.debug:release-evaluation-job *later-job*)
      (format t "PASS Clear All released ~D jobs and ~D stops; early entry, serialized clears, termination counts, input wait, debugger stop, unwind cleanup, and later submission tested.~%"
              (getf result :jobs) (getf result :stops))
      (test-listener-state current)
      (format t "PASS Clear All preserved Listener package and pathname changes.~%")
      t)))
