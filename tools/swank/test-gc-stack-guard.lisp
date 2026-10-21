(defpackage #:lispm-gc-stack-guard-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug) (#:test #:lispm-service-test))
  (:export #:run))
(in-package #:lispm-gc-stack-guard-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defstruct scenario
  thread controller handle lease (depth 0) (cleanup 0) (completed 0)
  (returned (s:make-event :name "Stack overflow unwound"))
  (release (s:make-event :name "Next stack overflow")))

(defvar *case* nil)
(defvar *scenario* nil)

(defun recurse (n)
  (let ((cell (cons n n)))
    (unwind-protect
         (progn
           (incf (scenario-depth *scenario*))
           (recurse (1+ n)))
      (assert (and (= (car cell) n) (= (cdr cell) n)))
      (incf (scenario-cleanup *scenario*)))))

(defun worker (case)
  (let ((*scenario* case))
    (d:call-with-debugger-service
     (lambda ()
       (dotimes (round 2)
         (setf (scenario-depth case) 0 (scenario-cleanup case) 0)
         (with-simple-restart (abort "Abort the owned stack-overflow test.")
           (recurse 0))
         (assert (= (scenario-depth case) (scenario-cleanup case)))
         (incf (scenario-completed case))
         (setf (s:event-state (scenario-returned case)) t)
         (s:event-wait (scenario-release case))
         (setf (s:event-state (scenario-release case)) nil)))))
  :gc-stack-worker-finished)

(defun return-page (case)
  (+ (s::stack-base (s:thread-stack (scenario-thread case)))
     s::+thread-stack-soft-guard-size+))

(defun assert-guard (case)
  (assert (s::thread-stack-guard-page-state (scenario-thread case)))
  (s::with-rw-lock-read (s::*vm-lock*)
    (let ((info (s::block-info-for-virtual-address (return-page case))))
      (assert info)
      (assert (logtest info i::+block-map-present+))
      (assert (not (logtest info i::+block-map-writable+))))))

(defun page-words (case)
  (let ((words (make-array (/ s::+thread-stack-guard-return-size+ 8)
                           :element-type '(unsigned-byte 64))))
    (dotimes (index (length words) words)
      (setf (aref words index)
            (i::memref-unsigned-byte-64 (return-page case) index)))))

(defun collect-stopped (case full)
  (assert-guard case)
  (let ((before (page-words case))
        (minor i::*gc-minor-cycles*) (major i::*gc-major-cycles*))
    (mezzano.extensions:gc :full full)
    (assert-guard case)
    (let* ((after (page-words case))
           (changed (loop for old across before for new across after
                          count (/= old new))))
      (assert (plusp changed) () "Collection changed no return-page roots.")
      (assert (> (if full i::*gc-major-cycles* i::*gc-minor-cycles*)
                 (if full major minor)))
      (format t "PASS ~A collection moved ~D return-page words; guard remains armed/read-only.~%"
              (if full :major :minor) changed))))

(defun run ()
  (assert (null *case*))
  (assert (null (test::stop-for-thread "GC stack guard test")))
  (s:with-snapshot-inhibited ()
    (let* ((case (make-scenario :controller (d:make-debugger-controller))))
      (setf *case* case
            (scenario-thread case)
            (s:make-thread (lambda () (worker case))
                           :name "GC stack guard test" :stack-size #x20000))
      (dotimes (round 2)
        (let* ((handle (test::await
                        (lambda () (test::stop-for-thread "GC stack guard test"))))
               (lease (d:attach-debugger-stop handle (scenario-controller case))))
          (setf (scenario-handle case) handle (scenario-lease case) lease)
          (let ((condition (test::command handle lease :condition))
                (frames (test::command handle lease :frames))
                (restarts (test::command handle lease :restarts)))
            (assert (search "Stack overflow" condition))
            (assert frames)
            (assert (equal
                     (getf (find "ABORT" restarts :test #'equal
                                 :key (lambda (restart) (getf restart :name)))
                           :description)
                     "Abort the owned stack-overflow test."))
            (format t "Actual overflow ~D, ~D frames, condition ~S.~%"
                    (1+ round) (length frames) condition))
          (collect-stopped case nil)
          (collect-stopped case t)
          (let ((id (getf (d:debugger-stop-information handle) :next-command-id)))
            (d:submit-debugger-command lease id :abort)
            (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
          (test::await (lambda () (s:event-state (scenario-returned case))))
          (assert (= (scenario-completed case) (1+ round)))
          (assert (plusp (scenario-depth case)))
          (assert (= (scenario-depth case) (scenario-cleanup case)))
          (format t "PASS Abort checked ~D movable cells and ~D cleanups.~%"
                  (scenario-depth case) (scenario-cleanup case))
          (d:release-debugger-stop lease)
          (setf (scenario-handle case) nil (scenario-lease case) nil
                (s:event-state (scenario-returned case)) nil
                (s:event-state (scenario-release case)) t)))
      (test::await (lambda () (nth-value 1 (s:thread-join (scenario-thread case) nil))))
      (assert (equal (s:thread-join (scenario-thread case)) '(:gc-stack-worker-finished)))
      (d:close-debugger-controller (scenario-controller case))
      (setf *case* nil)))
  :gc-stack-guard-tested)
