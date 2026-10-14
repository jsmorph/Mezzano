(defpackage #:lispm-thread-id-test
  (:use #:cl)
  (:export #:prepare #:check-retained #:check-collected #:finish #:run))
(in-package #:lispm-thread-id-test)

(defvar *records* nil)
(defvar *live* nil)
(defvar *live-id* nil)
(defvar *gate* nil)

(defun worker () :finished)

(defun completed-thread (register)
  (let ((thread (mezzano.supervisor:make-thread
                 #'worker :name "SWANK thread lifetime test" :stack-size 65536)))
    (assert (equal (mezzano.supervisor:thread-join thread) '(:finished)))
    (loop until (eq (mezzano.supervisor:thread-state thread) :dead)
          do (sleep 0.001))
    (let ((stack (mezzano.supervisor::thread-stack thread)))
      (list (mezzano.internals::make-weak-pointer thread)
            (mezzano.internals::make-weak-pointer stack)
            (mezzano.supervisor::stack-base stack)
            (mezzano.supervisor::stack-size stack)
            (when register (swank/backend:thread-id thread))))))

(defun wait-for-gate ()
  (mezzano.supervisor:event-wait *gate*))

(defun prepare ()
  (assert (null *records*))
  (setf *gate* (mezzano.supervisor:make-event)
        *live* (mezzano.supervisor:make-thread
                #'wait-for-gate :name "SWANK live ID test" :stack-size 65536)
        *live-id* (swank/backend:thread-id *live*)
        *records* (list (completed-thread nil) (completed-thread t)))
  :prepared)

(defun mapped-pages (record)
  (mezzano.supervisor:with-rw-lock-read (mezzano.supervisor::*vm-lock*)
    (loop for address from (third record) below (+ (third record) (fourth record))
          by 4096
          count (mezzano.supervisor::block-info-for-virtual-address address))))

(defun check-live ()
  (assert (eq *live* (swank/backend:find-thread *live-id*)))
  (assert (= *live-id* (swank/backend:thread-id *live*))))

(defun await-released (record)
  (let ((end (+ (get-internal-real-time) (* 10 internal-time-units-per-second))))
    (loop while (plusp (mapped-pages record))
          do (assert (< (get-internal-real-time) end) () "Stack pages were not released.")
             (sleep 0.01)))
  (assert (not (nth-value 1 (mezzano.internals::weak-pointer-value (first record)))))
  (assert (not (nth-value 1 (mezzano.internals::weak-pointer-value (second record))))))

(defun check-retained ()
  (check-live)
  (await-released (first *records*))
  (let ((record (second *records*)))
    (assert (nth-value 1 (mezzano.internals::weak-pointer-value (first record))))
    (assert (= (mapped-pages record) (/ (fourth record) 4096)))
    (assert (eq (mezzano.internals::weak-pointer-value (first record))
                (swank/backend:find-thread (fifth record)))))
  :registered-thread-retained)

(defun check-collected ()
  (check-live)
  (dolist (record *records*)
    (await-released record)
    (when (fifth record)
      (assert (null (swank/backend:find-thread (fifth record))))))
  :completed-threads-and-stacks-collected)

(defun finish ()
  (setf (mezzano.supervisor:event-state *gate*) t)
  (mezzano.supervisor:thread-join *live*)
  (setf *live* nil *live-id* nil *gate* nil *records* nil)
  :finished)

(defun run ()
  (prepare)
  (mezzano.extensions:gc :full t)
  (check-collected)
  (finish))
