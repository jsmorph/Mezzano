(defpackage #:lispm-native-unwind-test
  (:use #:cl)
  (:local-nicknames (#:d #:mezzano.debug) (#:s #:mezzano.supervisor)
                    (#:test #:lispm-service-test)
                    (#:native #:lispm-native-frame-transfer-test))
  (:export #:probe #:run))
(in-package #:lispm-native-unwind-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun probe-case (depth operation)
  (let* ((record (native::start-case depth))
         (state (native::transfer-case-state record))
         (stop (native::transfer-case-stop record))
         (lease (native::transfer-case-lease record)))
    (unwind-protect
         (progn
           (native::select-frame record #'native::target)
           (assert (equal
                    (test::command stop lease :evaluate
                                   "(lispm-native-unwind-test::wrapper-values state)" 60)
                    '("T")))
           (let ((instruction (test::command stop lease :instruction))
                 (initial (test::command
                           stop lease :evaluate
                           "(values (getf (mezzano.runtime::get-fpu-mode) :rounding) *probe*)")))
             (assert (equal initial '(":POSITIVE-INFINITY" ":TARGET")))
             (assert (equal
                      (test::command
                       stop lease :evaluate
                       "(progn (mezzano.runtime::set-fpu-mode :rounding :nearest) (values (getf (mezzano.runtime::get-fpu-mode) :rounding) *probe*))")
                      '(":NEAREST" ":TARGET")))
             (let ((id (getf (d:debugger-stop-information stop) :next-command-id)))
               (d:submit-debugger-command lease id operation)
               (assert (eq (getf (test::completed-command stop id) :state) :unwound)))
             (test::await (lambda () (nth-value 1 (s:thread-join (native::transfer-case-thread record) nil))))
             (let ((events (reverse (native::transfer-state-events state))))
               (assert (= (native::transfer-state-entries state) 1))
               (assert (equal (mapcar (lambda (event) (subseq event 0 2)) events)
                              '((:target :target) (:middle :middle))))
               (assert (eq (third (second events)) :negative-infinity))
               (ecase operation
                 (:proceed
                  (native::check-completed
                   record (list (native::transfer-state-marker state) 1.5d0 :target)
                   '((:target :target :positive-infinity) (:middle :middle :negative-infinity))
                   1))
                 (:abort
                  (assert (not (native::transfer-state-completed state)))))
               (list :operation operation :prompts depth :instruction instruction
                     :initial initial :debugger-rounding :nearest :cleanup events
                     :completed (native::transfer-state-completed state)
                     :thread-values (s:thread-join (native::transfer-case-thread record) nil)))))
      (native::cleanup-case record))))

(defun probe ()
  (assert (null (d:debugger-stops :include-closed t)))
  (assert (null (s::instruction-breakpoints)))
  (let ((observations
          (loop for depth in '(0 2) append
                (loop for operation in '(:proceed :abort)
                      collect (probe-case depth operation)))))
    (assert (null (d:debugger-stops :include-closed t)))
    (assert (null (s::instruction-breakpoints)))
    observations))

(defvar *argument-state* nil)

(defun argument-target (&rest arguments)
  (setf (aref *argument-state* 0) arguments)
  (incf (aref *argument-state* 1))
  (values))

(defun argument-case (count full-save-p)
  (let* ((state (vector nil 0 nil nil))
         (gate (s:make-event))
         (arguments (loop for index below count collect (vector :argument index)))
         (thread (s:make-thread
                  (lambda ()
                    (let ((*argument-state* state))
                      (setf (aref state 2) t)
                      (s:event-wait gate)
                      (setf (aref state 3) t)))
                  :name "Owned forced-call arguments")))
    (unwind-protect
         (progn
           (test::await (lambda () (and (aref state 2)
                                       (eq (s::sample-thread-state thread) :sleeping))))
           (s::stop-thread thread)
           (assert (not (s:thread-full-save-p thread)))
           (when full-save-p (s::convert-thread-to-full-save thread))
           (assert (eq (s:thread-full-save-p thread) full-save-p))
           (apply #'s::force-call-on-thread thread #'argument-target arguments)
           (lispm-native-single-step-test::check-location thread #'argument-target 16)
           (let ((before (mapcar #'mezzano.internals::lisp-object-address arguments)))
             (mezzano.extensions:gc :full t)
             (loop for argument in arguments for address in before
                   do (assert (/= address (mezzano.internals::lisp-object-address argument)))))
           (lispm-native-single-step-test::check-location thread #'argument-target 16)
           (setf (s:event-state gate) t)
           (s::resume-thread thread)
           (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
           (assert (= (aref state 1) 1))
           (assert (aref state 3))
           (assert (= (length (aref state 0)) count))
           (loop for received in (aref state 0) for expected in arguments
                 do (assert (eq received expected))))
      (setf (s:event-state gate) t)
      (unless (nth-value 1 (s:thread-join thread nil))
        (when (eq (s::sample-thread-state thread) :stopped)
          (s::resume-thread thread))
        (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))))))

(defun wrapper-values (state)
  (let* ((stop d::*service-current-stop*)
         (frame (aref (d::service-stop-frames stop) (d::service-stop-current-frame stop)))
         (contexts (nth-value 3 (mezzano.internals::frame-return-context frame)))
         (address (cdar contexts)))
    (assert address)
    (dolist (argumentp '(nil t))
      (dolist (count '(0 1 3))
        (let ((calls 0)
              (expected (subseq (list (native::transfer-state-marker state) 3.5d0 :callback) 0 count)))
          (let ((result
                  (multiple-value-list
                   (s::call-with-interrupt-fpu-state
                    (lambda (&rest arguments)
                      (incf calls)
                      (assert (equal arguments (if argumentp (list state) nil)))
                      (mezzano.runtime::set-fpu-mode :rounding :nearest)
                      (let ((before (mezzano.internals::lisp-object-address
                                     (native::transfer-state-marker state))))
                        (mezzano.extensions:gc :full t)
                        (assert (/= before (mezzano.internals::lisp-object-address
                                            (native::transfer-state-marker state)))))
                      (values-list expected))
                    state argumentp address))))
            (assert (= calls 1))
            (assert (equal result expected))
            (when expected (assert (eq (first result) (native::transfer-state-marker state))))
            (assert (eq (getf (mezzano.runtime::get-fpu-mode) :rounding) :positive-infinity)))))))
  t)

(defun run ()
  (dolist (full-save-p '(nil t))
    (dotimes (count 5) (argument-case count full-save-p)))
  (let ((observations (probe)))
    (dolist (record observations)
      (assert (eq (third (first (getf record :cleanup))) :positive-infinity))))
  (format t "PASS direct forced-call entry and zero through four moving arguments, partial/full continuations, wrapper zero/one/multiple values and GC, native Proceed/Abort FPU cleanup, bindings, and prompts.~%")
  t)
