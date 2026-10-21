(defpackage #:lispm-startup-restore-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug) (#:test #:lispm-service-test))
  (:export #:prepare #:check-restored #:finish #:resolve-stop))
(in-package #:lispm-startup-restore-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defstruct restore-test
  phase boot early ordinary late init-file (effects nil))

(defvar *case* nil)

(defun note-effect (effect)
  (push effect (restore-test-effects *case*)))

(defun checkpoint (phase)
  (when (eq phase (restore-test-phase *case*))
    (cerror "Continue the owned restore operation."
            "Owned startup restore recovery test: ~S." phase)))

(defun early-hook ()
  (note-effect :early-before)
  (checkpoint :early)
  (note-effect :early-after))

(defun ordinary-hook ()
  (note-effect :ordinary-before)
  (checkpoint :ordinary)
  (note-effect :ordinary-after))

(defun late-hook ()
  (note-effect :late-before)
  (checkpoint :late)
  (note-effect :late-after))

(defun init-hook ()
  (note-effect :init-before)
  (checkpoint :init-file)
  (note-effect :init-after))

(defun await-count (expected)
  (let ((samples nil))
    (test::await
     (lambda ()
       (let ((actual s::*snapshot-inhibit*))
         (push actual samples)
         (when (< actual expected)
           (error "Snapshot count ~D is below the owned count ~D."
                  actual expected))
         (when (= actual expected) t)))
     30)
    (format t "Snapshot counter samples: ~S.~%" (nreverse samples))))

(defun worker-sleeping-p ()
  (and (eq (s::thread-state s::*post-boot-worker-thread*) :sleeping)
       (equal (s::thread-wait-item s::*post-boot-worker-thread*) "Next boot")))

(defun prepare (phase &key init-file)
  (check-type phase (member :early :ordinary :late :init-file))
  (assert (null *case*))
  (let ((status (i::startup-status)))
    (assert (eq (getf status :state) :complete))
    (assert (eq (getf status :boot-id) (s:current-boot-id))))
  (assert (worker-sleeping-p))
  (await-count 0)
  (when (eq phase :init-file)
    (assert (and init-file (probe-file init-file))))
  (s:with-snapshot-inhibited ()
    (s:with-mutex (s::*boot-hook-lock*)
      (setf *case*
            (make-restore-test
             :phase phase :boot (s:current-boot-id)
             :early s::*early-boot-hooks* :ordinary s::*boot-hooks*
             :late s::*late-boot-hooks* :init-file i::*init-file-path*))
      (push #'early-hook s::*early-boot-hooks*)
      (push #'ordinary-hook s::*boot-hooks*)
      (push #'late-hook s::*late-boot-hooks*)
      (when (eq phase :init-file)
        (setf i::*init-file-path* init-file))))
  :startup-restore-prepared)

(defun expected-effects (phase abort-p)
  (let ((all '(:early-before :early-after :ordinary-before :ordinary-after
               :late-before :late-after :init-before :init-after)))
    (subseq all 0
            (if abort-p
                (ecase phase (:early 1) (:ordinary 3) (:late 5) (:init-file 7))
                (if (eq phase :init-file) 8 6)))))

(defun check-restored (&key abort-p)
  (assert *case*)
  (assert (not (eq (restore-test-boot *case*) (s:current-boot-id))))
  (test::await #'worker-sleeping-p 30)
  (let ((status (i::startup-status)))
    (assert (eq (getf status :kind) :restore))
    (assert (eq (getf status :boot-id) (s:current-boot-id)))
    (assert (eq (getf status :thread) s::*post-boot-worker-thread*))
    (assert (eq (getf status :state) (if abort-p :incomplete :complete))))
  (assert (equal (reverse (restore-test-effects *case*))
                 (expected-effects (restore-test-phase *case*) abort-p)))
  (await-count (if abort-p 1 0))
  (format t "PASS actual restore ~S ~A, effects ~S, worker asleep for Next boot.~%"
          (restore-test-phase *case*) (if abort-p :abort :continue)
          (reverse (restore-test-effects *case*)))
  (if abort-p :startup-restore-abort-verified :startup-restore-continue-verified))

(defun finish ()
  (check-restored)
  (s:with-snapshot-inhibited ()
    (s:with-mutex (s::*boot-hook-lock*)
      (assert (equal s::*early-boot-hooks*
                     (cons #'early-hook (restore-test-early *case*))))
      (assert (equal s::*boot-hooks*
                     (cons #'ordinary-hook (restore-test-ordinary *case*))))
      (assert (equal s::*late-boot-hooks*
                     (cons #'late-hook (restore-test-late *case*))))
      (setf s::*early-boot-hooks* (restore-test-early *case*)
            s::*boot-hooks* (restore-test-ordinary *case*)
            s::*late-boot-hooks* (restore-test-late *case*)
            i::*init-file-path* (restore-test-init-file *case*)
            *case* nil)))
  :startup-restore-finished)

(defun resolve-stop (action)
  (check-type action (member :continue :abort))
  (assert *case*)
  (let* ((status (i::startup-status))
         (thread s::*post-boot-worker-thread*)
         (handle (test::await
                  (lambda () (test::stop-for-thread (s:thread-name thread))))))
    (assert (eq (getf status :kind) :restore))
    (assert (eq (getf status :state) :running))
    (assert (eq (getf status :boot-id) (s:current-boot-id)))
    (assert (eq (getf status :thread) thread))
    (let ((controller (d:make-debugger-controller)))
     (unwind-protect
         (let* ((lease (d:attach-debugger-stop handle controller))
                (condition (test::command handle lease :condition))
                (frames (test::command handle lease :frames))
                (restarts (test::command handle lease :restarts))
                (restart (find (if (eq action :abort) "ABORT" "CONTINUE")
                               restarts :test #'equal
                               :key (lambda (restart) (getf restart :name)))))
           (assert (search "Owned startup restore recovery test:" condition))
           (assert frames)
           (assert restart)
           (assert (equal (getf restart :description)
                          (if (eq action :abort)
                              "Abort this startup sequence."
                              "Continue the owned restore operation.")))
           (format t "Condition ~S.~%Frame count ~D.~%Restarts ~S.~%"
                   condition (length frames) restarts)
           (await-count 1)
           (let ((id (getf (d:debugger-stop-information handle) :next-command-id)))
             (if (eq action :abort)
                 (d:submit-debugger-command lease id :abort)
                 (d:submit-debugger-command lease id :invoke-restart
                                           (getf restart :index)))
             (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
           (if (eq action :abort) (check-restored :abort-p t) (finish))
           (d:release-debugger-stop lease))
      (d:close-debugger-controller controller))))
  (if (eq action :abort) :startup-restore-abort-tested :startup-restore-continue-tested))
