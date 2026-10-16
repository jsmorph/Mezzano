(defpackage #:lispm-native-foothold-unwind-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug) (#:r #:mezzano.runtime)
                    (#:test #:lispm-service-test) (#:base #:lispm-frame-return-test)
                    (#:frames #:lispm-frame-evaluation-test))
  (:export #:run))
(in-package #:lispm-native-foothold-unwind-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *probe* :global)
(declaim (notinline worker))

(defun worker (state marker)
  (let ((*probe* :worker) (modes (r::get-fpu-mode)))
    (r::set-fpu-mode :rounding :positive-infinity)
    (unwind-protect
         (progn
           (setf (aref state 0) t)
           (loop until (aref state 1))
           marker)
      (assert (eq marker (aref state 5)))
      (push (list *probe* (getf (r::get-fpu-mode) :rounding)) (aref state 2))
      (apply #'r::set-fpu-mode modes))))

(defun run-case (depth operation)
  (let* ((state (vector nil nil nil nil 0 (vector :moving-marker) nil nil))
         (controller (d:make-debugger-controller))
         (thread
           (s:make-thread
            (lambda ()
              (let ((*probe* :caller)
                    (*package* (find-package :lispm-native-foothold-unwind-test))
                    (modes (r::get-fpu-mode)))
                (unwind-protect
                     (progn
                       (r::set-fpu-mode :rounding :zero)
                       (setf (aref state 3)
                             (d:call-with-debugger-service
                              (lambda ()
                                (restart-case
                                    (progn
                                      (base::with-prompts
                                       depth (lambda () (worker state (aref state 5))))
                                      (setf (aref state 6) t)
                                      :continued)
                                  (abort () :aborted))))
                             (aref state 7)
                             (list *probe* (getf (r::get-fpu-mode) :rounding))))
                  (apply #'r::set-fpu-mode modes))))
            :name "Owned native foothold unwind")))
    (unwind-protect
         (progn
           (test::await (lambda () (aref state 0)))
           (s:establish-thread-foothold
            thread
            (lambda ()
              (incf (aref state 4))
              (break "Owned native foothold FPU context."))
            :force t)
           (let* ((stop (test::await
                         (lambda () (lispm-native-frame-transfer-test::live-stop thread))))
                  (lease (d:attach-debugger-stop stop controller)))
             (frames::select-function stop lease #'worker)
             (assert (equal
                      (test::command
                       stop lease :evaluate
                       "(lispm-native-frame-transfer-test::check-context-in-thread 1 nil)")
                      '("T")))
             (assert (equal
                      (test::command
                       stop lease :evaluate
                       "(values (eq marker (aref state 5)) *probe* (getf (mezzano.runtime::get-fpu-mode) :rounding))")
                      '("T" ":WORKER" ":POSITIVE-INFINITY")))
             (let ((before (i::lisp-object-address (aref state 5))))
               (mezzano.extensions:gc :full t)
               (assert (/= before (i::lisp-object-address (aref state 5)))))
             (assert (equal (test::command stop lease :evaluate
                                          "(eq marker (aref state 5))")
                            '("T")))
             (assert (equal
                      (test::command
                       stop lease :evaluate
                       "(progn (mezzano.runtime::set-fpu-mode :rounding :nearest) (values *probe* (getf (mezzano.runtime::get-fpu-mode) :rounding)))")
                      '(":WORKER" ":NEAREST")))
             (setf (aref state 1) t)
             (let ((id (getf (d:debugger-stop-information stop) :next-command-id)))
               (d:submit-debugger-command lease id operation)
               (assert (eq (getf (test::completed-command stop id) :state) :unwound))))
           (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
           (assert (= (aref state 4) 1))
           (assert (equal (aref state 2) '((:worker :positive-infinity))))
           (assert (equal (aref state 7) '(:caller :zero)))
           (assert (eq (aref state 3) (ecase operation
                                       (:proceed :continued) (:abort :aborted))))
           (assert (eq (aref state 6) (eq operation :proceed))))
      (setf (aref state 1) t)
      (dolist (stop (d:debugger-stops :include-closed t))
        (let ((object (d::service-handle-stop stop)))
          (when (and (eq (d::service-stop-thread object) thread)
                     (null (d::service-stop-parent object)))
            (frames::release-test-stop stop controller))))
      (unless (nth-value 1 (s:thread-join thread nil))
        (s:terminate-thread thread))
      (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
      (d:close-debugger-controller controller))))

(defun run ()
  (assert (null (d:debugger-stops :include-closed t)))
  (dolist (depth '(0 2))
    (dolist (operation '(:proceed :abort))
      (run-case depth operation)))
  (assert (null (d:debugger-stops :include-closed t)))
  (format t "PASS native cross-thread foothold Proceed/Abort, closure and selected-frame roots under moving GC, FPU cleanup modes, bindings, once-only delivery and zero/two prompts.~%")
  t)
