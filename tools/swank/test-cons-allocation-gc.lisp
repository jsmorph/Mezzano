(defpackage #:lispm-cons-allocation-test
  (:use #:cl)
  (:import-from #:lispm-foothold-gc-test #:await))
(in-package #:lispm-cons-allocation-test)

(defvar *car-root* nil)
(defvar *cdr-root* nil)
(defvar *entered* nil)
(defvar *release* nil)
(defvar *interrupted* nil)
(defvar *result* nil)
(defvar *thread* nil)
(defvar *gate* nil)
(defvar *done* nil)

(mezzano.internals::define-lap-function allocate-cons ((car cdr))
  (:gc :no-frame :layout #*0)
  (mezzano.lap.x86:mov64 :r10 (:symbol-global-cell *entered*))
  (mezzano.lap.x86:mov64 :r11 (:constant t))
  (mezzano.lap.x86:mov64
   (:object :r10 #.mezzano.internals::+symbol-value-cell-value+) :r11)
  wait
  (mezzano.lap.x86:mov64 :r10 (:symbol-global-cell *release*))
  (mezzano.lap.x86:mov64
   :r10 (:object :r10 #.mezzano.internals::+symbol-value-cell-value+))
  (mezzano.lap.x86:cmp64 :r10 :r14)
  (mezzano.lap.x86:jz wait)
  (mezzano.lap.x86:mov32 :ecx #.(ash 2 mezzano.internals::+n-fixnum-bits+))
  (mezzano.lap.x86:jmp (:named-call cons)))

(defun start-worker ()
  (assert (null *thread*) () "A prior allocation fixture remains available for inspection.")
  (setf *car-root* (vector :car)
        *cdr-root* (vector :cdr)
        *entered* nil *release* nil *interrupted* nil *result* nil
        *gate* (mezzano.supervisor:make-event)
        *done* (mezzano.supervisor:make-event)
        *thread* (mezzano.supervisor:make-thread
                  (lambda ()
                    (setf *result* (allocate-cons *car-root* *cdr-root*))
                    (setf (mezzano.supervisor:event-state *done*) t))
                  :name "Cons allocation GC test"))
  (await (lambda () *entered*))
  (mezzano.supervisor::stop-thread *thread*)
  (mezzano.supervisor::convert-thread-to-full-save *thread*)
  (setf *release* t))

(defun allocator-position ()
  (mezzano.internals::return-address-to-function
   (mezzano.supervisor:thread-state-rip *thread*)))

(defun seek-allocator (&optional target-offset)
  (loop repeat 2000
        do (multiple-value-bind (function offset) (allocator-position)
             (when (and (eq function #'mezzano.runtime::do-cons)
                        (or (null target-offset) (= offset target-offset)))
               (return-from seek-allocator
                 (values offset mezzano.internals::*gc-epoch*))))
           (mezzano.internals::safe-single-step-thread *thread*))
  (error "Did not reach DO-CONS offset ~S.  Fixture remains stopped." target-offset))

(defun finish-worker (nested)
  (if nested
      (setf (mezzano.supervisor:event-state *gate*) t)
      (mezzano.supervisor::resume-thread *thread*))
  (await (lambda () (mezzano.supervisor:event-state *done*)))
  (assert (consp *result*))
  (assert (eq (car *result*) *car-root*))
  (assert (eq (cdr *result*) *cdr-root*))
  (setf *thread* nil *gate* nil *done* nil))

(defun allocator-instruction-offsets ()
  (start-worker)
  (seek-allocator)
  (let ((offsets nil))
    (loop repeat 100
          do (multiple-value-bind (function offset) (allocator-position)
               (unless (eq function #'mezzano.runtime::do-cons)
                 (assert (= (mezzano.supervisor:thread-state-rcx-value *thread*) 1)
                         () "DO-CONS left through its failure path.")
                 (return))
               (pushnew offset offsets))
             (mezzano.internals::safe-single-step-thread *thread*)
          finally (error "Did not leave DO-CONS.  Fixture remains stopped."))
    (finish-worker nil)
    (nreverse offsets)))

(defun test-allocation (offset nested)
  (start-worker)
  (let* ((epoch (nth-value 1 (seek-allocator offset)))
         (function #'mezzano.runtime::do-cons)
         (restart (nth-value 11
                    (mezzano.internals::gc-info-for-function-offset function offset)))
         (expected-offset (if restart
                              (nth-value 10
                                (mezzano.internals::gc-info-for-function-offset function offset))
                              offset))
         (frame-pointer nil))
    (when nested
      (mezzano.supervisor:establish-thread-foothold
       *thread*
       (lambda ()
         (setf *interrupted* t)
         (mezzano.supervisor:event-wait *gate*)))
      (setf frame-pointer (mezzano.supervisor:thread-state-rbp *thread*))
      (mezzano.supervisor::resume-thread *thread*)
      (await (lambda () *interrupted*)))
    (format t "Collecting in DO-CONS at ~D, restart ~S, nested ~S.~%" offset restart nested)
    (flet ((saved-address ()
             (if nested
                 (mezzano.internals::memref-unsigned-byte-64 frame-pointer 1)
                 (mezzano.supervisor:thread-state-rip *thread*))))
      (let ((before-car (mezzano.internals::lisp-object-address *car-root*))
            (before-cdr (mezzano.internals::lisp-object-address *cdr-root*))
            (function-address (logand (mezzano.internals::lisp-object-address function) -16)))
        (assert (= (saved-address) (+ function-address offset)))
        (assert (= epoch mezzano.internals::*gc-epoch*) ()
                "GC occurred during test preparation.  Fixture remains stopped.")
        (mezzano.extensions:gc :full t)
        (assert (= (1+ epoch) mezzano.internals::*gc-epoch*))
        (assert (/= before-car (mezzano.internals::lisp-object-address *car-root*)))
        (assert (/= before-cdr (mezzano.internals::lisp-object-address *cdr-root*)))
        (let ((observed (saved-address))
              (expected (+ function-address expected-offset)))
          (assert (= observed expected) ()
                  "DO-CONS saved address ~X, expected ~X.  Fixture remains stopped."
                  observed expected))))
    (finish-worker nested)
    (format t "PASS DO-CONS offset ~D, restart ~S, nested ~S~%" offset restart nested)))

(defun run-tests ()
  (let ((offsets (allocator-instruction-offsets)))
    (format t "DO-CONS instruction offsets: ~S~%" offsets)
    (dolist (nested '(nil t))
      (dolist (offset offsets)
        (test-allocation offset nested)))
    (format t "PASS ~D DO-CONS instruction positions in both saved states~%"
            (length offsets))))

(run-tests)
(in-package #:cl-user)
