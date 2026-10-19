;; x86-64.  LOAD this compiled file with :WIRED T before test-snapshot-cow.lisp.
(defpackage #:lispm-snapshot-cow-test
  (:use #:cl)
  (:export #:probe #:run #:save-with-collection #:finish-restore))
(in-package #:lispm-snapshot-cow-test)

(declaim (optimize (safety 3) (debug 1) (speed 1)))

(defun set-copy-protection (address enabled ignored)
  (declare (ignore ignored))
  (mezzano.supervisor::with-rw-lock-write (mezzano.supervisor::*vm-lock*)
    (let* ((pte (mezzano.supervisor::get-pte-for-address address nil))
           (entry (mezzano.supervisor::page-table-entry pte)))
      (mezzano.supervisor::begin-tlb-shootdown)
      (setf (mezzano.supervisor::page-table-entry pte)
            (if enabled
                (logand (logior entry mezzano.supervisor::+x86-64-pte-copy-on-write+)
                        (lognot mezzano.supervisor::+x86-64-pte-write+))
                (logand (logior entry mezzano.supervisor::+x86-64-pte-write+)
                        (lognot mezzano.supervisor::+x86-64-pte-copy-on-write+))))
      (mezzano.supervisor::flush-tlb-single address)
      (mezzano.supervisor::tlb-shootdown-single address)
      (mezzano.supervisor::finish-tlb-shootdown)))
  nil)

(defun page-state (address ignored-1 ignored-2)
  (declare (ignore ignored-1 ignored-2))
  (mezzano.supervisor::with-rw-lock-read (mezzano.supervisor::*vm-lock*)
    (logand (mezzano.supervisor::page-table-entry
             (mezzano.supervisor::get-pte-for-address address nil))
            (logior mezzano.supervisor::+x86-64-pte-copy-on-write+
                    mezzano.supervisor::+x86-64-pte-write+))))

(mezzano.internals::defglobal *original-writeback* nil)
(mezzano.internals::defglobal *writeback-ready* nil)
(mezzano.internals::defglobal *writeback-release* nil)
(mezzano.internals::defglobal *writeback-observation* nil)

(defstruct (writeback-observation (:area :wired))
  boot collector completion cycles minor major epoch young old pending deadline
  (outcome :prepared) (mutated-p nil))

(defun observe-collector ()
  (let ((observation *writeback-observation*))
    (mezzano.supervisor::safe-without-interrupts (observation)
      (mezzano.supervisor::with-global-thread-lock ()
        (let ((collector (writeback-observation-collector observation)))
          (cond
            ((or (/= mezzano.internals::*gc-cycles* (writeback-observation-cycles observation))
                 (/= mezzano.internals::*gc-minor-cycles* (writeback-observation-minor observation))
                 (/= mezzano.internals::*gc-major-cycles* (writeback-observation-major observation))
                 (/= mezzano.internals::*gc-epoch* (writeback-observation-epoch observation))
                 (/= mezzano.internals::*young-gen-newspace-bit* (writeback-observation-young observation))
                 (/= mezzano.internals::*old-gen-newspace-bit* (writeback-observation-old observation)))
             :collection-started)
            ((and (eq mezzano.supervisor::*world-stopper* collector)
                  (eq (mezzano.supervisor::thread-state collector) :sleeping)
                  (eq (mezzano.supervisor::thread-wait-item collector)
                      (writeback-observation-completion observation)))
             (cond
               ((not mezzano.internals::*gc-in-progress*) :missing-gc-state)
               ((not mezzano.supervisor::*snapshot-writeout-in-progress*) :missing-writeout-state)
               ((mezzano.supervisor:event-state (writeback-observation-completion observation))
                :premature-completion)
               ((not (writeback-observation-mutated-p observation)) :collection-before-mutation)
               (t :observed)))))))))

(defun held-writeback ()
  (let ((observation *writeback-observation*))
    (when (eq (writeback-observation-boot observation)
              (mezzano.supervisor:current-boot-id))
      (setf (writeback-observation-cycles observation) mezzano.internals::*gc-cycles*
            (writeback-observation-minor observation) mezzano.internals::*gc-minor-cycles*
            (writeback-observation-major observation) mezzano.internals::*gc-major-cycles*
            (writeback-observation-epoch observation) mezzano.internals::*gc-epoch*
            (writeback-observation-young observation) mezzano.internals::*young-gen-newspace-bit*
            (writeback-observation-old observation) mezzano.internals::*old-gen-newspace-bit*
            (writeback-observation-pending observation) mezzano.supervisor::*snapshot-pending-writeback-pages-count*
            (writeback-observation-deadline observation)
            (+ mezzano.supervisor::*run-time* (* 30 internal-time-units-per-second))
            (writeback-observation-outcome observation) :waiting)
      (setf (mezzano.supervisor:event-state *writeback-ready*) t)
      (loop
        (let ((outcome (observe-collector)))
          (when outcome
            (setf (writeback-observation-outcome observation) outcome)
            (return)))
        (when (mezzano.supervisor:event-state *writeback-release*)
          (setf (writeback-observation-outcome observation) :cancelled)
          (return))
        (when (>= mezzano.supervisor::*run-time* (writeback-observation-deadline observation))
          (setf (writeback-observation-outcome observation) :timeout)
          (return))
        (mezzano.supervisor::wait-for-heartbeat))))
  (funcall *original-writeback*))
