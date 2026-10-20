(defpackage #:lispm-worker-shutdown-probe
  (:use #:cl)
  (:local-nicknames (#:s #:mezzano.supervisor))
  (:export #:run))
(in-package #:lispm-worker-shutdown-probe)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *state* nil)
(defvar *cases* nil)

(defun await (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 10 internal-time-units-per-second))))
    (loop
      (when (funcall predicate) (return t))
      (assert (< (get-internal-real-time) deadline) ()
              "Worker shutdown probe exceeded ten seconds.")
      (s:thread-yield))))

(defun run (&key (expect-stranded t) (cleanup-entry :terminate))
  (assert (member cleanup-entry '(:return :terminate)))
  (assert (null *state*))
  (let* ((lock (s:make-mutex "Owned worker shutdown probe"))
         (ready (s:make-event))
         (body (s:make-event))
         (entered (s:make-event))
         (resume (s:make-event))
         (original (fdefinition 's::check-mutex-release-consistence))
         (target nil))
    (setf *state* (list :lock lock :ready ready :body body
                       :entered entered :resume resume :original original))
    (setf s::*worker-mutex-probe-original* original
          s::*worker-mutex-probe-target* (s:current-thread)
          s::*worker-mutex-probe-lock* lock
          s::*worker-mutex-probe-seen* nil
          s::*worker-mutex-probe-armed* nil
          s::*worker-mutex-probe-entered* entered
          s::*worker-mutex-probe-resume* resume)
    (unwind-protect
         (progn
           (setf (fdefinition 's::check-mutex-release-consistence)
                 #'s::worker-mutex-probe-check)
           (s:with-mutex (lock) (values))
           (assert s::*worker-mutex-probe-seen* ()
                   "The loaded RELEASE-MUTEX did not call the probe.")
           (setf target
                 (s:make-thread
                  (lambda ()
                    (unwind-protect
                         (progn
                           (setf (s:event-state ready) t)
                           (s:event-wait body))
                      (s:with-mutex (lock)
                        (setf (getf *state* :cleanup-entered) t))))
                  :name "Owned worker shutdown target"))
           (setf (getf *state* :target) target)
           (await (lambda () (s:event-state ready)))
           (setf s::*worker-mutex-probe-target* target
                 s::*worker-mutex-probe-seen* nil
                 s::*worker-mutex-probe-armed* t)
           (ecase cleanup-entry
             (:return (setf (s:event-state body) t))
             (:terminate (s:terminate-thread target)))
           (await (lambda () (s:event-state entered)))
           (assert (eq (s::mutex-owner lock) target))
           (assert (getf *state* :cleanup-entered))
           (s:terminate-thread target)
           (setf (s:event-state resume) t)
           (await (lambda ()
                    (and (nth-value 1 (s:thread-join target nil))
                         (eq (s::sample-thread-state target) :dead))))
           (setf (getf *state* :owner-is-target)
                 (eq (s::mutex-owner lock) target)
                 (getf *state* :mutex-state) (s::mutex-state lock))
           (assert (eq (s::mutex-owner lock) (and expect-stranded target)))
           (assert (eq (s::mutex-state lock)
                       (if expect-stranded :locked :unlocked)))
           (format t "PASS release cleanup probe ~S: owner-target ~S state ~S.~%"
                   cleanup-entry (getf *state* :owner-is-target) (getf *state* :mutex-state))
           (list :owner-is-target (getf *state* :owner-is-target)
                 :mutex-state (getf *state* :mutex-state)))
      (setf (fdefinition 's::check-mutex-release-consistence) original)
      (setf (s:event-state resume) t))))

(defun run-cases ()
  (assert (null *cases*))
  (dolist (mode '(:return :terminate))
    (let ((result (run :cleanup-entry mode :expect-stranded t)))
      (push (list :mode mode :result result :state *state*) *cases*)
      (setf *state* nil)))
  (assert (= 2 (length *cases*)))
  (format t "Both unchanged-kernel release-cleanup failures reproduced.~%")
  :release-cleanup-orphans-reproduced)
