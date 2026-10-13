;; x86-64 only.  Compile at kernel policy and LOAD with :WIRED T.
;; Read the completed observation before restarting the saved image.
;; UNINSTALL also restores the captured wrappers after image restoration.
(defpackage #:lispm-snapshot-cpu-test
  (:use #:cl)
  (:export #:install #:observation #:check #:uninstall))
(in-package #:lispm-snapshot-cpu-test)

(declaim (optimize (safety 3) (debug 1) (speed 1)))

(mezzano.internals::defglobal *original-copy* nil)
(mezzano.internals::defglobal *original-begin* nil)
(mezzano.internals::defglobal *original-finish* nil)
(mezzano.internals::defglobal *record* nil)
(mezzano.internals::defglobal *copy-active* nil)
(mezzano.internals::defglobal *installed* nil)

;; The callbacks only update preallocated wired storage.
(defstruct (sample (:area :wired))
  thread irq bsp cpus cpu-speed
  begin-cpu end-cpu begin-irq end-irq begin-time end-time begin-tsc end-tsc
  begin-active end-active begin-busy end-busy
  (count 0) (phase :ready))

(defun observed-copy ()
  (setf *copy-active* t)
  (unwind-protect
       (funcall *original-copy*)
    (setf *copy-active* nil)))

(defun observed-begin ()
  (funcall *original-begin*)
  (when (and *copy-active*
             (eq (mezzano.supervisor:current-thread) (sample-thread *record*)))
    (setf (sample-phase *record*) :copying
          (sample-begin-cpu *record*) (mezzano.supervisor::local-cpu)
          (sample-begin-irq *record*) (mezzano.supervisor::irq-count (sample-irq *record*))
          (sample-begin-time *record*) mezzano.supervisor::*run-time*
          (sample-begin-tsc *record*) (mezzano.internals::tsc)
          (sample-begin-active *record*) mezzano.supervisor::*tlb-shootdown-in-progress*
          (sample-begin-busy *record*) mezzano.supervisor::*busy-tlb-shootdown-cpus*)))

(defun observed-finish ()
  (when (and *copy-active*
             (eq (mezzano.supervisor:current-thread) (sample-thread *record*)))
    (setf (sample-end-cpu *record*) (mezzano.supervisor::local-cpu)
          (sample-end-irq *record*) (mezzano.supervisor::irq-count (sample-irq *record*))
          (sample-end-time *record*) mezzano.supervisor::*run-time*
          (sample-end-tsc *record*) (mezzano.internals::tsc)
          (sample-end-active *record*) mezzano.supervisor::*tlb-shootdown-in-progress*
          (sample-end-busy *record*) mezzano.supervisor::*busy-tlb-shootdown-cpus*
          (sample-phase *record*) :complete)
    (incf (sample-count *record*)))
  (funcall *original-finish*))

(defun install ()
  (assert (not *installed*))
  (assert (not mezzano.supervisor::*snapshot-in-progress*))
  (assert (> mezzano.supervisor::*n-up-cpus* 1))
  (assert (< (mezzano.internals::tsc)
             (- most-positive-fixnum (* 86400 mezzano.supervisor::*cpu-speed*))) ()
          "TSC lacks one day of fixnum headroom for allocation-free sampling.")
  (setf *record*
        (make-sample :thread mezzano.internals::*snapshot-thread*
                     :irq (mezzano.supervisor::platform-irq mezzano.supervisor::+pit-irq+)
                     :bsp mezzano.supervisor::*bsp-cpu*
                     :cpus mezzano.supervisor::*n-up-cpus*
                     :cpu-speed mezzano.supervisor::*cpu-speed*)
        *original-copy* (symbol-function 'mezzano.supervisor::snapshot-copy-wired-area)
        *original-begin* (symbol-function 'mezzano.supervisor::begin-tlb-shootdown)
        *original-finish* (symbol-function 'mezzano.supervisor::finish-tlb-shootdown)
        *copy-active* nil)
  (dolist (function (list #'observed-copy #'observed-begin #'observed-finish
                         *original-copy* *original-begin* *original-finish*))
    (let ((address (logand (mezzano.internals::lisp-object-address function) -16)))
      (assert (<= mezzano.internals::*wired-function-area-limit* address
                  (1- mezzano.internals::*function-area-base*)))))
  (let ((address (logand (mezzano.internals::lisp-object-address *record*) -16)))
    (assert (<= mezzano.internals::*wired-area-base* address
                (1- mezzano.internals::*wired-area-bump*))))
  (setf (symbol-function 'mezzano.supervisor::begin-tlb-shootdown) #'observed-begin
        (symbol-function 'mezzano.supervisor::finish-tlb-shootdown) #'observed-finish
        (symbol-function 'mezzano.supervisor::snapshot-copy-wired-area) #'observed-copy
        *installed* t)
  :installed)

(defun observation ()
  (assert *record*)
  (let ((sample *record*))
    (list :phase (sample-phase sample)
          :count (sample-count sample)
          :cpus (sample-cpus sample)
          :begin-apic-id (when (sample-begin-cpu sample)
                           (mezzano.supervisor::x86-64-cpu-apic-id (sample-begin-cpu sample)))
          :end-apic-id (when (sample-end-cpu sample)
                         (mezzano.supervisor::x86-64-cpu-apic-id (sample-end-cpu sample)))
          :bsp-apic-id (mezzano.supervisor::x86-64-cpu-apic-id (sample-bsp sample))
          :begin-pit-count (sample-begin-irq sample) :end-pit-count (sample-end-irq sample)
          :begin-run-time (sample-begin-time sample) :end-run-time (sample-end-time sample)
          :begin-tsc (sample-begin-tsc sample) :end-tsc (sample-end-tsc sample)
          :cpu-speed (sample-cpu-speed sample)
          :begin-active (sample-begin-active sample) :end-active (sample-end-active sample)
          :begin-busy (sample-begin-busy sample) :end-busy (sample-end-busy sample))))

(defun check (&key (minimum-seconds 1/100))
  (assert (not mezzano.supervisor::*snapshot-in-progress*))
  (assert (and *record* (eq (sample-phase *record*) :complete)))
  (let ((sample *record*))
    (assert (> (sample-cpus sample) 1))
    (assert (not (eq (sample-begin-cpu sample) (sample-bsp sample))) ()
            "The snapshot copied on the BSP.  A non-BSP copy is required.")
    (assert (eq (sample-begin-cpu sample) (sample-end-cpu sample)))
    (assert (and (sample-begin-active sample) (sample-end-active sample)))
    (assert (and (zerop (sample-begin-busy sample)) (zerop (sample-end-busy sample))))
    (assert (= (sample-begin-irq sample) (sample-end-irq sample)))
    (assert (= (sample-begin-time sample) (sample-end-time sample)))
    (assert (>= (- (sample-end-tsc sample) (sample-begin-tsc sample))
                (* minimum-seconds (sample-cpu-speed sample))) ()
            "The observation interval was shorter than ~S seconds." minimum-seconds))
  (observation))

(defun uninstall ()
  (assert *installed*)
  (assert (not mezzano.supervisor::*snapshot-in-progress*))
  (assert (eq (symbol-function 'mezzano.supervisor::snapshot-copy-wired-area) #'observed-copy))
  (assert (eq (symbol-function 'mezzano.supervisor::begin-tlb-shootdown) #'observed-begin))
  (assert (eq (symbol-function 'mezzano.supervisor::finish-tlb-shootdown) #'observed-finish))
  (setf (symbol-function 'mezzano.supervisor::snapshot-copy-wired-area) *original-copy*
        (symbol-function 'mezzano.supervisor::begin-tlb-shootdown) *original-begin*
        (symbol-function 'mezzano.supervisor::finish-tlb-shootdown) *original-finish*
        *copy-active* nil
        *installed* nil)
  :uninstalled)
