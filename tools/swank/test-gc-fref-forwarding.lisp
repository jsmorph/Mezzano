(defpackage #:lispm-gc-fref-forwarding-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals)
                    (#:s #:mezzano.supervisor)))
(in-package #:lispm-gc-fref-forwarding-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun capture-metadata (fref output)
  (multiple-value-bind (frame interrupt pushed pushed-register layout length
                        multiple incoming thunk registers entry restart)
      (i::gc-info-for-function-offset fref 35)
    (setf (svref output 0) frame (svref output 1) interrupt
          (svref output 2) pushed (svref output 3) pushed-register
          (svref output 4) layout (svref output 5) length
          (svref output 6) multiple (svref output 7) incoming
          (svref output 8) thunk (svref output 9) registers
          (svref output 10) entry (svref output 11) restart))
  (values))

(defun capture-forwarded-metadata (fref pairs output)
  (let ((headers (make-array (length pairs) :initial-element 0)))
    (s:with-world-stopped ()
      (loop for (old . new) in pairs for index from 0
            do (setf (svref headers index)
                     (i::memref-unsigned-byte-64
                      (i::object-base-address old) 0)))
      (unwind-protect
           (progn
             (dolist (pair pairs)
               (setf (i::memref-unsigned-byte-64
                      (i::object-base-address (car pair)) 0)
                     (logior (i::object-base-address (cdr pair))
                             i::+tag-gc-forward+)))
             (capture-metadata fref output))
        (loop for (old . new) in pairs for index from 0
              do (setf (i::memref-unsigned-byte-64
                        (i::object-base-address old) 0)
                       (svref headers index))))))
  (values))

(defun reference (target)
  (let ((fref (i::make-function-reference (gensym "Owned GC forwarding "))))
    (when target (setf (i::function-reference-function fref) target))
    fref))

(defun generic (target)
  (let ((function (make-instance 'standard-generic-function
                                 :name (gensym "Owned GC generic ")
                                 :lambda-list nil)))
    (mezzano.clos::set-funcallable-instance-function function target)
    function))

(defun run (&key (forwarded t))
  (let* ((factory (compile nil '(lambda (value) (lambda () value))))
         (token (list :owned-gc-forwarding))
         (old (funcall factory token))
         (middle (funcall factory token))
         (new (funcall factory token))
         (body (i::%closure-function old))
         (old-generic (generic old))
         (new-generic (generic old))
         (outer-generic (generic old-generic))
         (rows (list (list :plain (reference body) body nil)
                     (list :undefined (reference nil) #'i::raise-undefined-function nil)
                     (list :closure (reference old) body nil)
                     (list :generic (reference old-generic) body nil)
                     (list :nested-generics (reference outer-generic) body nil))))
    (assert (and (i::closure-p old) (i::closure-p middle) (i::closure-p new)))
    (assert (eq body (i::%closure-function new)))
    (when forwarded
      (setf rows
            (append rows
                    (list
                     (list :forwarded-closure (reference old) body
                           (list (cons old new)))
                     (list :forwarding-chain (reference old) body
                           (list (cons old middle) (cons middle new)))
                     (list :forwarded-generic (reference old-generic) body
                           (list (cons old-generic new-generic)))
                     (list :forwarded-discriminator (reference old-generic) body
                           (list (cons old new)))
                     (list :forwarded-both (reference old-generic) body
                           (list (cons old-generic new-generic) (cons old new)))))))
    (dolist (row rows)
      (destructuring-bind (name fref function pairs) row
        (let ((expected (multiple-value-list (i::gc-info-for-function-offset function 16)))
              (output (make-array 12 :initial-element nil)))
          (capture-forwarded-metadata fref pairs output)
          (assert (equal expected (coerce output 'list)))
          (i::gc :full t)
          (assert (eq (funcall old) token))
          (assert (eq (funcall new) token))
          (format t "PASS function-reference metadata ~S.~%" name))))
    (length rows)))

(defvar *entered* nil)
(defvar *release* nil)
(defvar *result* nil)
(defvar *thread* nil)

(defun await (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 20 internal-time-units-per-second))))
    (loop until (funcall predicate)
          do (assert (< (get-internal-real-time) deadline))
             (s:thread-yield))))

(defun run-interrupted ()
  (assert (null *thread*))
  (setf *entered* nil *release* nil *result* nil)
  (let* ((name (gensym "Owned interrupted fref "))
         (token (list :interrupted-fref))
         (factory (compile nil '(lambda (value) (lambda () value))))
         (closure (funcall factory token))
         (target (generic closure))
         (fref nil)
         (worker nil))
    (setf (fdefinition name) target
          fref (i::function-reference name)
          worker (compile nil `(lambda ()
                                 (setf *entered* t)
                                 (loop until *release*)
                                 (,name))))
    (setf *thread* (s:make-thread (lambda () (setf *result* (funcall worker)))
                                  :name "Owned interrupted fref GC test"))
    (await (lambda () *entered*))
    (s::stop-thread *thread*)
    (s::convert-thread-to-full-save *thread*)
    (setf *release* t)
    (let ((pc (+ (logand (i::lisp-object-address fref) -16) 35)))
      (loop repeat 2000
            when (= (s:thread-state-rip *thread*) pc) do (return)
            do (i::safe-single-step-thread *thread*)
            finally (error "Did not reach the owned function-reference trampoline."))
      (dotimes (index 4)
        (assert (= (s:thread-state-rip *thread*) pc))
        (let ((before (i::lisp-object-address closure)))
          (i::gc :full t)
          (assert (/= before (i::lisp-object-address closure))))
        (assert (= (s:thread-state-rip *thread*) pc))
        (assert (eq (i::function-reference-function fref) target))
        (assert (eq (i::funcallable-instance-function target) closure))
        (format t "PASS real full collection ~D at function-reference byte offset 35.~%"
                (1+ index))))
    (s::resume-thread *thread*)
    (multiple-value-bind (values joined) (s:thread-join *thread*)
      (assert joined)
      (assert (eq (first values) token)))
    (await (lambda () (eq (s::sample-thread-state *thread*) :dead)))
    (assert (eq *result* token))
    (fmakunbound name)
    (setf *thread* nil *entered* nil *release* nil *result* nil)
    :interrupted-fref-gc-tested))
