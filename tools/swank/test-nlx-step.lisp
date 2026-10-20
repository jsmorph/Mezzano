(defpackage #:lispm-nlx-step-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:s #:mezzano.supervisor)
                    (#:d #:mezzano.debug) (#:test #:lispm-service-test)
                    (#:lap #:mezzano.lap.x86)
                    (#:retained #:lispm-retained-step-test)
                    (#:call #:lispm-managed-call-return-test)
                    (#:entry #:lispm-entry-arguments-test)
                    (#:over #:lispm-step-over-test)
                    (#:dis #:mezzano.disassemble) (#:x #:mezzano.disassemble.x86-64))
  (:export #:run))
(in-package #:lispm-nlx-step-test)
(declaim (optimize (safety 3) (debug 3) (speed 1)))
(declaim (notinline target internal-callee))

(i::define-lap-function call-site ((state))
  (:gc :no-frame :layout #*0)
  (lap:push :rbp)
  (:gc :no-frame :layout #*00)
  (lap:mov64 :rbp :rsp)
  (:gc :frame)
  (lap:push :r8)
  (:gc :frame :layout #*1)
  (lap:push 0)
  (lap:mov64 :rbx (:object :r8 7))
  (lap:call (:object :rbx #.i::+function-entry-point+))
  (:gc :frame :layout #*1 :multiple-values 0)
  (lap:leave)
  (:gc :no-frame :layout #*0 :multiple-values 0)
  (lap:ret))

(defun returned-values (state)
  (values-list (aref state 2)))

(defun internal-callee (state)
  (entry::with-prompts
   (aref state 5)
   (lambda ()
     (block inside
       (setf (aref state 8)
             (lambda () (return-from inside (returned-values state))))
       (funcall (aref state 8))
       (error "Internal exit returned.")))))

(defun invoke-call (state depth)
  (entry::with-prompts depth (lambda () (call-site state)))
  (error "Escaping call returned."))

(defun target (state mode depth)
  (ecase mode
    (:return
     (block outside
       (setf (aref state 7)
             (lambda (argument)
               (assert (eq argument state))
               (return-from outside (returned-values state))))
       (invoke-call state depth)))
    (:go
     (tagbody
        (setf (aref state 7)
              (lambda (argument)
                (assert (eq argument state))
                (go destination)))
        (invoke-call state depth)
      destination)
     (returned-values state))
    (:throw
     (catch 'owned-nlx
       (setf (aref state 7)
             (lambda (argument)
               (assert (eq argument state))
               (throw 'owned-nlx (returned-values state))))
       (invoke-call state depth)))
    (:internal
     (setf (aref state 7) #'internal-callee)
     (call-site state))))

(defun run-case (mode depth &optional collect (value-count 3) fill-table step-landing)
  (let* ((state (make-array 12 :initial-element nil))
         (controller (d:make-debugger-controller))
         (function #'call-site)
         (offset (call::call-location function))
         (point nil) (thread nil) (stop nil) (lease nil) (public nil))
    (setf (aref state 3) 0
          (aref state 4) (vector :nlx-step mode depth)
          (aref state 5) depth
          (aref state 2) (when (plusp value-count)
                           (cons (aref state 4)
                                 (loop for n from 1 below value-count collect n))))
    (unwind-protect
         (progn
           (when fill-table
             (dolist (name '(lispm-hardware-breakpoint-test::target-one
                             lispm-hardware-breakpoint-test::target-three
                             lispm-hardware-breakpoint-test::target-four))
               (push (s::install-instruction-breakpoint (fdefinition name) 16) public)))
           (setf point (s::install-instruction-breakpoint function offset)
                 thread
                 (s:make-thread
                  (lambda ()
                    (d:call-with-debugger-service
                     (lambda ()
                       (restart-case
                           (unwind-protect
                                (setf (aref state 6)
                                      (multiple-value-list (target state mode depth)))
                             (incf (aref state 3)))
                         (abort () :aborted)))))
                  :name "Owned nonlocal step target"))
           (setf stop (test::await
                       (lambda ()
                         (find thread (d:debugger-stops)
                               :key (lambda (handle)
                                      (d::service-stop-thread (d::service-handle-stop handle))))))
                 lease (d:attach-debugger-stop stop controller))
           (retained::location stop function offset)
           (assert (s::clear-instruction-breakpoint point))
           (setf point nil)
           (let* ((before (d:debugger-stop-information stop))
                  (generation (getf before :generation))
                  (id (getf before :next-command-id)))
             (d:submit-debugger-command lease id :single-step)
             (assert (eq (getf (test::completed-command stop id) :state) :unwound))
             (test::await
              (lambda ()
                (let ((info (d:debugger-stop-information stop)))
                  (and (eq (getf info :state) :stopped)
                       (> (getf info :generation) generation)))))
             (assert (= (getf (d:debugger-stop-information stop) :generation) (1+ generation)))
             (assert (= (getf (d:debugger-command-result stop id) :generation) generation))
             (multiple-value-bind (actual pc index reason)
                 (d::service-instruction-trap-context (d::service-handle-stop stop))
               (declare (ignore index))
               (assert (null reason))
               (assert (eq actual
                           (case mode
                             (:throw (fdefinition 'i::%catch))
                             (:internal function)
                             (otherwise #'target))))
               (if (eq mode :internal)
                   (assert (= pc (nth-value 1 (call::call-location function))))
                   (assert
                    (find-if
                     (lambda (instruction)
                       (and instruction
                            (eq (x::inst-opcode instruction) 'mezzano.lap.x86:call)
                            (= (+ (dis:inst-offset instruction) (dis:inst-size instruction)) pc)))
                     (dis:context-instructions (dis:make-disassembler-context actual)))))
               (when collect
                 (let ((address (i::lisp-object-address (aref state 4))))
                   (mezzano.extensions:gc :full t)
                   (assert (/= address (i::lisp-object-address (aref state 4)))))))
             (assert (null (over::private-points)))
             (when fill-table
               (assert (equal (sort (copy-list public) #'< :key #'i::lisp-object-address)
                              (sort (s::instruction-breakpoints) #'< :key #'i::lisp-object-address))))
             (assert (null s::*instruction-step-requests*))
             (let ((next (getf (d:debugger-stop-information stop) :next-command-id)))
               (assert (= (d:submit-debugger-command lease id :single-step) id))
               (assert (= next (getf (d:debugger-stop-information stop) :next-command-id)))))
           (when step-landing
             (assert (eq mode :throw))
             (multiple-value-bind (actual pc)
                 (d::service-instruction-trap-context (d::service-handle-stop stop))
               (let ((instruction (dis:instruction-at (dis:make-disassembler-context actual) pc)))
                 (assert (member (x::inst-opcode instruction) '(lap:mov64 lap:mov32 lap:lea64 lap:cmp64)))
                 (retained::step-command stop lease actual (+ pc (dis:inst-size instruction))))))
           (let ((id (getf (d:debugger-stop-information stop) :next-command-id)))
             (d:submit-debugger-command lease id :proceed)
             (assert (eq (getf (test::completed-command stop id) :state) :unwound)))
           (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))
           (assert (= (aref state 3) 1))
           (assert (= (length (aref state 6)) value-count))
           (assert (equal (aref state 6) (aref state 2)))
           t)
      (when point (s::clear-instruction-breakpoint point))
      (dolist (point public) (s::clear-instruction-breakpoint point))
      (when thread
        (loop for handle =
                  (find thread (d:debugger-stops :include-closed t)
                        :key (lambda (handle)
                               (d::service-stop-thread (d::service-handle-stop handle))))
              while handle
              do (lispm-frame-evaluation-test::release-test-stop handle controller))
        (unless (nth-value 1 (s:thread-join thread nil))
          (s:terminate-thread thread)
          (test::await (lambda () (nth-value 1 (s:thread-join thread nil))))))
      (d:close-debugger-controller controller))))

(defun guard-cases ()
  (let ((hook s::*instruction-step-nlx-hook*)
        (calls 0) (point nil))
    (unwind-protect
         (progn
           (setf point (s::install-callback-instruction-step-breakpoint
                        #'call-site 16 (s:current-thread) 0 #'identity nil)
                 s::*instruction-step-nlx-hook*
                 (lambda (point frame)
                   (declare (ignore point))
                   (assert (eq (nth-value 0
                                 (i::return-address-to-function
                                  (i::memref-unsigned-byte-64 frame 1)))
                               #'guard-cases))
                   (incf calls)))
           (i::%%debugger-nlx-entry)
           (assert (= calls 1))
           (helper-without-interrupts)
           (s:without-footholds (i::%%debugger-nlx-entry))
           (s:with-pseudo-atomic (i::%%debugger-nlx-entry))
           (s:with-world-stopped (i::%%debugger-nlx-entry))
           (assert (= calls 1))
           (setf s::*instruction-step-nlx-hook* nil)
           (i::%%debugger-nlx-entry)
           (assert (= calls 1))
           t)
      (setf s::*instruction-step-nlx-hook* hook)
      (when point (s::clear-instruction-breakpoint point)))))

(defun run ()
  (assert (guard-cases))
  (dolist (depth '(0 2))
    (dolist (mode '(:return :go :throw :internal))
      (dolist (count '(0 1 3 8))
        (format t "~&Testing ~S with ~D prompts and ~D values.~%" mode depth count)
        (assert (run-case mode depth t count)))))
  (dolist (mode '(:return :throw))
    (assert (run-case mode 2 t 8 t (eq mode :throw))))
  (format t "~&PASS escaping and internal nonlocal steps, values, GC and replay.~%")
  t)
