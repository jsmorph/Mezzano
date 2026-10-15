(defpackage #:lispm-native-breakpoint-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug) (#:test #:lispm-service-test)
                    (#:entry #:lispm-entry-arguments-test) (#:lap #:mezzano.lap.x86)
                    (#:ret #:lispm-frame-return-command-test))
  (:export #:run))
(in-package #:lispm-native-breakpoint-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *probe* :global)

(i::define-lap-function trap-point ((marker))
  (:gc :no-frame :layout #*0)
  (lap:push :rbp)
  (:gc :no-frame :layout #*00)
  (lap:mov64 :rbp :rsp)
  (:gc :frame)
  (lap:push :r8)
  (:gc :frame :layout #*1)
  (lap:int 3)
  (lap:mov64 :r8 (:rbp -8))
  (lap:leave)
  (:gc :no-frame :layout #*0)
  (lap:mov32 :ecx #.(ash 1 i::+n-fixnum-bits+))
  (lap:ret))

(defun caller (state marker depth)
  (declare (notinline trap-point))
  (let ((*probe* :caller))
    (unwind-protect
         (setf (aref state 0)
               (multiple-value-list
                (entry::with-prompts depth
                  (lambda () (values (trap-point marker) *probe*)))))
      (incf (aref state 1))
      (mezzano.extensions:gc :full t))))

(defun start-case (depth)
  (let* ((state (vector nil 0 (vector :native-breakpoint) nil))
         (controller (d:make-debugger-controller))
         (thread (s:make-thread
                  (lambda ()
                    (d:call-with-debugger-service
                     (lambda ()
                       (let ((*package* (find-package :lispm-native-breakpoint-test)))
                         (restart-case (caller state (aref state 2) depth)
                           (abort () (setf (aref state 3) :aborted)))))))
                  :name "Owned native breakpoint test"))
         (stop (test::await
                (lambda ()
                  (find thread (d:debugger-stops)
                        :key (lambda (handle)
                               (d::service-stop-thread (d::service-handle-stop handle)))))))
         (lease (d:attach-debugger-stop stop controller)))
    (list state controller thread stop lease)))

(defun check-saved-pc (stop)
  (let ((frame (find #'trap-point
                     (d::service-stop-frames (d::service-handle-stop stop))
                     :key (lambda (frame) (nth-value 1 (d:frame-function frame))))))
    (assert frame)
    (assert (i::frame-interrupted-p frame))
    (multiple-value-bind (name function offset) (d:frame-function frame)
      (declare (ignore name))
      (assert (eq function #'trap-point))
      (assert (= (i::function-code-byte function (1- offset)) #xCC)))))

(defun inspect-case (record)
  (destructuring-bind (state controller thread stop lease) record
    (declare (ignore thread))
    (assert (string= (test::command stop lease :condition) "Breakpoint instruction."))
    (check-saved-pc stop)
    (let ((index (position #'caller
                           (d::service-stop-frames (d::service-handle-stop stop))
                           :key (lambda (frame) (nth-value 1 (d:frame-function frame))))))
      (assert index)
      (test::command stop lease :select-frame index)
      (assert (equal (test::command stop lease :evaluate
                                   "(values (eq marker (aref state 2)) *probe*)")
                     '("T" ":CALLER")))
      (let ((id (getf (d:debugger-stop-information stop) :next-command-id)))
        (d:submit-debugger-command lease id :evaluate "(error \"Owned native-trap command failure.\")")
        (ret::abort-child stop controller id 'simple-error))
      (assert (= index (getf (d:debugger-stop-information stop) :current-frame)))
      (let ((before (i::lisp-object-address (aref state 2))))
        (mezzano.extensions:gc :full t)
        (assert (/= before (i::lisp-object-address (aref state 2)))))
      (check-saved-pc stop)
      (assert (equal (test::command stop lease :evaluate "(eq marker (aref state 2))") '("T")))
      (assert (zerop (aref state 1))))))

(defun finish-case (record abortp)
  (destructuring-bind (state controller thread stop lease) record
    (declare (ignore controller))
    (let ((id (getf (d:debugger-stop-information stop) :next-command-id)))
      (d:submit-debugger-command lease id (if abortp :abort :proceed))
      (assert (eq (getf (test::completed-command stop id) :state) :unwound)))
    (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
    (assert (= (aref state 1) 1))
    (if abortp
        (assert (and (eq (aref state 3) :aborted) (null (aref state 0))))
        (progn
          (assert (eq (first (aref state 0)) (aref state 2)))
          (assert (equal (rest (aref state 0)) '(:caller)))
          (assert (null (aref state 3)))))))

(defun cleanup-case (record)
  (destructuring-bind (state controller thread stop lease) record
    (declare (ignore state lease))
    (lispm-frame-evaluation-test::release-test-stop stop controller)
    (d:close-debugger-controller controller)
    (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))))

(defun run ()
  (dolist (configuration '(((0 nil)) ((2 nil)) ((2 t)) ((0 nil) (2 nil))))
    (let ((records nil))
      (unwind-protect
           (progn
             (dolist (case configuration) (push (start-case (first case)) records))
             (setf records (nreverse records))
             (mapc #'inspect-case records)
             (mapc (lambda (record case) (finish-case record (second case))) records configuration))
        (dolist (record records) (cleanup-case record)))))
  (assert (eq *probe* :global))
  (format t "PASS intentional INT3 entry, saved PC, caller lexical access, nested Abort, moving GC, Continue/Abort, identities, cleanup, prompts, and two shared-code threads.~%")
  t)
