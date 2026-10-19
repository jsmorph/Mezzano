;; LOAD the kernel fixture first with :WIRED T.  LOAD this coordinator normally.
(defpackage #:lispm-snapshot-cow-test
  (:use #:cl)
  (:export #:probe #:run #:save-with-collection #:finish-restore))
(in-package #:lispm-snapshot-cow-test)

(declaim (optimize (safety 3) (debug 1) (speed 1)))

(defvar *page* nil)

(defun probe ()
  (dolist (function (list #'set-copy-protection #'page-state))
    (let ((address (logand (mezzano.internals::lisp-object-address function) -16)))
      (assert (<= mezzano.internals::*wired-function-area-limit* address
                  (1- mezzano.internals::*function-area-base*)))))
  (mezzano.supervisor:with-snapshot-inhibited ()
    (assert (null mezzano.supervisor::*snapshot-in-progress*))
    (assert (null *page*))
    (setf *page* (mezzano.supervisor::%allocate-stack 4096))
    (unwind-protect
         (let* ((address (mezzano.supervisor::stack-base *page*))
                (writable (logior mezzano.internals::+block-map-present+
                                  mezzano.internals::+block-map-writable+))
                (ordinary nil) (tracked nil) (before nil) (after nil))
           (setf (mezzano.internals::memref-unsigned-byte-64 address) #x1111)
           (mezzano.supervisor:protect-memory-range address 4096 writable)
           (setf ordinary (mezzano.supervisor::pager-rpc 'page-state address))
           (mezzano.supervisor:protect-memory-range
            address 4096 (logior writable mezzano.internals::+block-map-track-dirty+))
           (setf tracked (mezzano.supervisor::pager-rpc 'page-state address))
           (mezzano.supervisor::pager-rpc 'set-copy-protection address t)
           (unwind-protect
                (progn
                  (setf before (mezzano.supervisor::pager-rpc 'page-state address))
                  (mezzano.supervisor:protect-memory-range address 4096 writable)
                  (setf after (mezzano.supervisor::pager-rpc 'page-state address))
                  (list :ordinary ordinary :tracked tracked
                        :cow-before before :cow-after after))
             (mezzano.supervisor::pager-rpc 'set-copy-protection address nil)))
      (setf *page* nil))))

(defun run ()
  (let ((result (probe)))
    (assert (equal result '(:ordinary 2 :tracked 0 :cow-before 1024 :cow-after 1024))
            () "Copy-on-write protection failed: ~S" result)
    (format t "PASS writable, dirty-tracked, and snapshot page protection: ~S~%" result))
  (values))

(defvar *saved-vector* nil)

(defun check-kernel-fixture ()
  (dolist (name '(set-copy-protection page-state observe-collector held-writeback
                  mezzano.supervisor::snapshot-write-back-pages))
    (let ((address (mezzano.internals::lisp-object-address (fdefinition name))))
      (assert (<= mezzano.internals::*wired-function-area-limit* address
                  (1- mezzano.internals::*function-area-base*)) ()
              "Load the kernel fixture with :WIRED T before the coordinator: ~S" name)))
  (dolist (slot '(boot collector completion cycles minor major epoch young old
                 pending deadline outcome mutated-p))
    (let ((name (intern (format nil "WRITEBACK-OBSERVATION-~A" slot)
                        (find-package :lispm-snapshot-cow-test))))
      (dolist (function (list (fdefinition name) (fdefinition `(setf ,name))))
        (let ((address (mezzano.internals::lisp-object-address function)))
          (assert (<= mezzano.internals::*wired-function-area-limit* address
                      (1- mezzano.internals::*function-area-base*)))))))
  (assert (< (get-internal-run-time)
             (- most-positive-fixnum (* 3600 internal-time-units-per-second)))))

(defun remove-writeback-hook ()
  (when *original-writeback*
    (assert (eq (symbol-function 'mezzano.supervisor::snapshot-write-back-pages)
                #'held-writeback))
    (setf (symbol-function 'mezzano.supervisor::snapshot-write-back-pages)
          *original-writeback*
          *original-writeback* nil)))

(defun await-snapshot-state (boot ready-p)
  (unless (eq boot (mezzano.supervisor:current-boot-id))
    (return-from await-snapshot-state nil))
  (unless ready-p
    (mezzano.supervisor:wait-for-snapshot-completion))
  (let ((deadline (+ (get-internal-run-time)
                     (* 30 internal-time-units-per-second))))
    (loop
      (unless (eq boot (mezzano.supervisor:current-boot-id))
        (return nil))
      (when (if ready-p
                (mezzano.supervisor:event-state *writeback-ready*)
                (and (mezzano.supervisor:event-state mezzano.supervisor::*snapshot-state*)
                     (not mezzano.supervisor::*snapshot-in-progress*)))
        (return t))
      (assert (< (get-internal-run-time) deadline) ()
              "Snapshot did not reach ~A." (if ready-p :writeback :completion))
      (mezzano.supervisor::wait-for-heartbeat))))

(defun check-reservations ()
  (multiple-value-bind (computed recorded free)
      (mezzano.supervisor::block-reservation-statistics)
    (assert (= (+ computed 256) recorded) ()
            "Backing reservations disagree: ~D computed, ~D recorded." computed recorded)
    (list :computed computed :recorded recorded :free free)))

(defun save-with-collection ()
  (assert (not mezzano.supervisor::*paging-read-only*))
  (assert (null mezzano.supervisor::*snapshot-in-progress*))
  (assert (null *original-writeback*))
  (check-kernel-fixture)
  (let ((boot (mezzano.supervisor:current-boot-id))
        (result nil))
    (setf *saved-vector* (make-array 8192 :initial-element 1111)
          *writeback-ready* (mezzano.supervisor:make-event :name "Snapshot test ready")
          *writeback-release* (mezzano.supervisor:make-event :name "Snapshot test cancel")
          *writeback-observation*
          (make-writeback-observation
           :boot boot
           :collector mezzano.internals::*gc-thread*
           :completion mezzano.supervisor::*snapshot-state*))
    (let ((address (mezzano.internals::lisp-object-address *writeback-observation*)))
      (assert (<= mezzano.internals::*wired-area-base* address
                  (1- mezzano.internals::*wired-area-bump*))))
    (setf *original-writeback*
          (symbol-function 'mezzano.supervisor::snapshot-write-back-pages)
          (symbol-function 'mezzano.supervisor::snapshot-write-back-pages) #'held-writeback)
    (unwind-protect
         (progn
           (mezzano.supervisor:with-snapshot-inhibited ()
             (mezzano.supervisor:snapshot)
             (assert mezzano.supervisor::*snapshot-in-progress*)
             (assert (not mezzano.supervisor::*snapshot-writeout-in-progress*))
             (assert (not (mezzano.supervisor:event-state mezzano.supervisor::*snapshot-state*)))
             (let ((epoch mezzano.internals::*gc-epoch*)
                   (major mezzano.internals::*gc-major-cycles*))
               (mezzano.internals::gc :full t)
               (assert (> mezzano.internals::*gc-epoch* epoch))
               (assert (> mezzano.internals::*gc-major-cycles* major)))
             (assert mezzano.supervisor::*snapshot-in-progress*)
             (assert (not mezzano.supervisor::*snapshot-writeout-in-progress*)))
           (unless (await-snapshot-state boot t)
             (return-from save-with-collection :restored))
           (assert mezzano.supervisor::*snapshot-writeout-in-progress*)
           (assert (plusp (writeback-observation-pending *writeback-observation*)))
           (fill *saved-vector* 2222)
           (setf (writeback-observation-mutated-p *writeback-observation*) t)
           (mezzano.internals::gc :full t)
           (unless (eq boot (mezzano.supervisor:current-boot-id))
             (return-from save-with-collection :restored))
           (unless (await-snapshot-state boot nil)
             (return-from save-with-collection :restored))
           (assert (eq (writeback-observation-outcome *writeback-observation*) :observed) ()
                   "Collector observation failed: ~S"
                   (writeback-observation-outcome *writeback-observation*))
           (assert (> mezzano.internals::*gc-epoch*
                      (writeback-observation-epoch *writeback-observation*)))
           (assert (> mezzano.internals::*gc-major-cycles*
                      (writeback-observation-major *writeback-observation*)))
           (assert (not mezzano.supervisor::*snapshot-writeout-in-progress*))
           (assert (zerop mezzano.supervisor::*snapshot-pending-writeback-pages-count*))
           (assert (every (lambda (value) (= value 2222)) *saved-vector*))
           (setf result
                 (list :pending-inhibited-gc :passed
                       :writeout-gc (writeback-observation-outcome *writeback-observation*)
                       :pending-pages (writeback-observation-pending *writeback-observation*)
                       :before-epoch (writeback-observation-epoch *writeback-observation*)
                       :after-epoch mezzano.internals::*gc-epoch*
                       :reservations (check-reservations))))
      (when (eq boot (mezzano.supervisor:current-boot-id))
        (setf (mezzano.supervisor:event-state *writeback-release*) t)
        (when (await-snapshot-state boot nil)
          (remove-writeback-hook))))
    (format t "PASS pending-inhibited GC and collection after Snapshot commit: ~S~%" result)
    result))

(defun finish-restore ()
  (assert *writeback-observation*)
  (assert (not (eq (writeback-observation-boot *writeback-observation*)
                   (mezzano.supervisor:current-boot-id))))
  (assert (null mezzano.supervisor::*snapshot-in-progress*))
  (assert (not mezzano.supervisor::*snapshot-writeout-in-progress*))
  (assert (mezzano.supervisor:event-state mezzano.supervisor::*snapshot-state*))
  (assert *original-writeback*)
  (assert (eq (writeback-observation-outcome *writeback-observation*) :prepared))
  (remove-writeback-hook)
  (assert (and (= (length *saved-vector*) 8192)
               (every (lambda (value) (= value 1111)) *saved-vector*)))
  (let ((epoch mezzano.internals::*gc-epoch*))
    (mezzano.internals::gc :full t)
    (assert (> mezzano.internals::*gc-epoch* epoch)))
  (assert (every (lambda (value) (= value 1111)) *saved-vector*))
  (let ((reservations (check-reservations)))
    (setf *saved-vector* nil
          *writeback-observation* nil
          *writeback-ready* nil
          *writeback-release* nil)
    (format t "PASS restored Snapshot values, phase reset, hook removal, and collection: ~S~%"
            reservations)
    reservations))
