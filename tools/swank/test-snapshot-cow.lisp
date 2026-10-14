(defpackage #:lispm-snapshot-cow-test
  (:use #:cl)
  (:export #:probe #:run #:save-with-collection #:finish-restore))
(in-package #:lispm-snapshot-cow-test)

(declaim (optimize (safety 3) (debug 1) (speed 1)))

(defvar *page* nil)

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

(mezzano.internals::defglobal *original-writeback* nil)
(mezzano.internals::defglobal *writeback-ready* nil)
(mezzano.internals::defglobal *writeback-release* nil)
(defvar *saved-vector* nil)

(defun held-writeback ()
  (setf (mezzano.supervisor:event-state *writeback-ready*) t)
  (mezzano.supervisor:event-wait *writeback-release*)
  (funcall *original-writeback*))

(defun remove-writeback-hook ()
  (when *original-writeback*
    (assert (eq (symbol-function 'mezzano.supervisor::snapshot-write-back-pages)
                #'held-writeback))
    (setf (symbol-function 'mezzano.supervisor::snapshot-write-back-pages)
          *original-writeback*
          *original-writeback* nil)))

(defun save-with-collection ()
  (assert (null mezzano.supervisor::*snapshot-in-progress*))
  (assert (null *original-writeback*))
  (let ((address (logand (mezzano.internals::lisp-object-address #'held-writeback) -16)))
    (assert (<= mezzano.internals::*wired-function-area-limit* address
                (1- mezzano.internals::*function-area-base*))))
  (setf *saved-vector* (make-array 8192 :initial-element 1111)
        *writeback-ready* (mezzano.supervisor:make-event :name "Snapshot test ready")
        *writeback-release* (mezzano.supervisor:make-event :name "Snapshot test release")
        *original-writeback* #'mezzano.supervisor::snapshot-write-back-pages
        (symbol-function 'mezzano.supervisor::snapshot-write-back-pages) #'held-writeback)
  (let ((boot (mezzano.supervisor:current-boot-id)))
    (unwind-protect
       (progn
         (mezzano.supervisor:snapshot)
         (let ((deadline (+ (get-internal-real-time)
                            (* 30 internal-time-units-per-second))))
           (loop until (or (mezzano.supervisor:event-state *writeback-ready*)
                           (not (eq boot (mezzano.supervisor:current-boot-id))))
                 do (assert (< (get-internal-real-time) deadline) ()
                            "Snapshot did not reach writeback.")
                    (sleep 0.01)))
         (unless (eq boot (mezzano.supervisor:current-boot-id))
           (return-from save-with-collection (values)))
         (assert (plusp mezzano.supervisor::*snapshot-pending-writeback-pages-count*))
         (let ((minor mezzano.internals::*gc-minor-cycles*))
           (mezzano.extensions:gc)
           (assert (> mezzano.internals::*gc-minor-cycles* minor))
           (format t "PASS minor collection with ~D snapshot pages pending.~%"
                   mezzano.supervisor::*snapshot-pending-writeback-pages-count*))
         (fill *saved-vector* 2222)
         (setf (mezzano.supervisor:event-state *writeback-release*) t)
         (mezzano.supervisor:wait-for-snapshot-completion)
         (assert (every (lambda (value) (= value 2222)) *saved-vector*))
         (format t "PASS live vector changed after snapshot capture; restore must return 1111.~%"))
    (setf (mezzano.supervisor:event-state *writeback-release*) t)
    (mezzano.supervisor:wait-for-snapshot-completion)
    (remove-writeback-hook)))
  (values))

(defun finish-restore ()
  (assert (null mezzano.supervisor::*snapshot-in-progress*))
  (remove-writeback-hook)
  (assert (and (= (length *saved-vector*) 8192)
               (every (lambda (value) (= value 1111)) *saved-vector*)))
  (format t "PASS restored 8192 saved values after minor GC and live mutation during writeback.~%")
  (setf *saved-vector* nil)
  (values))
