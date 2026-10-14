(defpackage #:lispm-thread-unlink-test
  (:use #:cl)
  (:export #:prepare #:check-retained #:check-collected #:finish #:run))
(in-package #:lispm-thread-unlink-test)

(defvar *older-gate* nil)
(defvar *retained-gate* nil)
(defvar *retained* nil)
(defvar *record* nil)

(defun older-worker ()
  (mezzano.supervisor:event-wait *older-gate*)
  :older-finished)

(defun retained-worker ()
  (mezzano.supervisor:event-wait *retained-gate*)
  :retained-finished)

(defun join-dead (thread expected)
  (assert (equal (mezzano.supervisor:thread-join thread) (list expected)))
  (let ((end (+ (get-internal-real-time) (* 10 internal-time-units-per-second))))
    (loop until (eq (mezzano.supervisor:thread-state thread) :dead)
          do (assert (< (get-internal-real-time) end))
             (sleep 0.001))))

(defun prepare ()
  (assert (null *retained*))
  (setf *older-gate* (mezzano.supervisor:make-event)
        *retained-gate* (mezzano.supervisor:make-event))
  (let ((older (mezzano.supervisor:make-thread
                #'older-worker :name "Thread unlink older" :stack-size 65536)))
    (setf *retained* (mezzano.supervisor:make-thread
                     #'retained-worker :name "Thread unlink retained" :stack-size 65536))
    (assert (eq older (mezzano.supervisor::thread-global-next *retained*)))
    (let ((stack (mezzano.supervisor::thread-stack older)))
      (setf *record* (list (mezzano.internals::make-weak-pointer older)
                          (mezzano.internals::make-weak-pointer stack)
                          (mezzano.supervisor::stack-base stack)
                          (mezzano.supervisor::stack-size stack))))
    (setf (mezzano.supervisor:event-state *retained-gate*) t)
    (join-dead *retained* :retained-finished)
    (setf (mezzano.supervisor:event-state *older-gate*) t)
    (join-dead older :older-finished))
  :prepared)

(defun check-live-list ()
  (let ((threads (mezzano.supervisor:all-threads)))
    (assert (member (mezzano.supervisor:current-thread) threads))
    (assert (= (length threads) (length (remove-duplicates threads :test #'eq))))
    (assert (not (member *retained* threads)))
    (assert (not (member (mezzano.internals::weak-pointer-value (first *record*))
                         threads)))))

(defun check-retained ()
  (check-live-list)
  (assert (nth-value 1 (mezzano.internals::weak-pointer-value (first *record*))))
  (assert (eq (mezzano.supervisor::thread-global-next *retained*)
              (mezzano.internals::weak-pointer-value (first *record*))))
  (assert (= (lispm-thread-id-test::mapped-pages *record*) (/ (fourth *record*) 4096)))
  :neighbor-retained)

(defun check-collected ()
  (check-live-list)
  (assert (null (mezzano.supervisor::thread-global-next *retained*)))
  (assert (null (mezzano.supervisor::thread-global-prev *retained*)))
  (lispm-thread-id-test::await-released *record*)
  (join-dead *retained* :retained-finished)
  :neighbor-and-stack-collected)

(defun finish ()
  (setf *retained* nil *record* nil *older-gate* nil *retained-gate* nil)
  :finished)

(defvar *enumeration-gate* nil)

(defun enumeration-worker ()
  (mezzano.supervisor:event-wait *enumeration-gate*)
  :enumerated)

(defun churn-worker ()
  (dotimes (index 100)
    (let ((thread (mezzano.supervisor:make-thread
                   #'lispm-thread-id-test::worker
                   :name "Thread enumeration churn" :stack-size 65536)))
      (join-dead thread :finished)))
  :churn-finished)

(defun enumeration-test ()
  (setf *enumeration-gate* (mezzano.supervisor:make-event))
  (let ((threads nil))
    (unwind-protect
         (progn
           (dotimes (index 100)
             (push (mezzano.supervisor:make-thread
                    #'enumeration-worker :name "Thread enumeration waiter"
                    :stack-size 65536)
                   threads))
           (let ((captured (mezzano.supervisor:all-threads)))
             (assert (> (length captured) 64))
             (assert (every (lambda (thread) (member thread captured)) threads))
             (assert (= (length captured)
                        (length (remove-duplicates captured :test #'eq)))))
           (let ((producer (mezzano.supervisor:make-thread
                            #'churn-worker :name "Thread enumeration producer"))
                 (end (+ (get-internal-real-time) (* 60 internal-time-units-per-second))))
             (loop
               (let ((captured (mezzano.supervisor:all-threads)))
                 (assert (every (lambda (thread) (member thread captured)) threads))
                 (assert (member (mezzano.supervisor:current-thread) captured))
                 (assert (= (length captured)
                            (length (remove-duplicates captured :test #'eq)))))
               (when (eq (mezzano.supervisor:thread-state producer) :dead)
                 (return))
               (assert (< (get-internal-real-time) end))
               (sleep 0.001))
             (join-dead producer :churn-finished)))
      (setf (mezzano.supervisor:event-state *enumeration-gate*) t)
      (dolist (thread threads) (join-dead thread :enumerated))
      (setf *enumeration-gate* nil)))
  :concurrent-enumeration-passed)

(defun run ()
  (prepare)
  (mezzano.extensions:gc :full t)
  (check-collected)
  (finish)
  (enumeration-test))
