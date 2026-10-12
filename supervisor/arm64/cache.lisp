(in-package :mezzano.supervisor)

;; FIXME: Assumed! This should actually be read from the config bits.
(defconstant +cache-line-size+ 64)

(sys.int::define-lap-function %dc.cvau ((address))
  "Clean data cache for the given virtual address back to the point of unification"
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:add :x9 :xzr :x0 :asr #.sys.int::+n-fixnum-bits+)
  (mezzano.lap.arm64:dc.cvau :x9)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %dc.cvac ((address))
  "Clean data cache for the given virtual address back to the point of coherence"
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:add :x9 :xzr :x0 :asr #.sys.int::+n-fixnum-bits+)
  (mezzano.lap.arm64:dc.cvac :x9)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %dc.civac ((address))
  "Clean & invalidate data cache for the given virtual address back to the point of coherence"
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:add :x9 :xzr :x0 :asr #.sys.int::+n-fixnum-bits+)
  (mezzano.lap.arm64:dc.civac :x9)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %ic.ivau ((address))
  "Invalidate instruction cache for the given virtual address back to the point of unification"
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:add :x9 :xzr :x0 :asr #.sys.int::+n-fixnum-bits+)
  (mezzano.lap.arm64:ic.ivau :x9)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %dsb.oshst (())
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:dsb.oshst)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %dsb.osh (())
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:dsb.osh)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %dsb.ishst (())
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:dsb.ishst)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %dsb.ish (())
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:dsb.ish)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %dmb.oshst (())
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:dmb.oshst)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %dmb.osh (())
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:dmb.osh)
  (mezzano.lap.arm64:ret))

(sys.int::define-lap-function %isb (())
  (:gc :no-frame :layout #*)
  (mezzano.lap.arm64:isb)
  (mezzano.lap.arm64:ret))

(defun %arm64-sync-icache (base length)
  ;; Make sure we align base/end to the cache-line boundary so we get everything.
  (let ((start (logand base (1- +cache-line-size+)))
        (end (logand (+ base length (1- +cache-line-size+))
                     (lognot (1- +cache-line-size+)))))
    ;; Clear (write dirty data, but don't invalidate) data cache back to
    ;; the point of unification (where I & D caches meet)
    (loop for addr from base below end by +cache-line-size+
          do (%dc.cvau addr))
    ;; Ensure visibility of the data cleaned from cache.
    (%dsb.ish)
    ;; Now that the dcache is up to date at the PoU, any lines in
    ;; the icache can be invalidated back there.
    (loop for addr from base below end by +cache-line-size+
          do (%ic.ivau addr))
    ;; Ensure completion of the invalidations.
    (%dsb.ish)
    ;; Make sure we don't have stale instructions in the pipeline.
    (%isb)))

(defun sys.int::dma-write-barrier ()
  (%dsb.oshst)
  (%isb))

(defun clean-and-invalidate-cache-range (base length)
  "Write back dirty cache lines and invalidate them."
  ;; Make sure we align base/end to the cache-line boundary so we get everything.
  (let ((start (logand base (1- +cache-line-size+)))
        (end (logand (+ base length (1- +cache-line-size+))
                     (lognot (1- +cache-line-size+)))))
    ;; Clear & invalidate data cache back to the point of coherence
    (loop for addr from start below end by +cache-line-size+
          do (%dc.civac addr))
    ;; Wait for completion
    (%dsb.ish)))

(defun sys.int::dma-read-barrier ()
  (%dmb.osh))
