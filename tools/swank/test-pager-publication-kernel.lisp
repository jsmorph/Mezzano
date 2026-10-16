(in-package :mezzano.supervisor)
(sys.int::defglobal *pager-publication-test-original-handler* nil)
(sys.int::defglobal *pager-publication-test-ready* nil)
(sys.int::defglobal *pager-publication-test-queued* nil)
(sys.int::defglobal *pager-publication-test-observed* nil)
(sys.int::defglobal *pager-publication-test-publishing* nil)
(sys.int::defglobal *pager-publication-test-early* nil)
(sys.int::defglobal *pager-publication-test-owner* nil)
(sys.int::defglobal *pager-publication-test-cpu* nil)

(defun pager-publication-test-echo (value arg2 arg3)
  (declare (ignore arg2 arg3))
  value)

(defun pager-publication-test-gate (arg1 arg2 arg3)
  (declare (ignore arg1 arg2 arg3))
  :gate)

(defun pager-publication-test-handler ()
  (cond ((eq (thread-wait-item *pager-current-thread*) 'pager-publication-test-gate)
         (funcall *pager-publication-test-original-handler*)
         (setf *pager-publication-test-ready* t)
         (let ((deadline (+ (get-internal-real-time) (* 5 internal-time-units-per-second))))
           (loop until (or *pager-publication-test-queued*
                           (>= (get-internal-real-time) deadline))
                 do (sys.int::cpu-relax))))
        ((eq (thread-wait-item *pager-current-thread*) 'pager-publication-test-echo)
         (setf *pager-publication-test-owner* *global-thread-lock*
               *pager-publication-test-early* *pager-publication-test-publishing*
               *pager-publication-test-observed* t)
         (without-interrupts
           (with-global-thread-lock ()))
         (funcall *pager-publication-test-original-handler*))
        (t
         (funcall *pager-publication-test-original-handler*))))

(defun pager-publication-test-rpc ()
  (without-footholds
    (let ((self (current-thread)))
      (setf (thread-pager-argument-1 self) :echo
            (thread-pager-argument-2 self) nil
            (thread-pager-argument-3 self) nil)))
  (%run-on-wired-stack-without-interrupts (sp fp)
    (let ((self (current-thread)))
      (setf *pager-publication-test-cpu* (local-cpu)
            *pager-publication-test-publishing* t)
      (with-symbol-spinlock (*pager-lock*)
        (acquire-global-thread-lock)
        (setf (thread-state self) :pager-request
              (thread-wait-item self) 'pager-publication-test-echo
              (thread-queue-next self) *pager-waiting-threads*
              *pager-waiting-threads* self))
      (setf *pager-publication-test-queued* t)
      (let ((start (get-high-precision-timer)))
        (loop until (or *pager-publication-test-observed*
                        (>= (high-precision-time-units-to-internal-time-units
                             (- (get-high-precision-timer) start))
                            (ceiling internal-time-units-per-second 10)))
              do (sys.int::cpu-relax)))
      (setf *pager-publication-test-publishing* nil)
      (%reschedule-via-wired-stack sp fp)))
  (thread-pager-argument-1 (current-thread)))
