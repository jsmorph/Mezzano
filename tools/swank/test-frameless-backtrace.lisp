(defpackage #:lispm-frameless-test
  (:use #:cl #:mezzano.debug)
  (:import-from #:lispm-debugger-control-test
                #:await #:fresh-name #:run-command #:restart-index #:stopped #:wait-job)
  (:export #:run))
(in-package #:lispm-frameless-test)

(defvar *entered* nil)
(defvar *release* nil)
(defvar *root* nil)
(defvar *cleanups* 0)
(defvar *job* nil)
(defvar *lease* nil)

(mezzano.internals::define-lap-function leaf ((object))
  (:gc :no-frame :layout #*0)
  (mezzano.lap.x86:mov64 :r9 (:symbol-global-cell *entered*))
  (mezzano.lap.x86:mov64 :rax (:constant t))
  (mezzano.lap.x86:mov64
   (:object :r9 #.mezzano.internals::+symbol-value-cell-value+) :rax)
  wait
  (mezzano.lap.x86:mov64 :r9 (:symbol-global-cell *release*))
  (mezzano.lap.x86:mov64
   :r9 (:object :r9 #.mezzano.internals::+symbol-value-cell-value+))
  (mezzano.lap.x86:cmp64 :r9 :r14)
  (mezzano.lap.x86:jz wait)
  (mezzano.lap.x86:mov32 :ecx #.(ash 1 mezzano.internals::+n-fixnum-bits+))
  (:gc :no-frame :layout #*0 :multiple-values 0)
  (mezzano.lap.x86:ret))

(defun caller (a b root)
  (declare (optimize (debug 3) (safety 3)))
  (unwind-protect
       (let ((result (leaf root)))
         (values (+ a b) (eq result root)))
    (incf *cleanups*)))

(defun raw-frame (reference stop)
  (mezzano.debug::check-service-frame
   reference (mezzano.debug::check-service-handle stop)))

(defun check-local (frame name value)
  (let ((local (find name (frame-local-variables frame)
                     :key #'local-variable-name)))
    (assert local)
    (multiple-value-bind (observed available) (local-variable-value frame local)
      (assert available)
      (assert (eql observed value)))))

(defun run ()
  (setf *entered* nil *release* nil *root* (vector :movable :caller)
        *cleanups* 0)
  (let ((controller (make-debugger-controller)))
    (setf *job* (start-evaluation-job
                 (fresh-name) "(lispm-frameless-test::caller
                                111 222 lispm-frameless-test::*root*)"))
    (await "frameless callee entry" (lambda () *entered*))
    (interrupt-evaluation-job *job* 0)
    (let* ((stop (stopped *job*))
           (lease (setf *lease* (attach-debugger-stop stop controller)))
           (records (getf (run-command stop lease :frames) :result))
           (leaf-position
             (position-if (lambda (entry)
                            (eq (nth-value 1 (frame-function
                                             (raw-frame (getf entry :frame) stop)))
                                #'leaf))
                          records))
           (caller-position
             (position-if (lambda (entry)
                            (eq (nth-value 1 (frame-function
                                             (raw-frame (getf entry :frame) stop)))
                                #'caller))
                          records)))
      (assert leaf-position)
      (assert caller-position)
      (assert (= caller-position (1+ leaf-position)))
      (let* ((leaf-frame (raw-frame (getf (nth leaf-position records) :frame) stop))
             (caller-frame (raw-frame (getf (nth caller-position records) :frame) stop))
             (leaf-data (mezzano.internals::frame-raw-data leaf-frame))
             (address (mezzano.internals::lisp-object-address *root*)))
        (assert (mezzano.internals::frame-interrupted-p leaf-frame))
        (assert (null (mezzano.internals::frame-stack-available-p leaf-data)))
        (assert (eq (mezzano.internals::read-frame-slot leaf-data 0)
                    :$inaccessible-value$))
        (assert (handler-case
                    (progn (mezzano.internals::write-frame-slot leaf-data 0 nil) nil)
                  (error () t)))
        (check-local caller-frame 'a 111)
        (check-local caller-frame 'b 222)
        (check-local caller-frame 'root *root*)
        (mezzano.extensions:gc :full t)
        (assert (/= address (mezzano.internals::lisp-object-address *root*)))
        (assert (eq (nth-value 1 (frame-function leaf-frame)) #'leaf))
        (assert (eq (nth-value 1 (frame-function caller-frame)) #'caller))
        (check-local caller-frame 'a 111)
        (check-local caller-frame 'b 222)
        (check-local caller-frame 'root *root*))
      (setf *release* t)
      (run-command stop lease :invoke-restart-interactively
                   (restart-index stop lease "CONTINUE"))
      (assert (equal (getf (wait-job *job* :returned) :values) '("333" "T")))
      (assert (= *cleanups* 1))
      (release-debugger-stop lease))
    (release-evaluation-job *job*)
    (close-debugger-controller controller)
    (setf *job* nil *lease* nil)
    (format t "PASS frameless interrupted callee, adjacent caller, unavailable callee stack slots, caller locals, moving GC, continuation, and cleanup.~%")
    :passed))
