(in-package :mezzano.supervisor)
(declaim (optimize (debug 1) (safety 3) (speed 1)))
(sys.int::defglobal *foothold-binding-probe-mutex* nil)

(defun acquire-mutex (mutex &optional (wait-p t))
  (check-type mutex mutex)
  (let ((self (current-thread)))
    ;; Fast path - try to lock.
    (when (without-footholds
            (when (eql (sys.int::cas (mutex-state mutex) :unlocked :locked) :unlocked)
              (when (eq mutex *foothold-binding-probe-mutex*)
                (foothold-binding-probe-gate :acquired-mutex-state))
              (setf (mutex-owner mutex) self)
              t))
      (return-from acquire-mutex t))
    ;; Idiot check.
    (unless (not (mutex-held-p mutex))
      (if *lock-violations-are-fatal*
          (panic "Recursive locking detected on " mutex " " (mutex-name mutex))
          (error 'sys.int::mutex-error
                 :mutex mutex
                 :format-control "Recursive locking detected on ~S ~S"
                 :format-arguments (list mutex (mutex-name mutex)))))
    ;; Increment MUTEX-CONTESTED-COUNT
    (sys.int::atomic-incf (mutex-contested-count mutex))
    (when wait-p
      (ensure-interrupts-enabled)
      (unless (not *pseudo-atomic*)
        (panic "Trying to acquire mutex " mutex " while pseudo-atomic."))
      (thread-pool-blocking-hijack acquire-mutex mutex wait-p)
      (%call-on-wired-stack-without-interrupts
       #'acquire-mutex-slow-path nil mutex self)
      t)))

(defun release-mutex (mutex)
  (check-type mutex mutex)
  (without-footholds
    (check-mutex-release-consistence mutex)
    (setf (mutex-owner mutex) nil)
    (when (not (eql (sys.int::cas (mutex-state mutex) :locked :unlocked) :locked))
      ;; Mutex must be in the contested state.
      (release-mutex-slow-path mutex))
    (values)))

(defun call-with-mutex (thunk mutex wait-p)
  (check-type mutex mutex)
  (let* ((thread (current-thread))
         (counter (thread-inhibit-footholds thread))
         (allow (thread-allow-with-footholds thread)))
    (call-with-foothold-binding
     (dx-lambda ()
       (let ((owned-at-entry (mutex-held-p mutex)))
         (unwind-protect
              (call-with-foothold-binding
               (dx-lambda ()
                 (when (acquire-mutex mutex wait-p)
                   (funcall thunk)))
               counter allow)
           (when (and (not owned-at-entry) (mutex-held-p mutex))
             (release-mutex mutex)))))
     (1+ counter) nil)))
