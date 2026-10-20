(defpackage #:lispm-compiler-shutdown-probe
  (:use #:cl)
  (:local-nicknames (#:s #:mezzano.supervisor)
                    (#:i #:mezzano.internals)
                    (#:q #:mezzano.sync))
  (:export #:run))
(in-package #:lispm-compiler-shutdown-probe)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *state* nil)

(defun await (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 10 internal-time-units-per-second))))
    (loop
      (when (funcall predicate) (return t))
      (assert (< (get-internal-real-time) deadline) ()
              "Compiler shutdown probe exceeded ten seconds.")
      (s:thread-yield))))

(defun waiting-on-p (thread lock)
  (multiple-value-bind (name state priority wait runtime)
      (s::sample-thread-information thread)
    (declare (ignore name priority runtime))
    (and (eq state :sleeping) (eq wait lock))))

(defun run ()
  (assert (null *state*))
  (let* ((work (s:make-fifo 8))
         (replies (s:make-fifo 8))
         (lock (q::mailbox-lock replies))
         (ready (s:make-event))
         (start (s:make-event))
         (entered (s:make-event))
         (resume (s:make-event))
         (original (fdefinition 's::check-mutex-release-consistence))
         (worker (fdefinition 'i::compile-file-worker))
         (target nil)
         (witness nil))
    (assert (compiled-function-p worker))
    (setf *state* (list :work work :replies replies :lock lock
                       :ready ready :start start :entered entered :resume resume
                       :original original :worker worker))
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
           (s:fifo-push :preflight replies)
           (assert (eq (s:fifo-pop replies) :preflight))
           (assert s::*worker-mutex-probe-seen*)
           (setf target
                 (s:make-thread
                  (lambda ()
                    (setf (s:event-state ready) t)
                    (s:event-wait start)
                    (funcall worker work replies))
                  :name "Owned compiler worker target"))
           (setf (getf *state* :target) target)
           (await (lambda () (s:event-state ready)))
           (setf s::*worker-mutex-probe-target* target
                 s::*worker-mutex-probe-seen* nil
                 s::*worker-mutex-probe-armed* t)
           (s:fifo-push :finished work)
           (setf (s:event-state start) t)
           (await (lambda () (s:event-state entered)))
           (assert (eq (s::mutex-owner lock) target))
           (assert (= 1 (q::mailbox-n-pending-messages replies)))
           (s:terminate-thread target)
           (setf (s:event-state resume) t)
           (await (lambda ()
                    (and (nth-value 1 (s:thread-join target nil))
                         (eq (s::sample-thread-state target) :dead))))
           (assert (eq (s::mutex-owner lock) target))
           (assert (eq (s::mutex-state lock) :locked))
           (s:fifo-push :finished work)
           (setf witness
                 (s:make-thread (lambda () (funcall worker work replies))
                                :name "Owned compiler worker witness"))
           (setf (getf *state* :witness) witness)
           (await (lambda () (waiting-on-p witness lock)))
           (assert (eq (s::mutex-owner lock) target))
           (assert (eq (s::mutex-state lock) :contested))
           (assert (= 1 (q::mailbox-n-pending-messages replies)))
           (assert (eq worker (fdefinition 'i::compile-file-worker)))
           (format t "Compiler worker target DEAD, return mutex CONTESTED with dead owner, witness SLEEPING on that mutex, one EXIT queued.~%")
           :compiler-worker-mailbox-failure-reproduced)
      (setf (fdefinition 's::check-mutex-release-consistence) original)
      (setf (s:event-state resume) t))))
