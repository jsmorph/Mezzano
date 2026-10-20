(in-package :mezzano.supervisor)
(sys.int::defglobal *worker-mutex-probe-original* nil)
(sys.int::defglobal *worker-mutex-probe-target* nil)
(sys.int::defglobal *worker-mutex-probe-lock* nil)
(sys.int::defglobal *worker-mutex-probe-seen* nil)
(sys.int::defglobal *worker-mutex-probe-armed* nil)
(sys.int::defglobal *worker-mutex-probe-entered* nil)
(sys.int::defglobal *worker-mutex-probe-resume* nil)

(defun worker-mutex-probe-check (mutex)
  (funcall *worker-mutex-probe-original* mutex)
  (when (and (eq mutex *worker-mutex-probe-lock*)
             (eq (current-thread) *worker-mutex-probe-target*))
    (setf *worker-mutex-probe-seen* t)
    (when *worker-mutex-probe-armed*
      (setf *worker-mutex-probe-armed* nil
            (event-state *worker-mutex-probe-entered*) t)
      (event-wait *worker-mutex-probe-resume*))))
