(defpackage #:lispm-frame-reinvoke-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals)
                    (#:s #:mezzano.supervisor)
                    (#:base #:lispm-frame-return-test)
                    (#:sys.lap-x86 #:mezzano.lap.x86))
  (:export #:run-private #:run))
(in-package #:lispm-frame-reinvoke-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *calls* 0)
(defvar *expected* nil)

(defun selected-frame (target)
  (let ((selected nil))
    (i::map-backtrace
     (lambda (frame)
       (when (eq (nth-value 1 (i::frame-function frame)) target)
         (assert (null selected))
         (setf selected frame))))
    (assert selected)
    selected))

(defun invoke-reinvoke (target function arguments)
  (i::reinvoke-frame (selected-frame target) function arguments)
  (error "Frame Reinvoke fell through."))

(defun replacement (&rest arguments)
  (assert (= base::*probe* 11))
  (assert (equal (reverse base::*events*) '((:inner 22) (:outer 22))))
  (assert (= (length arguments) (length *expected*)))
  (assert (every #'eq arguments *expected*))
  (incf *calls*)
  (mezzano.extensions:gc :full t)
  (values-list arguments))

(defun run-case (count older younger)
  (let ((base::*events* nil)
        (*calls* 0)
        (*expected* (loop for i below count collect (vector count i))))
    (assert
     (eq (base::with-prompts
          older
          (lambda ()
            (base::caller
             (lambda ()
               (base::with-prompts younger
                 (lambda () (invoke-reinvoke #'base::target #'replacement *expected*))))
             *expected*)))
         :caller-continued))
    (assert (= *calls* 1)))
  (assert (zerop base::*probe*))
  t)

(defun run-private ()
  (dolist (count '(0 1 7 19)) (run-case count 0 0))
  (run-case 7 0 2)
  (run-case 7 2 1)
  (format t "PASS private Reinvoke caller continuation, new arities/values, heap identity, cleanup context, GC, and prompts.~%")
  t)

(defun run-closure ()
  (let ((base::*events* nil)
        (*calls* 0)
        (*expected* (loop for i below 7 collect (vector :closure i)))
        (marker (vector :captured)))
    (assert
     (eq (base::caller
          (lambda ()
            (invoke-reinvoke
             #'base::target
             (lambda (&rest arguments)
               (assert (eq (aref marker 0) :captured))
               (apply #'replacement arguments))
             *expected*))
          *expected*)
         :caller-continued))
    (assert (= *calls* 1))))

(defun run-maximum ()
  (let ((base::*events* nil)
        (arguments (loop for i below (1- call-arguments-limit) collect (vector i))))
    (assert
     (eq (base::caller
          (lambda ()
            (invoke-reinvoke
             #'base::target
             (lambda (&rest received)
               (assert (= base::*probe* 11))
               (assert (equal (reverse base::*events*) '((:inner 22) (:outer 22))))
               (assert (= (length received) (1- call-arguments-limit)))
               (assert (every #'eq received arguments))
               (mezzano.extensions:gc :full t)
               :maximum)
             arguments))
          '(:maximum))
         :caller-continued))))

(defun dynamic-list-action ()
  (let ((arguments (list (first *expected*) (second *expected*) (third *expected*)
                         (fourth *expected*) (fifth *expected*) (sixth *expected*)
                         (seventh *expected*))))
    (declare (dynamic-extent arguments))
    (let* ((stack (s::thread-stack (s:current-thread)))
           (address (i::lisp-object-address arguments)))
      (assert (<= (s::stack-base stack) address
                  (1- (+ (s::stack-base stack) (s::stack-size stack))))))
    (invoke-reinvoke #'base::target #'replacement arguments)))

(defun run-dynamic-list ()
  (let ((base::*events* nil)
        (*calls* 0)
        (*expected* (loop for i below 7 collect (vector :dynamic-spine i))))
    (assert (eq (base::caller #'dynamic-list-action *expected*) :caller-continued))
    (assert (= *calls* 1))))

(defun invalid-arguments-target (function arguments type)
  (let ((cleanup 0))
    (unwind-protect
         (let ((condition
                 (handler-case
                     (progn
                       (i::reinvoke-frame (selected-frame #'invalid-arguments-target)
                                         function arguments)
                       nil)
                   (error (observed) observed))))
           (assert (typep condition type))
           (assert (zerop cleanup))
           t)
      (incf cleanup))))

(defun reject-frame (frame reason)
  (assert (eq (nth-value 2 (i::frame-return-context frame)) reason))
  (assert
   (handler-case
       (progn (i::reinvoke-frame frame #'identity '(42)) nil)
     (simple-error (condition)
       (not (null (search (format nil "~S" reason) (princ-to-string condition))))))))

(defun run-interruption-guard ()
  (let* ((name (symbol-name (gensym "Frame Reinvoke interruption guard ")))
         (controller (mezzano.debug:make-debugger-controller))
         (state (make-array 3 :initial-element nil))
         (thread
           (s:make-thread
            (lambda ()
              (mezzano.debug:call-with-debugger-service
               (lambda ()
                 (with-simple-restart (abort "Abort the owned Reinvoke interruption guard.")
                   (base::interrupted-work state)))))
            :name name)))
    (unwind-protect
         (progn
           (lispm-service-test::await (lambda () (aref state 0)))
           (s:establish-thread-foothold
            thread
            (lambda ()
              (base::with-interrupted-flag-guards
               #'base::interrupted-work
               (lambda (frame) (reject-frame frame :interrupt-boundary)))
              (setf (aref state 2) t)))
           (lispm-service-test::await (lambda () (aref state 2))))
      (setf (aref state 1) t)
      (let ((stop (lispm-service-test::stop-for-thread name)))
        (when stop (lispm-frame-evaluation-test::release-test-stop stop controller)))
      (lispm-service-test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
      (mezzano.debug:close-debugger-controller controller))))

(defun run-guards ()
  (assert (invalid-arguments-target 42 nil 'type-error))
  (assert (invalid-arguments-target 'identity nil 'type-error))
  (assert (invalid-arguments-target #'identity '(1 . 2) 'type-error))
  (assert (invalid-arguments-target #'identity "not a list" 'type-error))
  (assert (invalid-arguments-target #'identity (make-list call-arguments-limit) 'simple-error))
  (let ((cycle (list 1)))
    (setf (cdr cycle) cycle)
    (assert (invalid-arguments-target #'identity cycle 'simple-error)))
  (base::frameless-guard
   (lambda () (reject-frame (selected-frame #'base::frameless-guard) :frameless-frame)))
  (base::framed-guard
   (lambda () (reject-frame (selected-frame #'base::framed-guard) :unavailable-source-scope)))
  (reject-frame (i::make-frame :fp 0 :pc-slot 0) :inactive-frame)
  (run-interruption-guard))

(defun run-superseding-exit ()
  (let ((base::*events* nil)
        (*calls* 0)
        (*expected* nil))
    (assert
     (eq (catch 'superseding-reinvoke
           (base::target
            (lambda ()
              (unwind-protect
                   (invoke-reinvoke #'base::target #'replacement nil)
                (throw 'superseding-reinvoke :superseded)))
            1 2 3 4 5 6)
           :fell-through)
         :superseded))
    (assert (zerop *calls*))
    (assert (equal (reverse base::*events*) '((:inner 22) (:outer 22)))))
  (assert (zerop base::*probe*)))

(defun run-replacement-error ()
  (let ((base::*events* nil)
        (condition (make-condition 'simple-error :format-control "Owned Reinvoke replacement error.")))
    (assert
     (eq (handler-case
             (base::caller
              (lambda ()
                (invoke-reinvoke
                 #'base::target
                 (lambda ()
                   (assert (= base::*probe* 11))
                   (assert (equal (reverse base::*events*) '((:inner 22) (:outer 22))))
                   (error condition))
                 nil))
              nil)
           (error (observed) observed))
         condition)))
  (assert (zerop base::*probe*)))

(defun stress-target (arguments state a b c d e f)
  (assert (equal (list a b c d e f) '(1 2 3 4 5 6)))
  (unwind-protect
       (invoke-reinvoke #'stress-target #'values-list (list arguments))
    (incf (aref state 2))))

(defun run-concurrent-gc ()
  (let* ((name (symbol-name (gensym "Frame Reinvoke GC test ")))
         (controller (mezzano.debug:make-debugger-controller))
         (state (vector 0 nil 0))
         (thread
           (s:make-thread
            (lambda ()
              (mezzano.debug:call-with-debugger-service
               (lambda ()
                 (with-simple-restart (abort "Abort the owned Reinvoke GC test.")
                   (loop until (aref state 1)
                         for count = (mod (aref state 0) 3)
                         for arguments = (loop for i below (ecase count (0 0) (1 1) (2 7))
                                               collect (vector i (aref state 0)))
                         for result = (multiple-value-list
                                       (stress-target arguments state 1 2 3 4 5 6))
                         do (assert (= (length result) (length arguments)))
                            (assert (every #'eq result arguments))
                            (incf (aref state 0)))))))
            :name name)))
    (unwind-protect
         (progn
           (lispm-service-test::await (lambda () (plusp (aref state 0))))
           (dotimes (i 8)
             (let ((before (aref state 0)))
               (mezzano.extensions:gc :full t)
               (lispm-service-test::await (lambda () (> (aref state 0) before))))))
      (setf (aref state 1) t)
      (let ((stop (lispm-service-test::stop-for-thread name)))
        (when stop (lispm-frame-evaluation-test::release-test-stop stop controller)))
      (lispm-service-test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
      (mezzano.debug:close-debugger-controller controller))
    (assert (= (aref state 0) (aref state 2)))
    (format t "Frame Reinvoke completed ~D transfers with eight concurrent full collections.~%"
            (aref state 0))))

(defun run ()
  (run-private)
  (run-closure)
  (run-maximum)
  (run-dynamic-list)
  (run-guards)
  (run-superseding-exit)
  (run-replacement-error)
  (run-concurrent-gc)
  (format t "PASS internal Reinvoke boundary/argument guards, closure and maximum calls, dynamic-extent spine, superseding cleanup, replacement error, and concurrent GC.~%")
  t)
