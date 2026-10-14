(defpackage #:lispm-inspection-reference-test
  (:use #:cl #:mezzano.debug)
  (:local-nicknames (#:d #:mezzano.debug) (#:test #:lispm-service-test)
                    (#:frame #:lispm-frame-evaluation-test))
  (:export #:run #:prepare-restore-test #:finish-restore-test))
(in-package #:lispm-inspection-reference-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun target (state)
  (break "Owned inspection reference test.")
  (setf (aref state 2) :continued))

(defun retain-probes (state)
  (let* ((stop d::*service-current-stop*)
         (cycle (list 37))
         (shared (vector cycle cycle))
         (other (vector cycle cycle))
         (reference (d::retain-service-inspection-value stop shared :object))
         (cycle-reference (d::retain-service-inspection-value stop cycle :object))
         (nil-reference (d::retain-service-inspection-value stop nil :object))
         (part (d::retain-service-inspection-value stop (list reference :aref 0) :part)))
    (setf (cdr cycle) cycle)
    (assert (eq reference (d::retain-service-inspection-value stop shared :object)))
    (assert (not (eq reference (d::retain-service-inspection-value stop other :object))))
    (assert (eq nil-reference (d::retain-service-inspection-value stop nil :object)))
    (assert (null (d::service-inspection-reference-value nil-reference :object)))
    (assert (eq (first (d::service-inspection-reference-value part :part)) reference))
    (test::expect-error :expired-inspection-reference
                        (lambda () (d::service-inspection-reference-value part :object)))
    (mezzano.extensions:gc :full t)
    (assert (eq shared (d::service-inspection-reference-value reference :object)))
    (assert (eq (aref shared 0) (aref shared 1)))
    (assert (eq (aref shared 0)
                (d::service-inspection-reference-value cycle-reference :object)))
    (assert (eq cycle (cdr cycle)))
    (d::clear-service-inspection stop)
    (dolist (old (list reference cycle-reference nil-reference))
      (test::expect-error :released-inspection-reference
                          (lambda () (d::service-inspection-reference-value old :object))))
    (test::expect-error :released-inspection-reference
                        (lambda () (d::service-inspection-reference-value part :part)))
    (let ((fresh (d::retain-service-inspection-value stop shared :object)))
      (assert (> (d::service-inspection-reference-id fresh)
                 (d::service-inspection-reference-id part)))
      (setf (aref state 0) fresh
            (aref state 1) (d::retain-service-inspection-value stop nil :object))))
  :retained)

(defun run ()
  (let* ((controller (make-debugger-controller))
         (name (symbol-name (gensym "Inspection references ")))
         (state (make-array 3 :initial-element nil))
         (thread
           (mezzano.supervisor:make-thread
            (lambda ()
              (let ((*package* (find-package :lispm-inspection-reference-test)))
                (call-with-debugger-service
                 (lambda ()
                   (with-simple-restart (abort "Abort the owned inspection test.")
                     (target state))))))
            :name name))
         (handle nil))
    (unwind-protect
         (progn
           (setf handle (test::await (lambda () (test::stop-for-thread name))))
           (let* ((lease (attach-debugger-stop handle controller))
                  (stop (d::service-handle-stop handle)))
             (frame::select-function handle lease #'target)
             (frame::evaluate-source handle lease "(retain-probes state)" '(":RETAINED"))
             (test::expect-error
              :foreign-inspection-thread
              (lambda () (d::service-inspection-reference-value (aref state 0) :object)))
             (let ((other (d::%make-service-stop)))
               (test::expect-error
                :expired-inspection-reference
                (lambda ()
                  (d::with-service-lock
                    (d::check-service-inspection-reference (aref state 0) other :object)))))
             (assert (= (hash-table-count (d::service-stop-inspection-values stop)) 2))
             (frame::evaluate-source
              handle lease
              "(progn (mezzano.extensions:gc :full t) (length (mezzano.debug::service-inspection-reference-value (aref state 0) :object)))"
              '("2"))
             (let ((id (getf (debugger-stop-information handle) :next-command-id)))
               (submit-debugger-command lease id :proceed)
               (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
             (test::await (lambda () (nth-value 1 (mezzano.supervisor:thread-join thread nil))))
             (assert (eq (aref state 2) :continued))
             (assert (zerop (hash-table-count (d::service-stop-inspection-values stop))))
             (assert (zerop (hash-table-count (d::service-stop-inspection-identities stop))))
             (test::expect-error
              :expired-inspection-reference
              (lambda () (d::service-inspection-reference-value (aref state 0) :object)))
             (release-debugger-stop lease)
             (setf handle nil)
             (test::expect-error
              :released-stop
              (lambda () (d::service-inspection-reference-value (aref state 0) :object)))))
      (when handle (frame::release-test-stop handle controller))
      (close-debugger-controller controller)))
  (format t "PASS inspection reference identity, cycles, shared objects, NIL, part kinds, moving GC, Clear, monotonic IDs, owning thread, stop exit, and release.~%")
  t)

(defvar *restore-state* nil)
(defvar *restore-thread* nil)
(defvar *restore-handle* nil)

(defun restored-probes (state)
  (let* ((stop d::*service-current-stop*)
         (old (aref state 0))
         (id (d::service-inspection-reference-id old))
         (object (car (gethash id (d::service-stop-inspection-values stop)))))
    (test::expect-error :expired-stop
                        (lambda () (d::service-inspection-reference-value old :object)))
    (mezzano.extensions:gc :full t)
    (let ((fresh (d::retain-service-inspection-value stop object :object)))
      (assert (not (eq fresh old)))
      (assert (= id (d::service-inspection-reference-id fresh)))
      (assert (eq fresh (d::retain-service-inspection-value stop object :object)))
      (assert (eq object (d::service-inspection-reference-value fresh :object)))
      (assert (eq (aref object 0) (aref object 1)))
      (assert (eq (aref object 0) (cdr (aref object 0))))
      (setf (aref state 0) fresh))
    (let ((fresh (d::retain-service-inspection-value stop nil :object)))
      (assert (= (d::service-inspection-reference-id (aref state 1))
                 (d::service-inspection-reference-id fresh)))
      (assert (null (d::service-inspection-reference-value fresh :object)))
      (setf (aref state 1) fresh)))
  :restored)

(defun prepare-restore-test ()
  (assert (null *restore-state*))
  (assert (null (test::stop-for-thread "Inspection reference restore test")))
  (setf *restore-state* (make-array 3 :initial-element nil)
        *restore-thread*
        (mezzano.supervisor:make-thread
         (lambda ()
           (let ((*package* (find-package :lispm-inspection-reference-test)))
             (call-with-debugger-service
              (lambda ()
                (with-simple-restart (abort "Abort the owned inspection restoration test.")
                  (target *restore-state*))))))
         :name "Inspection reference restore test")
        *restore-handle*
        (test::await (lambda () (test::stop-for-thread "Inspection reference restore test"))))
  (let* ((controller (make-debugger-controller))
         (lease (attach-debugger-stop *restore-handle* controller)))
    (unwind-protect
         (progn
           (frame::select-function *restore-handle* lease #'target)
           (frame::evaluate-source *restore-handle* lease "(retain-probes state)" '(":RETAINED")))
      (close-debugger-controller controller)))
  (format t "Prepared inspection references and shared cyclic values for restoration.~%")
  t)

(defun finish-restore-test ()
  (test::expect-error
   :expired-stop (lambda () (d::service-inspection-reference-value (aref *restore-state* 0) :object)))
  (let* ((controller (make-debugger-controller))
         (handle (test::stop-for-thread "Inspection reference restore test"))
         (lease nil))
    (assert handle)
    (setf lease (attach-debugger-stop handle controller))
    (unwind-protect
         (let ((stop (d::service-handle-stop handle)))
           (assert (= (d::service-stop-id stop)
                      (d::service-stop-id (d::service-handle-stop *restore-handle*))))
           (frame::evaluate-source handle lease "(restored-probes state)" '(":RESTORED"))
           (let ((id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id :proceed)
             (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
           (test::await
            (lambda () (nth-value 1 (mezzano.supervisor:thread-join *restore-thread* nil))))
           (assert (eq (aref *restore-state* 2) :continued))
           (assert (zerop (hash-table-count (d::service-stop-inspection-values stop))))
           (assert (zerop (hash-table-count (d::service-stop-inspection-identities stop))))
           (release-debugger-stop lease)
           (setf handle nil)
           (test::expect-error
            :released-stop
            (lambda () (d::service-inspection-reference-value (aref *restore-state* 0) :object)))
           (setf *restore-state* nil *restore-thread* nil *restore-handle* nil))
      (when handle (frame::release-test-stop handle controller))
      (close-debugger-controller controller)))
  (format t "PASS restored inspection values, expired old references, renewed identity, cycles, NIL, moving GC, continuation, and cleanup.~%")
  t)
