(defpackage #:lispm-foothold-restoration-probe
  (:use #:cl)
  (:local-nicknames (#:s #:mezzano.supervisor))
  (:export #:run))
(in-package #:lispm-foothold-restoration-probe)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *state* nil)

(defmacro gated-with-footholds (&body body)
  (let* ((expansion (macroexpand-1 `(s:with-footholds ,@body)))
         (cleanup (third expansion)))
    (assert (and (eq (first expansion) 'let*)
                 (= (length expansion) 3)
                 (eq (first cleanup) 'unwind-protect)
                 (= (length cleanup) 3)
                 (eq (first (third cleanup)) 'setf)))
    (setf (cddr cleanup)
          `((progn
              (setf (getf *state* :gate-mask)
                    (s::thread-inhibit-footholds (s:current-thread))
                    (s:event-state (getf *state* :entered)) t)
              (s:event-wait (getf *state* :resume))
              ,@(cddr cleanup))))
    expansion))

(defun await (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 10 internal-time-units-per-second))))
    (loop until (funcall predicate)
          do (assert (< (get-internal-real-time) deadline))
             (s:thread-yield))))

(defun target ()
  (s:without-footholds
    (unwind-protect
         (s:allow-with-footholds
           (gated-with-footholds
             (setf (s:event-state (getf *state* :ready)) t)
             (s:event-wait (getf *state* :body))))
      (setf (getf *state* :outer-cleanup-mask)
            (s::thread-inhibit-footholds (s:current-thread))))))

(defun run ()
  (assert (null *state*))
  (setf *state* (list :ready (s:make-event) :body (s:make-event)
                     :entered (s:make-event) :resume (s:make-event)))
  (let ((thread (s:make-thread #'target :name "Owned foothold restoration probe")))
    (setf (getf *state* :thread) thread)
    (unwind-protect
         (progn
           (await (lambda () (s:event-state (getf *state* :ready))))
           (s:terminate-thread thread)
           (await (lambda () (s:event-state (getf *state* :entered))))
           (assert (zerop (getf *state* :gate-mask)))
           (s:terminate-thread thread)
           (setf (s:event-state (getf *state* :resume)) t)
           (await (lambda () (eq (s::sample-thread-state thread) :dead)))
           (let ((mask (getf *state* :outer-cleanup-mask)))
             (format t "Outer cleanup mask after repeated termination: ~S.~%" mask)
             (values mask (s::sample-thread-state thread))))
      (setf (s:event-state (getf *state* :body)) t
            (s:event-state (getf *state* :resume)) t))))
