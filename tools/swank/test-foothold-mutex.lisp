(defpackage #:lispm-foothold-mutex-test
  (:use #:cl)
  (:local-nicknames (#:s #:mezzano.supervisor)
                    (#:i #:mezzano.internals))
  (:export #:run))
(in-package #:lispm-foothold-mutex-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun state ()
  (list (s::thread-inhibit-footholds (s:current-thread))
        (s::thread-allow-with-footholds (s:current-thread))))

(defun await (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 10 internal-time-units-per-second))))
    (loop until (funcall predicate)
          do (assert (< (get-internal-real-time) deadline))
             (s:thread-yield))))

(defun macro-states ()
  (assert (equal (state) '(0 t)))
  (s:without-footholds
    (assert (equal (state) '(1 nil)))
    (s:with-footholds (assert (equal (state) '(1 nil))))
    (s:without-footholds
      (s:allow-with-footholds
        (s:with-footholds (assert (equal (state) '(2 nil))))))
    (s:allow-with-footholds
      (assert (equal (state) '(1 t)))
      (s:without-footholds
        (assert (equal (state) '(2 nil)))
        (s:with-local-footholds (assert (equal (state) '(0 t))))
        (assert (equal (state) '(2 nil))))
      (s:with-footholds (assert (equal (state) '(0 t)))))
    (assert (equal (state) '(1 nil))))
  (dolist (count '(0 1 5 8))
    (let ((wanted (loop repeat count collect (list :macro-value))))
      (let ((result (multiple-value-list
                     (s:without-footholds
                       (s:with-local-footholds (values-list wanted))))))
        (assert (= (length result) count))
        (assert (every #'eq wanted result)))))
  (assert (eq :returned
              (block target
                (s:without-footholds
                  (s:with-local-footholds (return-from target :returned))))))
  (assert (eq :thrown
              (catch 'target
                (s:without-footholds
                  (s:with-local-footholds (throw 'target :thrown))))))
  (let ((condition (make-condition 'simple-error :format-control "Owned macro condition")))
    (assert (eq condition
                (handler-case
                    (s:without-footholds
                      (s:with-local-footholds (error condition)))
                  (error (caught) caught)))))
  (assert (eq :aborted
              (restart-case
                  (s:without-footholds
                    (s:with-local-footholds (invoke-restart 'abort)))
                (abort () :aborted))))
  (assert (equal (state) '(0 t)))
  (format t "PASS nested macro permissions, values, RETURN-FROM, THROW, error, and ABORT.~%"))

(defun mutex-basics ()
  (let ((lock (s:make-mutex "Owned mutex basics"))
        (wanted (loop repeat 8 collect (list :mutex-value)))
        (fatal s::*lock-violations-are-fatal*))
    (unwind-protect
         (progn
           (assert (equal (multiple-value-list
                           (s:with-mutex (lock)
                             (assert (equal (state) '(0 t)))
                             (values-list wanted)))
                          wanted))
           (s::call-with-foothold-binding
            (lambda ()
              (s:with-mutex (lock)
                (assert (equal (state) '(2 nil)))))
            2 nil)
           (let ((condition (make-condition 'simple-error :format-control "Owned mutex error")))
             (assert (eq condition
                         (handler-case (s:with-mutex (lock) (error condition))
                           (error (caught) caught)))))
           (assert (eq :thrown
                       (catch 'target (s:with-mutex (lock) (throw 'target :thrown)))))
           (assert (eq :aborted
                       (restart-case (s:with-mutex (lock) (invoke-restart 'abort))
                         (abort () :aborted))))
           (setf s::*lock-violations-are-fatal* nil)
           (s:acquire-mutex lock)
           (assert (handler-case
                       (s:with-mutex (lock) (error "Recursive body ran."))
                     (i::mutex-error () t)))
           (assert (s:mutex-held-p lock))
           (s:release-mutex lock)
           (assert (null (s::mutex-owner lock)))
           (assert (eq (s::mutex-state lock) :unlocked)))
      (setf s::*lock-violations-are-fatal* fatal)
      (when (s:mutex-held-p lock) (s:release-mutex lock))))
  (assert (equal (state) '(0 t)))
  (format t "PASS mutex values, masked body, exits, and recursive ownership.~%"))

(defun waiting-on (thread lock)
  (multiple-value-bind (name state priority wait runtime) (s::sample-thread-information thread)
    (declare (ignore name priority runtime))
    (and (eq state :sleeping) (eq wait lock))))

(defun contention (mode)
  (let* ((lock (s:make-mutex "Owned contention mutex"))
         (row (list :entered nil :owner nil :state nil :cleanup nil))
         (thread nil))
    (s:acquire-mutex lock)
    (unwind-protect
         (progn
           (setf thread
                 (s:make-thread
                  (lambda ()
                    (unwind-protect
                         (s:with-mutex (lock :wait-p (not (eq mode :nonblocking)))
                           (setf (getf row :entered) t
                                 (getf row :owner) (s:mutex-held-p lock)
                                 (getf row :state) (state))
                           :body-returned)
                      (setf (getf row :cleanup) (state))))
                  :name "Owned mutex contender"))
           (unless (eq mode :nonblocking)
             (await (lambda () (waiting-on thread lock)))
             (assert (eq (s::mutex-state lock) :contested)))
           (ecase mode
             (:nonblocking)
             (:cancel (s:terminate-thread thread))
             (:handoff (s:release-mutex lock)))
           (multiple-value-bind (values joined) (s:thread-join thread)
             (assert joined)
             (when (eq mode :handoff) (assert (equal values '(:body-returned)))))
           (await (lambda () (eq (s::sample-thread-state thread) :dead)))
           (assert (eq (getf row :entered) (eq mode :handoff)))
           (assert (equal (getf row :cleanup) '(0 t)))
           (if (eq mode :handoff)
               (progn
                 (assert (getf row :owner))
                 (assert (equal (getf row :state) '(0 t)))
                 (assert (null (s::mutex-owner lock))))
               (assert (s:mutex-held-p lock)))
           (assert (null (s::wait-queue-head lock)))
           (assert (null (s::wait-queue-tail lock)))
           (format t "PASS mutex contention ~S: ~S.~%" mode row))
      (when (s:mutex-held-p lock) (s:release-mutex lock)))))

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
           (await (lambda () (s:event-state ready)))
           (setf s::*worker-mutex-probe-target* target
                 s::*worker-mutex-probe-seen* nil
                 s::*worker-mutex-probe-armed* t)
           (s:fifo-push :finished work)
           (setf (s:event-state start) t)
           (await (lambda () (s:event-state entered)))
           (assert (eq (s::mutex-owner lock) target))
           (assert (plusp (s::thread-inhibit-footholds target)))
           (assert (= 1 (mezzano.sync::mailbox-n-pending-messages replies)))
           (s:terminate-thread target)
           (setf (s:event-state resume) t)
           (multiple-value-bind (values joined) (s:thread-join target)
             (declare (ignore values)) (assert joined))
           (await (lambda () (eq (s::sample-thread-state target) :dead)))
           (assert (null (s::mutex-owner lock)))
           (assert (eq (s::mutex-state lock) :unlocked))
           (s:fifo-push :finished work)
           (setf witness
                 (s:make-thread (lambda () (funcall worker work replies))
                                :name "Owned compiler reply witness"))
           (multiple-value-bind (values joined) (s:thread-join witness)
             (declare (ignore values)) (assert joined))
           (await (lambda () (eq (s::sample-thread-state witness) :dead)))
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

(defun macro-continuation (masked)
  (let ((tag (mezzano.delimited-continuations:make-prompt-tag "Owned macro continuation"))
        (saved nil) (handler-state nil) (child-state nil) (resumer-state nil) (output nil)
        (wanted (loop repeat 8 collect (list :macro-continuation-value))))
    (s:without-footholds
      (s:allow-with-footholds
        (mezzano.delimited-continuations:call-with-prompt
         tag
         (lambda ()
           (multiple-value-prog1
               (s:without-footholds
                 (multiple-value-prog1
                     (s:with-local-footholds
                       (let ((input (multiple-value-list
                                     (mezzano.delimited-continuations:abort-to-prompt tag))))
                         (assert (equal (state) '(0 t)))
                         (i::gc :full t)
                         (assert (= (length input) 8))
                         (assert (every #'eq input wanted))
                         (values-list input)))
                   (assert (equal (state) '(2 nil)))))
             (setf child-state (state))))
         (lambda (continuation)
           (setf saved continuation handler-state (state))))))
    (assert (equal handler-state '(1 t)))
    (assert (equal (state) '(0 t)))
    (flet ((resume ()
             (setf output (multiple-value-list (apply saved wanted))
                   resumer-state (state))))
      (if masked (s:without-footholds (resume)) (resume)))
    (assert (equal child-state (if masked '(1 nil) '(0 t))))
    (assert (equal resumer-state child-state))
    (assert (equal (state) '(0 t)))
    (assert (= (length output) 8))
    (assert (every #'eq output wanted))
    (format t "PASS compiled macro continuation, masked resumer ~S, nested permissions, eight identities, and moving GC.~%" masked)))

(defun run ()
  (macro-states)
  (mutex-basics)
  (dolist (mode '(:nonblocking :cancel :handoff)) (contention mode))
  (dolist (mode '(:return :terminate))
    (assert (null lispm-worker-shutdown-probe::*state*))
    (lispm-worker-shutdown-probe:run :expect-stranded nil :cleanup-entry mode)
    (setf lispm-worker-shutdown-probe::*state* nil))
  (compiler-worker-reply)
  (macro-continuation nil)
  (macro-continuation t)
  (assert (equal (state) '(0 t)))
  :foothold-mutex-tested)
