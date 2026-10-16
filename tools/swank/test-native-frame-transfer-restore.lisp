(defpackage #:lispm-native-frame-transfer-restore-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug) (#:test #:lispm-service-test)
                    (#:native #:lispm-native-frame-transfer-test)
                    (#:ret #:lispm-frame-return-command-test)
                    (#:rei #:lispm-reinvoke-command-test)
                    (#:hw #:lispm-hardware-breakpoint-test))
  (:export #:prepare #:finish))
(in-package #:lispm-native-frame-transfer-restore-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *state* nil)
(defvar *evaluations* 0)

(defun cleanup ()
  (dolist (saved (getf *state* :cases))
    (let ((record (getf saved :record)))
      (d:close-debugger-controller (native::transfer-case-controller record))
      (setf (native::transfer-case-controller record) (d:make-debugger-controller))
      (let ((stop (native::live-stop (native::transfer-case-thread record)))
            (id (getf saved :id)))
        (when (and stop id
                   (eq (d::service-handle-stop stop)
                       (d::service-handle-stop (getf saved :old-stop)))
                   (null (getf (d:debugger-stop-information stop) :child))
                   (eq (getf (d:debugger-command-result stop id) :state) :running))
          (let ((lease (d:attach-debugger-stop stop (native::transfer-case-controller record))))
            (ret::confirm stop lease id "n")
            (test::completed-command stop id))))
      (native::cleanup-case record))))

(defun return-source ()
  "(progn (incf lispm-native-frame-transfer-restore-test::*evaluations*) (values marker 2.5d0 :restored))")

(defun submit (saved)
  (let* ((record (getf saved :record))
         (stop (native::transfer-case-stop record))
         (lease (native::transfer-case-lease record))
         (id (if (eq (getf saved :operation) :return)
                 (ret::submit stop lease)
                 (rei::submit stop lease '(nil nil)))))
    (when (eq (getf saved :operation) :return)
      (ret::expression stop lease id (return-source)))
    (ret::waiting stop id "(Y or N) ")
    id))

(defun prepare ()
  (assert (null *state*))
  (assert (null (d:debugger-stops :include-closed t)))
  (assert (null (s::instruction-breakpoints)))
  (setf *evaluations* 0)
  (let ((prepared nil))
    (unwind-protect
         (progn
           (setf *state* (list :boot (s:current-boot-id)
                              :bytes (mapcar #'hw::code-bytes
                                             (list #'native::target #'native::middle))))
           (dolist (spec '((:return 0 :target t) (:return 2 :middle nil)
                           (:reinvoke 2 :target t) (:reinvoke 0 :target nil)))
             (destructuring-bind (operation depth selected preparing) spec
               (let* ((record (native::start-case depth))
                      (saved (list :record record :operation operation :prepared preparing
                                   :index nil :old-stop nil :old-lease nil :old-controller nil
                                   :frame nil :marker nil :replacement nil :id nil
                                   :input nil :preview nil :history nil))
                      (stop (native::transfer-case-stop record))
                      (lease (native::transfer-case-lease record))
                      (index nil))
                 (push saved (getf *state* :cases))
                 (setf index (native::select-frame
                              record (ecase selected
                                       (:target #'native::target) (:middle #'native::middle))))
                 (assert (equal (test::command stop lease :evaluate
                                              "(values (eq state (transfer-case-state *case*)) *probe*)")
                                (list "T" (ecase selected (:target ":TARGET") (:middle ":MIDDLE")))))
                 (assert (search "*PROBE*" (test::command stop lease :bindings '(nil ""))))
                 (when (eq operation :reinvoke)
                   (assert (equal
                            (test::command stop lease :evaluate
                                           "(progn (setf marker (transfer-state-replacement state)) (eq marker (transfer-state-replacement state)))")
                            '("T"))))
                 (setf (getf saved :index) index
                       (getf saved :old-stop) stop
                       (getf saved :old-lease) lease
                       (getf saved :old-controller) (native::transfer-case-controller record)
                       (getf saved :frame) (getf (nth index (test::command stop lease :frames)) :frame)
                       (getf saved :marker) (native::transfer-state-marker
                                            (native::transfer-case-state record))
                       (getf saved :replacement) (native::transfer-state-replacement
                                                 (native::transfer-case-state record)))
                 (when preparing
                   (let ((id (submit saved)))
                     (setf (getf saved :id) id
                           (getf saved :input) (if (eq operation :return)
                                                  (format nil "~A~%" (return-source)) "")
                           (getf saved :preview) (d:debugger-command-output stop id 0))))
                 (setf (getf saved :history)
                       (d::service-stop-evaluation-history (d::service-handle-stop stop))))))
           (setf (getf *state* :cases) (nreverse (getf *state* :cases))
                 (getf *state* :points) (s::instruction-breakpoints))
           (assert (= (length (getf *state* :points)) 1))
           (dolist (saved (getf *state* :cases))
             (assert (d::service-handle-p (getf saved :old-stop)))
             (assert (d::service-lease-p (getf saved :old-lease)))
             (assert (d::service-frame-p (getf saved :frame)))
             (assert (d::service-controller-p (getf saved :old-controller)))
             (assert (integerp (getf saved :index)))
             (when (getf saved :prepared) (assert (integerp (getf saved :id)))))
           (assert (= *evaluations* 1))
           (assert (= (length (d:debugger-stops)) 4))
           (setf prepared t))
      (unless prepared (cleanup))))
  (format t "Prepared four native frame stops: parked and confirming Return/Reinvoke across zero/two prompts.~%")
  t)

(defun attach-saved-case (saved)
  (let* ((record (getf saved :record))
         (stop (native::live-stop (native::transfer-case-thread record)))
         (raw (d::service-handle-stop stop))
         (state (native::transfer-case-state record)))
    (assert (d::service-handle-p (getf saved :old-stop)))
    (assert (d::service-lease-p (getf saved :old-lease)))
    (assert (d::service-frame-p (getf saved :frame)))
    (assert (d::service-controller-p (getf saved :old-controller)))
    (test::expect-error :expired-stop
                       (lambda () (d:debugger-stop-information (getf saved :old-stop))))
    (test::expect-error :expired-stop
                       (lambda () (d:supply-debugger-command-input
                                   (getf saved :old-lease) 0 0 "")))
    (test::expect-error :expired-stop
                       (lambda () (d::check-service-frame (getf saved :frame) raw)))
    (test::expect-error :expired-controller
                       (lambda () (d::check-service-controller (getf saved :old-controller))))
    (d:close-debugger-controller (getf saved :old-controller))
    (setf (native::transfer-case-controller record) (d:make-debugger-controller)
          (native::transfer-case-stop record) stop
          (native::transfer-case-lease record)
          (d:attach-debugger-stop stop (native::transfer-case-controller record)))
    (assert (= (getf saved :index) (d::service-stop-current-frame raw)))
    (assert (eq (getf saved :history) (d::service-stop-evaluation-history raw)))
    (assert (eq (getf saved :marker) (native::transfer-state-marker state)))
    (assert (eq (getf saved :replacement) (native::transfer-state-replacement state)))
    (assert (= (native::transfer-state-entries state) 1))
    (assert (null (native::transfer-state-events state)))
    (assert (not (native::transfer-state-completed state)))))

(defun continue-reinvocation (saved id)
  (let* ((record (getf saved :record))
         (state (native::transfer-case-state record))
         (old-stop (native::transfer-case-stop record))
         (old-lease (native::transfer-case-lease record))
         (stop (test::await
                (lambda () (native::live-stop (native::transfer-case-thread record)))))
         (lease (d:attach-debugger-stop stop (native::transfer-case-controller record))))
    (assert (/= (getf (d:debugger-stop-information stop) :id)
                (getf (d:debugger-stop-information old-stop) :id)))
    (assert (null (getf (d:debugger-stop-information stop) :parent)))
    (assert (= (native::transfer-state-entries state) 2))
    (assert (equal (s::instruction-breakpoints) (getf *state* :points)))
    (unless (getf saved :prepared)
      (assert (= (d:submit-debugger-command old-lease id :reinvoke (list nil nil)) id))
      (assert (= (native::transfer-state-entries state) 2)))
    (d:release-debugger-stop old-lease)
    (setf (native::transfer-case-stop record) stop
          (native::transfer-case-lease record) lease)
    (native::select-frame record #'native::target)
    (assert (equal (test::command stop lease :evaluate
                                 "(values (eq marker (transfer-state-replacement state)) *probe*)")
                   '("T" ":TARGET")))
    (assert (search "*PROBE*" (test::command stop lease :bindings '(nil ""))))
    (let ((next (getf (d:debugger-stop-information stop) :next-command-id)))
      (d:submit-debugger-command lease next :proceed)
      (assert (eq (getf (test::completed-command stop next) :state) :unwound)))
    (native::check-completed
     record (list (getf saved :replacement) 1.5d0 :target)
     '((:target :target :positive-infinity)
       (:target :target :positive-infinity)
       (:middle :middle :negative-infinity))
     2)))

(defun finish-case (saved)
  (attach-saved-case saved)
  (let* ((record (getf saved :record))
         (stop (native::transfer-case-stop record))
         (lease (native::transfer-case-lease record))
         (operation (getf saved :operation))
         (prepared (getf saved :prepared))
         (id (getf saved :id)))
    (if prepared
        (let ((next (getf (d:debugger-stop-information stop) :next-command-id))
              (input (getf saved :input)))
          (test::expect-error
           :request-conflict
           (lambda () (d:submit-debugger-command
                       lease id operation (when (eq operation :reinvoke) (list nil nil)))))
          (assert (= next (getf (d:debugger-stop-information stop) :next-command-id)))
          (ret::waiting stop id "(Y or N) ")
          (assert (equal (getf saved :preview) (d:debugger-command-output stop id 0)))
          (assert (= (length input) (getf (d:debugger-command-result stop id) :input-length)))
          (assert (= (length input) (d:supply-debugger-command-input lease id 0 input))))
        (progn
          (assert (equal (test::command stop lease :evaluate "(check-context-in-thread 1 nil)") '("T")))
          (setf id (submit saved))))
    (let* ((state (native::transfer-case-state record))
           (before (i::lisp-object-address (native::transfer-state-marker state))))
      (mezzano.extensions:gc :full t)
      (assert (/= before (i::lisp-object-address (native::transfer-state-marker state)))))
    (ret::confirm stop lease id "y")
    (let ((result (test::completed-command stop id)))
      (assert (eq (getf result :state) :unwound))
      (assert (eq (getf result :current-boot-p) (not prepared))))
    (if (eq operation :reinvoke)
        (continue-reinvocation saved id)
        (progn
          (unless prepared
            (assert (= (d:submit-debugger-command lease id :return) id)))
          (native::check-completed
           record (list (getf saved :marker) 2.5d0 :restored)
           '((:target :target :positive-infinity) (:middle :middle :negative-infinity))
           1)))))

(defun finish ()
  (assert *state*)
  (assert (not (eq (getf *state* :boot) (s:current-boot-id))))
  (assert (equal (s::instruction-breakpoints) (getf *state* :points)))
  (assert (= (length (d:debugger-stops)) 4))
  (assert (= *evaluations* 1))
  (lispm-managed-call-return-restore-test::check-resident-state)
  (let ((finished nil))
    (unwind-protect
         (progn
           (loop for function in (list #'native::target #'native::middle)
                 for bytes in (getf *state* :bytes)
                 do (assert (equalp (hw::code-bytes function) bytes)))
           (dolist (saved (getf *state* :cases)) (finish-case saved))
           (assert (= *evaluations* 2))
           (assert (equal (s::instruction-breakpoints) (getf *state* :points)))
           (setf finished t))
      (cleanup)
      (when finished (setf *state* nil))))
  (assert (null (d:debugger-stops :include-closed t)))
  (assert (null (s::instruction-breakpoints)))
  (assert (null s::*instruction-step-requests*))
  (format t "PASS restored native parked/confirming Return/Reinvoke, expired references, fresh control, accepted input/history/preview, exact heap identities, persistent retrigger/replay, values, FPU cleanup, moving GC, and prompts.~%")
  t)
