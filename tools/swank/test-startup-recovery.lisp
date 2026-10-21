(defpackage #:lispm-startup-recovery-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug) (#:test #:lispm-service-test))
  (:export #:run))
(in-package #:lispm-startup-recovery-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defstruct scenario
  phase abort-p function init-file baseline thread controller handle lease
  result status count-after values (effects nil) (cleanup 0)
  (returned (s:make-event :name "Startup function returned"))
  (release (s:make-event :name "Release startup test cleanup")))

(defvar *scenario* nil)
(defvar *case* nil)

(defun note-effect (effect)
  (push effect (scenario-effects *scenario*)))

(defun checkpoint ()
  (let ((copy (i::startup-status)))
    (assert (eq (getf copy :state) :running))
    (assert (eq (getf copy :thread) (s:current-thread)))
    (assert (eq (getf copy :boot-id) (s:current-boot-id)))
    (setf (getf copy :state) :changed)
    (assert (eq (getf (i::startup-status) :state) :running)))
  (setf (scenario-values *scenario*)
        (multiple-value-list
         (restart-case (error "Owned startup failure.")
           (continue ()
             :report "Continue the owned startup operation."
             (values 11 22)))))
  (assert (equal (scenario-values *scenario*) '(11 22))))

(defun early-hook ()
  (note-effect :early-before)
  (when (eq (scenario-phase *scenario*) :early) (checkpoint))
  (note-effect :early-after))

(defun ordinary-hook ()
  (note-effect :ordinary-before)
  (when (eq (scenario-phase *scenario*) :ordinary) (checkpoint))
  (note-effect :ordinary-after))

(defun late-hook ()
  (note-effect :late-before)
  (when (eq (scenario-phase *scenario*) :late) (checkpoint))
  (note-effect :late-after))

(defun sequence-body ()
  (note-effect :before)
  (case (scenario-phase *scenario*)
    (:initialization (checkpoint))
    (:init-file
     (let ((i::*init-file-path* (scenario-init-file *scenario*)))
       (funcall (scenario-function *scenario*))))
    (otherwise (funcall (scenario-function *scenario*))))
  (note-effect :after))

(defun worker (case)
  (let ((*scenario* case) (i::*startup-status* nil))
    (d:call-with-debugger-service
     (lambda ()
       (with-simple-restart (abort "Abort the owned startup test worker.")
         (unwind-protect
              (progn
                (setf (scenario-result case)
                      (i::call-with-startup-sequence
                       (if (member (scenario-phase case) '(:initialization :init-file))
                           :initialization :restore)
                       #'sequence-body)
                      (scenario-status case) (i::startup-status))
                (setf (s:event-state (scenario-returned case)) t)
                (s:event-wait (scenario-release case)))
           (incf (scenario-cleanup case))
           (when (eq (getf (i::startup-status) :state) :incomplete)
             (i::%atomic-fixnum-add-symbol 's::*snapshot-inhibit* -1)))))))
  :startup-worker-finished)

(defun expected-effects (phase abort-p)
  (if (member phase '(:initialization :init-file))
      (if abort-p '(:before) '(:before :after))
      (let ((all '(:before :early-before :early-after :ordinary-before
                   :ordinary-after :late-before :late-after :after)))
        (if abort-p
            (subseq all 0 (ecase phase (:early 2) (:ordinary 4) (:late 6)))
            all))))

(defun await-snapshot-count (expected)
  (test::await
   (lambda ()
     (let ((actual s::*snapshot-inhibit*))
       (when (< actual expected)
         (error "Snapshot count ~D is below the test's owned count ~D." actual expected))
       (when (= actual expected) actual)))))

(defun run-case (phase abort-p function init-file)
  (assert (null *case*))
  (assert (null (test::stop-for-thread "Startup recovery test")))
  (let* ((case (make-scenario :phase phase :abort-p abort-p :function function
                              :init-file init-file :baseline (await-snapshot-count 1)))
         (controller (d:make-debugger-controller)))
    (setf *case* case
          (scenario-controller case) controller
          (scenario-thread case)
          (s:make-thread (lambda () (worker case)) :name "Startup recovery test")
          (scenario-handle case)
          (test::await (lambda () (test::stop-for-thread "Startup recovery test")))
          (scenario-lease case) (d:attach-debugger-stop (scenario-handle case) controller))
    (let* ((handle (scenario-handle case)) (lease (scenario-lease case))
           (condition (test::command handle lease :condition))
           (frames (test::command handle lease :frames))
           (restarts (test::command handle lease :restarts))
           (abort (find "ABORT" restarts :test #'string=
                        :key (lambda (entry) (getf entry :name)))))
      (assert (search "Owned startup failure." condition))
      (assert (find-if (lambda (entry) (search "CHECKPOINT" (getf entry :function))) frames))
      (assert (and abort (equal (getf abort :description) "Abort this startup sequence.")))
      (await-snapshot-count (1+ (scenario-baseline case)))
      (when (and (eq phase :initialization) (not abort-p))
        (mezzano.extensions:gc :full t)
        (assert (search "Owned startup failure." (test::command handle lease :condition))))
      (let ((id (getf (d:debugger-stop-information handle) :next-command-id)))
        (if abort-p
            (d:submit-debugger-command lease id :abort)
            (d:submit-debugger-command lease id :invoke-restart
                                      (getf (find "CONTINUE" restarts :test #'string=
                                                  :key (lambda (entry) (getf entry :name)))
                                            :index)))
        (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
      (test::await (lambda () (s:event-state (scenario-returned case))))
      (setf (scenario-count-after case)
            (await-snapshot-count (+ (scenario-baseline case) (if abort-p 1 0))))
      (setf (s:event-state (scenario-release case)) t)
      (test::await (lambda () (nth-value 1 (s:thread-join (scenario-thread case) nil))))
      (assert (equal (s:thread-join (scenario-thread case)) '(:startup-worker-finished)))
      (assert (eq (scenario-result case) (not abort-p)))
      (assert (eq (getf (scenario-status case) :state)
                  (if abort-p :incomplete :complete)))
      (assert (= (scenario-count-after case)
                 (+ (scenario-baseline case) (if abort-p 1 0))))
      (await-snapshot-count (scenario-baseline case))
      (assert (= (scenario-cleanup case) 1))
      (assert (equal (reverse (scenario-effects case)) (expected-effects phase abort-p)))
      (assert (equal (scenario-values case) (unless abort-p '(11 22))))
      (d:release-debugger-stop lease)
      (d:close-debugger-controller controller)
      (setf *case* nil)))
  (format t "PASS startup ~S ~A, restart values, effects, cleanup and Snapshot accounting.~%"
          phase (if abort-p :abort :continue)))

(defun check-borrowed-inhibition ()
  (let ((i::*startup-status* nil))
    (assert (i::call-with-startup-sequence
             :restore (lambda () (assert (eq (getf (i::startup-status) :state) :running)))
             :inhibit-snapshot nil))
    (assert (eq (getf (i::startup-status) :state) :complete))
    (await-snapshot-count 1)
    (assert (not (i::call-with-startup-sequence :restore #'abort :inhibit-snapshot nil)))
    (assert (eq (getf (i::startup-status) :state) :incomplete))
    (await-snapshot-count 1))
  (format t "PASS restore startup preserves the caller's inhibition on return and Abort.~%"))

(defun run (&key (hooks #'s::run-boot-hooks) (init-file-loader #'i::load-init-file)
                 init-file)
  (assert init-file)
  (assert (null *case*))
  (assert (eq (s::thread-state s::*post-boot-worker-thread*) :sleeping))
  (let ((original (i::startup-status))
        (early s::*early-boot-hooks*) (ordinary s::*boot-hooks*) (late s::*late-boot-hooks*)
        (baseline (test::await (lambda () (when (zerop s::*snapshot-inhibit*) 0)))))
    (s:with-snapshot-inhibited ()
      (unwind-protect
           (progn
             (check-borrowed-inhibition)
             (s:with-mutex (s::*boot-hook-lock*)
               (setf s::*early-boot-hooks* (list #'early-hook)
                     s::*boot-hooks* (list #'ordinary-hook)
                     s::*late-boot-hooks* (list #'late-hook)))
             (dolist (abort-p '(nil t))
               (run-case :initialization abort-p nil init-file)
               (run-case :init-file abort-p init-file-loader init-file)
               (dolist (phase '(:early :ordinary :late))
                 (run-case phase abort-p hooks init-file))))
        (s:with-mutex (s::*boot-hook-lock*)
          (setf s::*early-boot-hooks* early s::*boot-hooks* ordinary s::*late-boot-hooks* late))))
    (await-snapshot-count baseline)
    (assert (equal (i::startup-status) original))
    (assert (eq s::*early-boot-hooks* early))
    (assert (eq s::*boot-hooks* ordinary))
    (assert (eq s::*late-boot-hooks* late)))
  :startup-recovery-tested)
