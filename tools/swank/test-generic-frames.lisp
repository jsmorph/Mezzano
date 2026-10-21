(defpackage #:lispm-generic-frame-test
  (:use #:cl #:mezzano.debug)
  (:local-nicknames (#:d #:mezzano.debug) (#:i #:mezzano.internals)
                    (#:test #:lispm-service-test) (#:frame #:lispm-frame-evaluation-test)
                    (#:catch-test #:lispm-catch-display-test))
  (:export #:run))
(in-package #:lispm-generic-frame-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun target ()
  (break "Owned generic-frame test.")
  (values 42 43))

(defgeneric single-target (value))
(defmethod single-target ((value integer))
  (declare (ignore value))
  (target))

(defgeneric wide-target (value a b c d e))
(defmethod wide-target ((value integer) a b c d e)
  (declare (ignore value a b c d e))
  (target))

(defclass probe ()
  ((value :initarg :value :type fixnum :accessor probe-value)))

(defmethod slot-unbound ((class t) (object probe) (name (eql 'value)))
  (declare (ignore class object name))
  (target))

(defun check-find-frame (handle lease index generic)
  (let* ((name (mezzano.clos::safe-generic-function-name generic))
         (text (symbol-name (if (symbolp name) name (second name))))
         (history (copy-list (d::service-stop-evaluation-history (d::service-handle-stop handle)))))
    (test::command handle lease :top-frame)
    (loop repeat (1+ index)
          for result = (test::command handle lease :find-frame (list text nil nil nil))
          do (assert (null (getf result :message)) () "~S" result)
             (assert (<= (getf result :index) index))
          when (= (getf result :index) index) return nil
          finally (error "Frame search did not reach generic frame ~D." index))
    (assert (every #'eq history (d::service-stop-evaluation-history (d::service-handle-stop handle))))))

(defun check-association (handle lease generic)
  (let* ((stop (d::service-handle-stop handle))
         (index (position generic (d::service-stop-frames stop) :key #'frame-function)))
    (assert index () "No retained frame identifies ~S." generic)
    (test::command handle lease :select-frame index)
    (let* ((selected (aref (d::service-stop-frames stop) index))
           (actual (nth-value 1 (frame-function selected)))
           (history (copy-list (d::service-stop-evaluation-history stop))))
      (format t "Associated ~S through ~S.~%" generic (i::function-name actual))
      (check-find-frame handle lease index generic)
      (test::command handle lease :function)
      (setf (fourth history) generic)
      (let ((name (mezzano.clos::safe-generic-function-name generic)))
        (assert (eq (fdefinition name) generic))
        (unwind-protect
             (progn
               (setf (fdefinition name) #'identity)
               (mezzano.extensions:gc :full t)
               (assert (eq (frame-function selected) generic))
               (assert (eq (nth-value 1 (frame-function selected)) actual))
               (check-find-frame handle lease index generic)
               (test::command handle lease :function)
               (test::command handle lease :compiled-code)
               (test::command handle lease :instruction))
          (setf (fdefinition name) generic)))
      (assert (= index (d::service-stop-current-frame stop)))
      (assert (equal history (d::service-stop-evaluation-history stop))))))

(defun run-returning-case (source generic)
  (catch-test::run-target
   source #'target
   (lambda (handle lease controller)
     (declare (ignore controller))
     (check-association handle lease generic))))

(defun run-writer-case ()
  (let* ((controller (make-debugger-controller))
         (job (start-evaluation-job
               (string-downcase (format nil "~32,'0X~32,'0X" (get-universal-time)
                                        (random most-positive-fixnum)))
               "(funcall (fdefinition '(setf probe-value)) :invalid (make-instance 'probe))"
               :package "LISPM-GENERIC-FRAME-TEST"))
         (handle nil) (lease nil))
    (unwind-protect
         (progn
           (setf handle (test::await (lambda () (first (getf (evaluation-job-information job) :stops))))
                 lease (attach-debugger-stop handle controller))
           (let ((condition (d::service-stop-condition (d::service-handle-stop handle))))
             (assert (typep condition 'type-error))
             (assert (eq (type-error-datum condition) :invalid))
             (assert (eq (type-error-expected-type condition) 'fixnum)))
           (check-association handle lease (fdefinition '(setf probe-value)))
           (let ((id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id :abort)
             (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
           (test::await (lambda () (not (eq (getf (evaluation-job-information job) :state) :running))))
           (assert (eq (getf (evaluation-job-information job) :state) :aborted))
           (release-debugger-stop lease)
           (setf handle nil)
           (release-evaluation-job job)
           (setf job nil))
      (when handle (frame::release-test-stop handle controller))
      (when job
        (test::await (lambda () (not (eq (getf (evaluation-job-information job) :state) :running))))
        (release-evaluation-job job))
      (close-debugger-controller controller))))

(defun run ()
  (loop repeat 2
        do (run-returning-case "(lispm-generic-frame-test::single-target 0)" #'single-target))
  (loop repeat 2
        do (run-returning-case "(lispm-generic-frame-test::wide-target 0 1 2 3 4 5)"
                               #'wide-target))
  (assert (= (probe-value (make-instance 'probe :value 7)) 7))
  (loop repeat 2
        do (run-returning-case
            "(values (lispm-generic-frame-test::probe-value (make-instance 'lispm-generic-frame-test::probe)) 43)"
            #'probe-value))
  (assert (= (funcall (fdefinition '(setf probe-value)) 7 (make-instance 'probe)) 7))
  (run-writer-case)
  (run-writer-case)
  (format t "PASS single-dispatch and accessor generic identities, cached calls, active redefinition, GC, function history, code identity, continuation, Abort, and release.~%")
  t)
