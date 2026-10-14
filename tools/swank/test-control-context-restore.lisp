(defpackage #:lispm-control-context-restore-test
  (:use #:cl #:mezzano.debug)
  (:local-nicknames (#:d #:mezzano.debug) (#:i #:mezzano.internals)
                    (#:c #:lispm-control-records-test) (#:test #:lispm-service-test)
                    (#:frame #:lispm-frame-evaluation-test))
  (:export #:prepare-restore-test #:finish-restore-test))
(in-package #:lispm-control-context-restore-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defvar *thread* nil)
(defvar *old-handle* nil)
(defvar *destinations* nil)
(defvar *result* nil)
(defvar *views* nil)
(defvar *code-command-id* nil)

(defun observe-destinations ()
  (loop for row in (c::observe)
        when (eq (third row) 'mezzano.runtime::*active-catch-handlers*)
          collect
          (let* ((exit (svref (fourth row) 1))
                 (entry (find-if
                         (lambda (entry)
                           (and (eq (first entry) :block)
                                (eq (i::debug-binding-name (second entry)) 'i::%catch)))
                         (i::closure-control-bindings exit))))
            (assert entry)
            (multiple-value-bind (function offset available)
                (i::control-context-destination (third entry))
              (assert available)
              (assert (eq function
                          (nth-value 1
                           (frame-function
                            (aref (d::service-stop-frames d::*service-current-stop*)
                                  (first row))))))
              (list (svref (fourth row) 0) function offset)))))

(defun prepare-restore-test ()
  (assert (null *thread*))
  (setf c::*outer-handler-count* 0 c::*second-handler-count* 0 c::*cleanup-count* 0
        c::*after-body-count* 0 c::*after-inner-count* 0 *result* nil
        *views* nil *code-command-id* nil)
  (setf *thread*
        (mezzano.supervisor:make-thread
         (lambda ()
           (let ((*package* (find-package :lispm-control-records-test)))
             (call-with-debugger-service
              (lambda ()
                (with-simple-restart (abort "Abort the owned catch restoration test.")
                  (setf *result* (multiple-value-list (c::application :duplicate))))))))
         :name "Captured catch restoration test")
        *old-handle*
        (test::await (lambda () (test::stop-for-thread "Captured catch restoration test"))))
  (let* ((controller (make-debugger-controller))
         (lease (attach-debugger-stop *old-handle* controller)))
    (unwind-protect
         (progn
           (frame::select-function *old-handle* lease #'c::body-target)
           (test::command *old-handle* lease :evaluate
                          "(setf lispm-control-context-restore-test::*destinations*
                                 (lispm-control-context-restore-test::observe-destinations))")
           (assert (= (length *destinations*) 2))
           (test::command *old-handle* lease :function)
           (setf *code-command-id*
                 (getf (debugger-stop-information *old-handle*) :next-command-id))
           (let ((code (test::command *old-handle* lease :compiled-code))
                 (instruction (test::command *old-handle* lease :instruction))
                 (stop (d::service-handle-stop *old-handle*)))
             (setf *views*
                   (list (d::service-stop-current-frame stop)
                         (copy-list (d::service-stop-evaluation-history stop))
                         code instruction))))
      (close-debugger-controller controller)))
  (format t "Prepared live catch destinations for image restoration.~%")
  t)

(defun check-restored-views (handle lease)
  (let ((stop (d::service-handle-stop handle)))
    (assert (= (d::service-stop-current-frame stop) (first *views*)))
    (assert (eq (fourth (second *views*))
                (frame-function (aref (d::service-stop-frames stop) (first *views*)))))
    (assert (equal (test::command handle lease :compiled-code) (third *views*)))
    (assert (equal (test::command handle lease :instruction) (fourth *views*)))
    (assert (equal (d::service-stop-evaluation-history stop) (second *views*)))))

(defun finish-restore-test ()
  (test::expect-error :expired-stop (lambda () (debugger-stop-information *old-handle*)))
  (let* ((controller (make-debugger-controller))
         (handle (test::stop-for-thread "Captured catch restoration test"))
         (lease (attach-debugger-stop handle controller)))
    (unwind-protect
         (progn
           (let ((old (debugger-command-result handle *code-command-id*)))
             (assert (not (getf old :current-boot-p)))
             (assert (equal (getf old :result) (third *views*))))
           (test::expect-error :request-conflict
                               (lambda ()
                                 (submit-debugger-command lease *code-command-id* :compiled-code)))
           (check-restored-views handle lease)
           (mezzano.extensions:gc :full t)
           (check-restored-views handle lease)
           (frame::evaluate-source
            handle lease
            "(equal lispm-control-context-restore-test::*destinations*
                    (lispm-control-context-restore-test::observe-destinations))" '("T"))
           (frame::evaluate-source
            handle lease
            "(progn (mezzano.extensions:gc :full t)
                    (equal lispm-control-context-restore-test::*destinations*
                           (lispm-control-context-restore-test::observe-destinations)))" '("T"))
           (let ((id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id :proceed)
             (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
           (test::await (lambda () (nth-value 1 (mezzano.supervisor:thread-join *thread* nil))))
           (assert (equal *result* '(42 43)))
           (assert (= c::*cleanup-count* c::*after-inner-count* 1))
           (assert (zerop c::*after-body-count*))
           (release-debugger-stop lease)
           (setf handle nil *thread* nil *old-handle* nil *destinations* nil *result* nil
                 *views* nil *code-command-id* nil)
           (format t "PASS restored catch destinations and code views, function history, prior-boot replay rejection, expired handle, fresh inspection, GC, multiple-value THROW, cleanup, continuation, and release.~%")
           t)
      (when handle (frame::release-test-stop handle controller))
      (close-debugger-controller controller))))
