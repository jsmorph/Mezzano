(defpackage #:lispm-foothold-gc-test (:use #:cl))
(in-package #:lispm-foothold-gc-test)

(defvar *root* nil)
(defvar *entered* nil)
(defvar *release* nil)
(defvar *interrupted* nil)
(defvar *result* nil)

(defun await (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 20 internal-time-units-per-second))))
    (loop until (funcall predicate)
          do (when (> (get-internal-real-time) deadline)
               (error "Foothold GC test timed out."))
             (sleep 0.01))))

(defun register-function (register)
  (let ((scratch (if (eq register :r9) :r10 :r9)))
    (eval
     `(mezzano.internals::define-lap-function register-worker ((object))
        (:gc :no-frame :layout #*0)
        (mezzano.lap.x86:mov64 ,register :r8)
        (mezzano.lap.x86:mov64 ,scratch (:symbol-global-cell *entered*))
        (mezzano.lap.x86:mov64 :rax (:constant t))
        (mezzano.lap.x86:mov64
         (:object ,scratch ,mezzano.internals::+symbol-value-cell-value+) :rax)
        wait
        (mezzano.lap.x86:mov64 ,scratch (:symbol-global-cell *release*))
        (mezzano.lap.x86:mov64
         ,scratch (:object ,scratch ,mezzano.internals::+symbol-value-cell-value+))
        (mezzano.lap.x86:cmp64 ,scratch :r14)
        (mezzano.lap.x86:jz wait)
        (mezzano.lap.x86:mov64 ,scratch (:symbol-global-cell *root*))
        (mezzano.lap.x86:mov64
         ,scratch (:object ,scratch ,mezzano.internals::+symbol-value-cell-value+))
        (mezzano.lap.x86:cmp64 ,register ,scratch)
        (mezzano.lap.x86:mov64 :r8 (:constant nil))
        (mezzano.lap.x86:cmov64z :r8 (:constant t))
        (mezzano.lap.x86:mov32 :ecx ,(ash 1 mezzano.internals::+n-fixnum-bits+))
        (:gc :no-frame :layout #*0 :multiple-values 0)
        (mezzano.lap.x86:ret)))
    #'register-worker))

(defun run-tests ()
  (let ((failures nil))
    (dolist (register '(:r8 :r9 :r10 :r11 :r12 :r13 :r15 :rbx))
      (setf *root* (vector :movable register)
            *entered* nil *release* nil *interrupted* nil *result* nil)
      (let* ((function (register-function register))
             (gate (mezzano.supervisor:make-event))
             (done (mezzano.supervisor:make-event))
             (before (mezzano.internals::lisp-object-address *root*))
             (thread (mezzano.supervisor:make-thread
                      (lambda ()
                        (setf *result* (funcall function *root*))
                        (setf (mezzano.supervisor:event-state done) t))
                      :name "Foothold GC register test")))
        (unwind-protect
             (progn
               (await (lambda () *entered*))
               (mezzano.supervisor:establish-thread-foothold
                thread
                (lambda ()
                  (setf *interrupted* t)
                  (mezzano.supervisor:event-wait gate)))
               (await (lambda () *interrupted*))
               (mezzano.extensions:gc :full t)
               (assert (/= before (mezzano.internals::lisp-object-address *root*)))
               (setf *release* t
                     (mezzano.supervisor:event-state gate) t)
               (await (lambda () (mezzano.supervisor:event-state done)))
               (format t "~A: ~A~%" register (if *result* "PASS" "FAIL"))
               (unless *result* (push register failures)))
          (setf *release* t
                (mezzano.supervisor:event-state gate) t))))
    (assert (null failures) () "Saved registers retained stale objects: ~S." failures))
  (format t "PASS movable objects in x86-64 saved data registers across foothold and full GC~%"))

(run-tests)
(in-package #:cl-user)
