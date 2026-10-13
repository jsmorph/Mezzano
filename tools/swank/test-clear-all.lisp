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

(defun run (&key allow-global-clear)
  (unless allow-global-clear
    (error "This test deletes retained evaluations. Pass :ALLOW-GLOBAL-CLEAR T."))
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
           (result (mezzano.debug::clear-evaluation-history current)))
      (assert (every #'identity *cleanups*))
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
      (format t "PASS Clear All released ~D jobs and ~D stops; input wait, running evaluation, debugger stop, unwind cleanup, and later submission tested.~%"
              (getf result :jobs) (getf result :stops))
      t)))
