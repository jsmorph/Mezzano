(defpackage #:lispm-mutex-binding-test
  (:use #:cl)
  (:local-nicknames (#:s #:mezzano.supervisor)
                    (#:i #:mezzano.internals)
                    (#:b #:lispm-foothold-binding-test))
  (:export #:run))
(in-package #:lispm-mutex-binding-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun macro-states ()
  (assert (equal (b::state) '(0 t)))
  (s:without-footholds
    (assert (equal (b::state) '(1 nil)))
    (s:with-footholds (assert (equal (b::state) '(1 nil))))
    (s:without-footholds
      (s:allow-with-footholds
        (s:with-footholds (assert (equal (b::state) '(2 nil))))))
    (s:allow-with-footholds
      (assert (equal (b::state) '(1 t)))
      (s:without-footholds
        (assert (equal (b::state) '(2 nil)))
        (s:with-local-footholds (assert (equal (b::state) '(0 t))))
        (assert (equal (b::state) '(2 nil))))
      (s:with-footholds (assert (equal (b::state) '(0 t)))))
    (assert (equal (b::state) '(1 nil))))
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
  (assert (equal (b::state) '(0 t)))
  (format t "PASS nested macro permissions, values, RETURN-FROM, THROW, error, and ABORT.~%"))

(defun mutex-basics ()
  (let ((lock (s:make-mutex "Owned mutex basics"))
        (wanted (loop repeat 8 collect (list :mutex-value)))
        (fatal s::*lock-violations-are-fatal*))
    (unwind-protect
         (progn
           (assert (equal (multiple-value-list
                           (s:with-mutex (lock)
                             (assert (equal (b::state) '(0 t)))
                             (values-list wanted)))
                          wanted))
           (s::call-with-foothold-binding
            (lambda ()
              (s:with-mutex (lock)
                (assert (equal (b::state) '(2 nil)))))
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
  (assert (equal (b::state) '(0 t)))
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
                                 (getf row :state) (b::state))
                           :body-returned)
                      (setf (getf row :cleanup) (b::state))))
                  :name "Owned mutex contender"))
           (unless (eq mode :nonblocking)
             (b::await (lambda () (waiting-on thread lock)))
             (assert (eq (s::mutex-state lock) :contested)))
           (ecase mode
             (:nonblocking)
             (:cancel (s:terminate-thread thread))
             (:handoff (s:release-mutex lock)))
           (multiple-value-bind (values joined) (s:thread-join thread)
             (assert joined)
             (when (eq mode :handoff) (assert (equal values '(:body-returned)))))
           (b::await (lambda () (eq (s::sample-thread-state thread) :dead)))
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

(defun acquisition-exit ()
  (let* ((lock (s:make-mutex "Owned fast acquisition mutex"))
         (start (s:make-event)) (entered (s:make-event)) (resume (s:make-event))
         (row (list :body nil :cleanup nil))
         (thread (s:make-thread
                  (lambda ()
                    (s:event-wait start)
                    (unwind-protect
                         (s:with-mutex (lock) (setf (getf row :body) t))
                      (setf (getf row :cleanup) (b::state))))
                  :name "Owned fast acquisition exit")))
    (setf s::*foothold-binding-probe-target* thread
          s::*foothold-binding-probe-stage* :acquired-mutex-state
          s::*foothold-binding-probe-entered* entered
          s::*foothold-binding-probe-resume* resume
          s::*foothold-binding-probe-mutex* lock)
    (unwind-protect
         (progn
           (setf (s:event-state start) t)
           (b::await (lambda () (s:event-state entered)))
           (assert (eq (s::mutex-state lock) :locked))
           (assert (null (s::mutex-owner lock)))
           (assert (plusp (s::thread-inhibit-footholds thread)))
           (s:terminate-thread thread)
           (s:terminate-thread thread)
           (setf (s:event-state resume) t)
           (multiple-value-bind (values joined) (s:thread-join thread)
             (declare (ignore values)) (assert joined))
           (b::await (lambda () (eq (s::sample-thread-state thread) :dead)))
           (assert (null (getf row :body)))
           (assert (equal (getf row :cleanup) '(0 t)))
           (assert (null (s::mutex-owner lock)))
           (assert (eq (s::mutex-state lock) :unlocked))
           (format t "PASS two queued exits between acquisition state and owner stores.~%"))
      (setf (s:event-state start) t (s:event-state resume) t
            s::*foothold-binding-probe-target* nil
            s::*foothold-binding-probe-stage* nil
            s::*foothold-binding-probe-entered* nil
            s::*foothold-binding-probe-resume* nil
            s::*foothold-binding-probe-mutex* nil))))

(defun run ()
  (macro-states)
  (mutex-basics)
  (dolist (mode '(:nonblocking :cancel :handoff)) (contention mode))
  (acquisition-exit)
  :mutex-and-macro-basics-tested)
