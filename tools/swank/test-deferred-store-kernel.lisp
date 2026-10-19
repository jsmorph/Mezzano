;; Compile at kernel policy and LOAD with :WIRED T.
(defpackage #:lispm-deferred-store-test
  (:use #:cl)
  (:export #:probe #:reconcile))
(in-package #:lispm-deferred-store-test)

(declaim (optimize (safety 3) (debug 1) (speed 1)))

(defun count-deferred-blocks ()
  "Sum the global deferred list while the caller holds *VM-LOCK*."
  (let ((computed 0))
    (do ((range mezzano.supervisor::*store-deferred-freelist-head*
                (mezzano.supervisor::freelist-metadata-next range)))
        ((null range) computed)
      (incf computed (- (mezzano.supervisor::freelist-metadata-end range)
                        (mezzano.supervisor::freelist-metadata-start range))))))

(defun reconcile ()
  "With Snapshot inhibited by the caller, return old count, computed count, status."
  (mezzano.supervisor::with-pseudo-atomic
    (mezzano.supervisor::with-rw-lock-write (mezzano.supervisor::*vm-lock*)
      (cond
        ((zerop mezzano.supervisor::*snapshot-inhibit*)
         (values nil nil :snapshot-not-inhibited))
        ((or mezzano.supervisor::*snapshot-in-progress*
             mezzano.supervisor::*snapshot-writeout-in-progress*)
         (values nil nil :snapshot-active))
        (t
         (let ((old mezzano.supervisor::*store-freelist-n-deferred-free-blocks*)
               (computed (count-deferred-blocks)))
           (setf mezzano.supervisor::*store-freelist-n-deferred-free-blocks* computed)
           (values old computed :reconciled)))))))

;; Observation vector: 0 status; 1/2 free before/after; 3/4 deferred before/after;
;; 5/6 metadata before/after; 7/8 deferred head before/after; 9..15 deferred deltas
;; after new/prepend/append/second/detach/third/batch release; 16 third head intact.
;; 17/18 computed global deferred block counts before/after.
(defun probe ()
  (let ((observations (make-array 19 :area :wired :initial-element nil)))
    (declare (type simple-vector observations))
    (mezzano.supervisor::with-snapshot-inhibited ()
      (mezzano.supervisor::with-pseudo-atomic
        (mezzano.supervisor::with-rw-lock-write (mezzano.supervisor::*vm-lock*)
          (cond
            ((or mezzano.supervisor::*snapshot-in-progress*
                 mezzano.supervisor::*snapshot-writeout-in-progress*)
             (setf (svref observations 0) :snapshot-active))
            (mezzano.supervisor::*paging-read-only*
             (setf (svref observations 0) :read-only-store))
            (mezzano.supervisor::*verbose-store*
             (setf (svref observations 0) :verbose-store))
            (t
             (loop while (< mezzano.supervisor::*store-freelist-n-free-metadata* 64)
                   do (mezzano.supervisor::store-refill-metadata))
             (let ((free mezzano.supervisor::*store-freelist-n-free-blocks*)
                   (deferred mezzano.supervisor::*store-freelist-n-deferred-free-blocks*)
                   (metadata mezzano.supervisor::*store-freelist-n-free-metadata*)
                   (original-head mezzano.supervisor::*store-deferred-freelist-head*))
               (setf (svref observations 1) free
                     (svref observations 3) deferred
                     (svref observations 5) metadata
                     (svref observations 7) original-head
                     (svref observations 17) (count-deferred-blocks))
               (let ((block (mezzano.supervisor::store-alloc 12)))
                 (cond
                   ((null block)
                    (setf (svref observations 0) :no-contiguous-run))
                   (t
                    (mezzano.supervisor::store-deferred-free (+ block 3) 1)
                    (setf (svref observations 9)
                          (- mezzano.supervisor::*store-freelist-n-deferred-free-blocks* deferred))
                    (let ((first-node mezzano.supervisor::*store-deferred-freelist-head*))
                      (mezzano.supervisor::store-deferred-free (+ block 1) 2)
                      (setf (svref observations 10)
                            (- mezzano.supervisor::*store-freelist-n-deferred-free-blocks* deferred))
                      (mezzano.supervisor::store-deferred-free (+ block 4) 3)
                      (setf (svref observations 11)
                            (- mezzano.supervisor::*store-freelist-n-deferred-free-blocks* deferred))
                      (mezzano.supervisor::store-deferred-free (+ block 8) 1)
                      (setf (svref observations 12)
                            (- mezzano.supervisor::*store-freelist-n-deferred-free-blocks* deferred))
                      (let ((batch mezzano.supervisor::*store-deferred-freelist-head*))
                        (setf (mezzano.supervisor::freelist-metadata-next first-node) nil
                              mezzano.supervisor::*store-deferred-freelist-head* original-head
                              (svref observations 13)
                              (- mezzano.supervisor::*store-freelist-n-deferred-free-blocks* deferred))
                        (mezzano.supervisor::store-deferred-free (+ block 10) 1)
                        (setf (svref observations 14)
                              (- mezzano.supervisor::*store-freelist-n-deferred-free-blocks* deferred))
                        (let ((third-node mezzano.supervisor::*store-deferred-freelist-head*))
                          (mezzano.supervisor::store-release-deferred-blocks batch)
                          (setf (svref observations 15)
                                (- mezzano.supervisor::*store-freelist-n-deferred-free-blocks* deferred)
                                (svref observations 16)
                                (and (eq mezzano.supervisor::*store-deferred-freelist-head* third-node)
                                     (eq (mezzano.supervisor::freelist-metadata-next third-node) original-head)
                                     (= (mezzano.supervisor::freelist-metadata-start third-node) (+ block 10))
                                     (= (mezzano.supervisor::freelist-metadata-end third-node) (+ block 11))))
                          (setf (mezzano.supervisor::freelist-metadata-next third-node) nil
                                mezzano.supervisor::*store-deferred-freelist-head* original-head)
                          (mezzano.supervisor::store-release-deferred-blocks third-node))))
                    (mezzano.supervisor::store-free block 1)
                    (mezzano.supervisor::store-free (+ block 7) 1)
                    (mezzano.supervisor::store-free (+ block 9) 1)
                    (mezzano.supervisor::store-free (+ block 11) 1)
                    (setf (svref observations 0) :observed)))
                 (setf (svref observations 2) mezzano.supervisor::*store-freelist-n-free-blocks*
                       (svref observations 4) mezzano.supervisor::*store-freelist-n-deferred-free-blocks*
                       (svref observations 6) mezzano.supervisor::*store-freelist-n-free-metadata*
                       (svref observations 8) mezzano.supervisor::*store-deferred-freelist-head*
                       (svref observations 18) (count-deferred-blocks)))))))))
    observations))
