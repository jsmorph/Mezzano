(in-package #:lispm-mutex-binding-test)

(defun compiler-worker-reply ()
  (let* ((work (s:make-fifo 8)) (replies (s:make-fifo 8))
         (lock (mezzano.sync::mailbox-lock replies))
         (ready (s:make-event)) (start (s:make-event))
         (entered (s:make-event)) (resume (s:make-event))
         (original (fdefinition 's::check-mutex-release-consistence))
         (worker (fdefinition 'i::compile-file-worker))
         (target nil) (witness nil))
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
                  :name "Owned compiler reply target"))
           (b::await (lambda () (s:event-state ready)))
           (setf s::*worker-mutex-probe-target* target
                 s::*worker-mutex-probe-seen* nil
                 s::*worker-mutex-probe-armed* t)
           (s:fifo-push :finished work)
           (setf (s:event-state start) t)
           (b::await (lambda () (s:event-state entered)))
           (assert (eq (s::mutex-owner lock) target))
           (assert (plusp (s::thread-inhibit-footholds target)))
           (assert (= 1 (mezzano.sync::mailbox-n-pending-messages replies)))
           (s:terminate-thread target)
           (setf (s:event-state resume) t)
           (multiple-value-bind (values joined) (s:thread-join target)
             (declare (ignore values)) (assert joined))
           (b::await (lambda () (eq (s::sample-thread-state target) :dead)))
           (assert (null (s::mutex-owner lock)))
           (assert (eq (s::mutex-state lock) :unlocked))
           (s:fifo-push :finished work)
           (setf witness
                 (s:make-thread (lambda () (funcall worker work replies))
                                :name "Owned compiler reply witness"))
           (multiple-value-bind (values joined) (s:thread-join witness)
             (declare (ignore values)) (assert joined))
           (b::await (lambda () (eq (s::sample-thread-state witness) :dead)))
           (assert (eq worker (fdefinition 'i::compile-file-worker)))
           (assert (null (s::mutex-owner lock)))
           (assert (eq (s::mutex-state lock) :unlocked))
           (assert (= 2 (mezzano.sync::mailbox-n-pending-messages replies)))
           (assert (eq (s:fifo-pop replies) :exit))
           (assert (eq (s:fifo-pop replies) :exit))
           (format t "PASS unchanged compiler worker release: both workers DEAD, return mutex UNLOCKED, both EXIT messages read.~%"))
      (setf (fdefinition 's::check-mutex-release-consistence) original
            s::*worker-mutex-probe-target* nil
            s::*worker-mutex-probe-lock* nil
            s::*worker-mutex-probe-armed* nil
            (s:event-state start) t
            (s:event-state resume) t))))
