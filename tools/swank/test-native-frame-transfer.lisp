(defpackage #:lispm-native-frame-transfer-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug) (#:r #:mezzano.runtime)
                    (#:test #:lispm-service-test) (#:base #:lispm-frame-return-test)
                    (#:ret #:lispm-frame-return-command-test)
                    (#:rei #:lispm-reinvoke-command-test))
  (:export #:run))
(in-package #:lispm-native-frame-transfer-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *probe* :global)
(defvar *case*)
(defstruct transfer-state marker replacement new-marker events values completed points
  depth callback (entries 0))
(defstruct transfer-case state thread controller stop lease)
(declaim (notinline arm-caller-return target middle callback-stop))

(defun mode () (getf (r::get-fpu-mode) :rounding))

(defun arm-caller-return (state)
  (let ((fp (i::read-frame-pointer)))
    (multiple-value-bind (function offset)
        (i::safe-return-address-to-function (i::memref-unsigned-byte-64 fp 1))
      (s:without-footholds
        (push (if (transfer-state-callback state)
                  (s::install-callback-instruction-step-breakpoint
                   function offset (s:current-thread) (+ fp 16) #'callback-stop state)
                  (progn
                    (d::service-validate-instruction-breakpoint-location function offset)
                    (s::install-instruction-breakpoint function offset)))
              (transfer-state-points state))))))

(defun callback-stop (state)
  (setf (transfer-state-callback state) nil)
  (r::set-fpu-mode :rounding :zero)
  (arm-caller-return state)
  (error "Owned nested callback resumed."))

(defun target (state marker)
  (let ((*probe* :target) (modes (r::get-fpu-mode)))
    (incf (transfer-state-entries state))
    (r::set-fpu-mode :rounding :positive-infinity)
    (unwind-protect
         (progn
           (arm-caller-return state)
           (values marker 1.5d0 :target))
      (push (list :target *probe* (mode)) (transfer-state-events state))
      (apply #'r::set-fpu-mode modes)
      (mezzano.extensions:gc :full t))))

(defun middle (state marker)
  (let ((*probe* :middle) (modes (r::get-fpu-mode)))
    (r::set-fpu-mode :rounding :negative-infinity)
    (unwind-protect
         (target state marker)
      (push (list :middle *probe* (mode)) (transfer-state-events state))
      (apply #'r::set-fpu-mode modes)
      (mezzano.extensions:gc :full t))))

(defun live-stop (thread)
  (find thread (d:debugger-stops)
        :key (lambda (handle) (d::service-stop-thread (d::service-handle-stop handle)))))

(defun cleanup-case (record)
  (let ((state (transfer-case-state record))
        (controller (transfer-case-controller record))
        (thread (transfer-case-thread record)))
    (dolist (point (transfer-state-points state))
      (s::clear-instruction-breakpoint point))
    (when thread
      (dolist (stop (d:debugger-stops :include-closed t))
        (let ((object (d::service-handle-stop stop)))
          (when (and (eq (d::service-stop-thread object) thread)
                     (null (d::service-stop-parent object)))
            (lispm-frame-evaluation-test::release-test-stop stop controller))))
      (unless (nth-value 1 (s:thread-join thread nil))
        (s:terminate-thread thread))
      (test::await (lambda () (nth-value 1 (s:thread-join thread nil)))))
    (d:close-debugger-controller controller)))

(defun start-case (depth &optional nested)
  (let* ((state (make-transfer-state
                 :marker (vector :original) :replacement (vector :current)
                 :new-marker (vector :new) :depth depth :callback nested))
         (record (make-transfer-case :state state :controller (d:make-debugger-controller)))
         (prepared nil))
    (unwind-protect
         (progn
           (setf (transfer-case-thread record)
                 (s:make-thread
                  (lambda ()
                    (let ((*case* record) (*probe* :caller)
                          (*package* (find-package :lispm-native-frame-transfer-test))
                          (modes (r::get-fpu-mode)))
                      (unwind-protect
                           (d:call-with-debugger-service
                            (lambda ()
                              (restart-case
                                  (progn
                                    (r::set-fpu-mode :rounding :zero)
                                    (setf (transfer-state-values state)
                                          (multiple-value-list
                                           (base::with-prompts
                                            depth (lambda () (middle state (transfer-state-marker state))))))
                                    (assert (eq *probe* :caller))
                                    (assert (eq (mode) :zero))
                                    (setf (transfer-state-completed state) t))
                                (abort () :aborted))))
                        (apply #'r::set-fpu-mode modes))))
                  :name "Owned native frame transfer"))
           (let ((stop (test::await (lambda () (live-stop (transfer-case-thread record))))))
             (setf (transfer-case-stop record) stop
                   (transfer-case-lease record)
                   (d:attach-debugger-stop stop (transfer-case-controller record))))
           (setf prepared t)
           record)
      (unless prepared (cleanup-case record)))))

(defun select-frame (record function)
  (let* ((stop (transfer-case-stop record))
         (frames (d::service-stop-frames (d::service-handle-stop stop)))
         (index (position function frames
                          :key (lambda (frame) (nth-value 1 (i::frame-function frame))))))
    (assert index)
    (test::command stop (transfer-case-lease record) :select-frame index)
    index))

(defun check-context-in-thread (expected equal-heads)
  (let* ((stop d::*service-current-stop*)
         (frame (aref (d::service-stop-frames stop) (d::service-stop-current-frame stop))))
    (multiple-value-bind (fp head reason states) (i::frame-return-context frame)
      (declare (ignore fp head))
      (assert (null reason))
      (assert (= (length states) expected))
      (when equal-heads (assert (eq (caar states) (caadr states))))
      t)))

(defun return-with-cleanup (values)
  (let* ((record *case*) (state (transfer-case-state record)) (*probe* :debugger)
         (stop d::*service-current-stop*)
         (frame (aref (d::service-stop-frames stop) (d::service-stop-current-frame stop))))
    (r::set-fpu-mode :rounding :nearest)
    (unwind-protect
         (i::return-from-frame frame values)
      (push (list :debugger *probe* (mode)) (transfer-state-events state)))))

(defun check-completed (record expected events entries)
  (let ((state (transfer-case-state record)))
    (test::await (lambda () (nth-value 1 (s:thread-join (transfer-case-thread record) nil))))
    (assert (transfer-state-completed state))
    (assert (equalp (transfer-state-values state) expected))
    (when expected (assert (eq (first (transfer-state-values state)) (first expected))))
    (assert (= (transfer-state-entries state) entries))
    (assert (equal (reverse (transfer-state-events state)) events))))

(defun return-case (depth selected count primitive nested)
  (let* ((record (start-case depth nested))
         (state (transfer-case-state record))
         (stop (transfer-case-stop record))
         (lease (transfer-case-lease record))
         (expected (case count (0 nil) (1 (list (transfer-state-marker state)))
                         (3 (list (transfer-state-marker state) 2.5d0 :forced)))))
    (unwind-protect
         (progn
           (select-frame record selected)
           (assert (equal (test::command stop lease :evaluate
                                        "(values (eq state (transfer-case-state *case*)) *probe*)")
                          (list "T" (if (eq selected #'target) ":TARGET" ":MIDDLE"))))
           (assert (search "*PROBE*" (test::command stop lease :bindings '(nil ""))))
           (assert (equal (test::command
                           stop lease :evaluate
                           (format nil "(check-context-in-thread ~D ~S)" (if nested 2 1) nested))
                          '("T")))
           (let ((before (i::lisp-object-address (transfer-state-marker state))))
             (mezzano.extensions:gc :full t)
             (assert (/= before (i::lisp-object-address (transfer-state-marker state)))))
           (let ((id (getf (d:debugger-stop-information stop) :next-command-id)))
             (if primitive
                 (d:submit-debugger-command
                  lease id :evaluate
                  "(return-with-cleanup (list (transfer-state-marker (transfer-case-state *case*)) 2.5d0 :forced))")
                 (progn
                   (d:submit-debugger-command lease id :return)
                   (ret::expression
                    stop lease id
                    (case count
                      (0 "(values)")
                      (1 "(values (transfer-state-marker state))")
                      (3 "(values (transfer-state-marker state) 2.5d0 :forced)")))
                   (ret::confirm stop lease id "y")))
             (assert (eq (getf (test::completed-command stop id) :state) :unwound)))
           (check-completed
            record expected
            (append (when primitive '((:debugger :debugger :nearest)))
                    '((:target :target :positive-infinity) (:middle :middle :negative-infinity)))
            1))
      (cleanup-case record))))

(defun run-return ()
  (dolist (depth '(0 2))
    (dolist (selected (list #'target #'middle))
      (dolist (count '(0 1 3))
        (return-case depth selected count nil nil))
      (return-case depth selected 3 t nil)
      (return-case depth selected 3 t t)))
  (assert (null (d:debugger-stops :include-closed t)))
  (assert (null (s::instruction-breakpoints)))
  (format t "PASS native frame Return, selected interrupted/older frames, zero/one/multiple values, moving GC, debugger/application FPU cleanup modes, equal-head nested interruptions, bindings, cleanup, and prompts.~%")
  t)

(defun reinvoke-case (depth mode)
  (let* ((record (start-case depth))
         (state (transfer-case-state record))
         (stop (transfer-case-stop record))
         (lease (transfer-case-lease record))
         (options (ecase mode (:current '(nil nil)) (:original '(t nil)) (:new '(nil t)))))
    (unwind-protect
         (progn
           (select-frame record #'target)
           (assert (equal (test::command
                           stop lease :evaluate
                           "(progn (setf marker (transfer-state-replacement state)) (eq marker (transfer-state-replacement state)))")
                          '("T")))
           (let* ((id (rei::submit stop lease options)))
             (when (eq mode :new)
               (rei::expression stop lease id "(list state (transfer-state-new-marker state))"))
             (ret::confirm stop lease id "y")
             (assert (eq (getf (test::completed-command stop id) :state) :unwound))
             (let* ((next (test::await (lambda () (live-stop (transfer-case-thread record)))))
                    (next-lease (d:attach-debugger-stop next (transfer-case-controller record))))
               (assert (/= (getf (d:debugger-stop-information stop) :id)
                           (getf (d:debugger-stop-information next) :id)))
               (assert (null (getf (d:debugger-stop-information next) :parent)))
               (assert (= (transfer-state-entries state) 2))
               (assert (= (length (s::instruction-breakpoints)) 1))
               (assert (= (d:submit-debugger-command lease id :reinvoke (copy-list options)) id))
               (assert (= (transfer-state-entries state) 2))
               (d:release-debugger-stop lease)
               (setf (transfer-case-stop record) next (transfer-case-lease record) next-lease)
               (select-frame record #'target)
               (assert (equal
                        (test::command
                         next next-lease :evaluate
                         (format nil "(eq marker (~A state))"
                                 (ecase mode
                                   (:current 'transfer-state-replacement)
                                   (:original 'transfer-state-marker)
                                   (:new 'transfer-state-new-marker))))
                        '("T")))
               (let ((proceed (getf (d:debugger-stop-information next) :next-command-id)))
                 (d:submit-debugger-command next-lease proceed :proceed)
                 (assert (eq (getf (test::completed-command next proceed) :state) :unwound)))))
           (check-completed
            record
            (list (ecase mode (:current (transfer-state-replacement state))
                              (:original (transfer-state-marker state))
                              (:new (transfer-state-new-marker state)))
                  1.5d0 :target)
            '((:target :target :positive-infinity)
              (:target :target :positive-infinity)
              (:middle :middle :negative-infinity))
            2))
      (cleanup-case record))))

(defun run-reinvoke ()
  (dolist (depth '(0 2))
    (dolist (mode '(:current :original :new))
      (reinvoke-case depth mode)))
  (assert (null (d:debugger-stops :include-closed t)))
  (assert (null (s::instruction-breakpoints)))
  (format t "PASS native Reinvoke Current/Original/New, live parameter writes, persistent-breakpoint retriggering, accepted replay, fresh stops, values, bindings, FPU cleanup modes, cleanup, and prompts.~%")
  t)

(defun run ()
  (run-return)
  (run-reinvoke)
  t)
