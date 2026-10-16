;;;; The debugger and other debugging support

(in-package :mezzano.internals)

(declaim (special *debug-io*
                  *standard-input*
                  *standard-output*))

(defun debug-info-name (info)
  (second info))

(defun debug-info-local-variable-locations (info)
  "Returns a list of (NAME STACK-SLOT) for each local variable."
  (third info))

(defun debug-info-closure-layout (info)
  "Returns two values, the stack slot of the closure vector and the layout of the vector.
Returns NIL if the function captures no variables."
  (if (integerp (fourth info))
      (values (fourth info) (fifth info))
      nil))

(defun debug-binding-p (object)
  (and (typep object 'simple-vector)
       (= (length object) 2)
       (eq (aref object 0) :binding)))

(defun debug-control-binding-p (object)
  (and (typep object 'simple-vector)
       (= (length object) 2)
       (member (aref object 0) '(:block :tagbody))
       (debug-binding-p (aref object 1))))

(defun closure-control-bindings (function)
  (when (closure-p function)
    (let ((environment (%closure-value function 0)))
      (loop for level in (fifth (function-debug-info function))
            append (loop for entry in level
                         for index from 1
                         when (debug-control-binding-p entry)
                           collect (list (aref entry 0) (aref entry 1)
                                         (svref environment index)))
            do (setf environment (svref environment 0))))))

(defun control-context-destination (context)
  (declare (ignorable context))
  #+x86-64
  (mezzano.supervisor:with-pseudo-atomic
    (let* ((address (lisp-object-address context))
           (table (memref-unsigned-byte-64 address))
           (destination (+ table (memref-signed-byte-64 table))))
      (multiple-value-bind (function offset) (return-address-to-function destination)
        (values function offset t))))
  #-x86-64
  (values nil nil nil))

(defun debug-binding-name (object)
  (if (debug-binding-p object) (aref object 1) object))

(defun debug-info-precise-closure-layout (info)
  "Return the closure pointer's binding or legacy name and the vector layout."
  (if (or (symbolp (fourth info)) (debug-binding-p (fourth info)))
      (values (fourth info) (fifth info))
      nil))

(defun debug-info-source-pathname (info)
  (sixth info))

(defun debug-info-source-top-level-form-number (info)
  (seventh info))

(defun debug-info-lambda-list (info)
  (eighth info))

(defun debug-info-docstring (info)
  (ninth info))

(defun (setf debug-info-docstring) (new-value info)
  (setf (ninth info) new-value))

(defun debug-info-precise-variable-data (info)
  (tenth info))

(defun debug-info-source-scopes (info)
  (nth 10 info))

(defun debug-info-instruction-starts (info)
  (nth 14 info))

(defun source-scope-at-offset (function offset)
  (loop with scope = :unknown
        for (address . current) in (debug-info-source-scopes (function-debug-info function))
        when (> address offset) return scope
        do (setf scope current)
        finally (return scope)))

(defparameter *debugger-depth* 0)
(defvar *debugger-condition* nil)
(defvar *current-debug-frame* nil)

(defvar *default-frames-to-print* 15)

(defun frame-code-address (frame)
  (if (fifth frame)
      (memref-unsigned-byte-64 (fifth frame))
      (memref-unsigned-byte-64 (second frame) 1)))

(defun frame-stack-available-p (frame)
  (or (null (fifth frame))
      (multiple-value-bind (function offset)
          (return-address-to-function (frame-code-address frame))
        (nth-value 0 (gc-info-for-function-offset function offset)))))

(defun special-stack-head-at-boundary (boundary)
  (let ((stack (mezzano.supervisor::thread-stack (mezzano.supervisor:current-thread)))
        (on-selected nil))
    (labels ((contains-boundary-p ()
               (<= (mezzano.supervisor::stack-base stack) boundary
                   (1- (+ (mezzano.supervisor::stack-base stack)
                          (mezzano.supervisor::stack-size stack))))))
      (setf on-selected (contains-boundary-p))
      (loop for cell = (%%special-stack-pointer) then (%object-ref-t cell 0)
            while cell
            do (when (and on-selected
                          (> (- (lisp-object-address cell) +tag-object+) boundary))
                 (return (values cell t)))
               (when (mezzano.delimited-continuations:prompt-tag-p (%object-ref-t cell 1))
                 (when on-selected (return (values cell t)))
                 (setf stack (%object-ref-t cell 3)
                       on-selected (contains-boundary-p)))
            finally (return (values nil on-selected))))))

(defun frame-return-context (frame)
  (check-type frame frame)
  #+x86-64
  (block context
    (let ((interrupted nil))
      (map-backtrace
       (lambda (current)
         (when (frame-interrupted-p current) (setf interrupted t))
         (when (and (= (frame-fp current) (frame-fp frame))
                    (eql (frame-pc-slot current) (frame-pc-slot frame)))
           (when interrupted
             (return-from context (values nil nil :interrupt-boundary)))
           (unless (frame-stack-available-p (frame-raw-data current))
             (return-from context (values nil nil :frameless-frame)))
           (multiple-value-bind (function offset) (function-from-frame (frame-raw-data current))
             (let ((scope (source-scope-at-offset function offset)))
               (when (member scope '(nil :unknown))
                 (return-from context (values nil nil :unavailable-source-scope)))))
           (let ((fp (memref-unsigned-byte-64 (frame-fp current))))
             (multiple-value-bind (head available) (special-stack-head-at-boundary fp)
               (unless (and available (zerop (mod fp 16))
                            (not (zerop (memref-unsigned-byte-64 fp 1))))
                 (return-from context (values nil nil :unavailable-return-address)))
               (return-from context (values fp head nil))))))))
    (values nil nil :inactive-frame))
  #-x86-64
  (values nil nil :unsupported-architecture))

#+x86-64
(define-lap-function %return-values-from-frame ((frame-pointer values stack))
  (:gc :no-frame :layout #*0)
  (sys.lap-x86:push :rbp)
  (:gc :no-frame :layout #*00)
  (sys.lap-x86:mov64 :rbp :rsp)
  (:gc :frame)
  (sys.lap-x86:sub64 :rsp 16)
  (sys.lap-x86:mov64 (:stack 0) :r8)
  (:gc :frame :layout #*1)
  (sys.lap-x86:mov64 (:stack 1) :r10)
  (:gc :frame :layout #*11)
  (sys.lap-x86:mov64 :r8 :r9)
  (sys.lap-x86:mov32 :ecx #.(ash 1 +n-fixnum-bits+))
  (sys.lap-x86:call (:named-call values-list))
  (:gc :frame :layout #*11 :multiple-values 0)
  ;; Keep the detached prompt stack alive through LEAVE.
  (sys.lap-x86:mov64 :r13 (:stack 1))
  (sys.lap-x86:mov64 :rax (:stack 0))
  (sys.lap-x86:sar64 :rax #.+n-fixnum-bits+)
  (sys.lap-x86:mov64 :rbp :rax)
  (:gc :frame :multiple-values 0)
  (sys.lap-x86:leave)
  (:gc :no-frame :layout #*0 :multiple-values 0)
  (sys.lap-x86:ret))

(defun return-from-frame (frame values)
  (declare (suppress-ssp-checking))
  (let ((count (list-length values)))
    (unless (and count (<= count multiple-values-limit))
      (error "Frame return requires a finite list of at most ~D values."
             multiple-values-limit)))
  (multiple-value-bind (fp head reason) (frame-return-context frame)
    (declare (ignorable fp head))
    (when reason (error "Cannot return from frame: ~S." reason))
    #+x86-64
    (let ((stack (mezzano.supervisor::thread-stack (mezzano.supervisor:current-thread))))
      (%%unwind-to head)
      (%return-values-from-frame fp values stack))))

#+x86-64
(define-lap-function %reinvoke-frame ((frame-pointer function arguments stack))
  (:gc :no-frame :layout #*0 :incoming-arguments :rcx)
  (sys.lap-x86:mov64 :rax :r8)
  (sys.lap-x86:sar64 :rax #.+n-fixnum-bits+)
  (sys.lap-x86:mov64 :rbp :rax)
  (:gc :frame :incoming-arguments :rcx)
  (sys.lap-x86:mov64 :rsp :rbp)
  (sys.lap-x86:sub64 :rsp 32)
  (sys.lap-x86:mov64 (:stack 0) :r9)
  (sys.lap-x86:mov64 (:stack 1) :r10)
  (sys.lap-x86:mov64 (:stack 2) :r11)
  (:gc :frame :layout #*111)
  (sys.lap-x86:mov64 :r8 (:stack 0))
  (sys.lap-x86:mov64 :r9 (:stack 1))
  (sys.lap-x86:mov32 :ecx #.(ash 2 +n-fixnum-bits+))
  (sys.lap-x86:call (:named-call apply))
  (:gc :frame :layout #*111 :multiple-values 0)
  (sys.lap-x86:leave)
  (:gc :no-frame :layout #*0 :multiple-values 0)
  (sys.lap-x86:ret))

(defun reinvoke-frame (frame function arguments)
  (declare (suppress-ssp-checking))
  (check-type function function)
  (let ((count (list-length arguments)))
    (unless (and count (< count call-arguments-limit))
      (error "Frame reinvocation requires a finite argument list shorter than ~D."
             call-arguments-limit)))
  (multiple-value-bind (fp head reason) (frame-return-context frame)
    (declare (ignorable fp head))
    (when reason (error "Cannot reinvoke frame: ~S." reason))
    #+x86-64
    (let ((arguments (copy-list arguments))
          (stack (mezzano.supervisor::thread-stack (mezzano.supervisor:current-thread))))
      (%%unwind-to head)
      (%reinvoke-frame fp function arguments stack))))

(defun frame-entry-context (frame)
  (let ((reason (nth-value 2 (frame-return-context frame))))
    (when reason (return-from frame-entry-context (values nil nil reason))))
  (let* ((raw (frame-raw-data frame))
         (function (nth-value 1 (frame-function frame)))
         (record (nth 11 (function-debug-info function))))
    (unless record
      (return-from frame-entry-context (values nil nil :unavailable-entry-data)))
    (check-type record (simple-vector 3))
    (unless (and (eq (svref record 0) :entry-arguments)
                 (debug-binding-p (svref record 1))
                 (or (null (svref record 2)) (debug-binding-p (svref record 2))))
      (error "Invalid function entry debug metadata."))
    (let ((locals (frame-locals raw :show-hidden t)))
      (flet ((read-binding (binding)
               (let ((local (find binding locals :key #'fifth :test #'eq)))
                 (if local
                     (read-frame-slot raw (third local) (fourth local))
                     (values nil nil)))))
        (multiple-value-bind (arguments available) (read-binding (svref record 1))
          (unless available
            (return-from frame-entry-context
              (values nil nil :unavailable-original-arguments)))
          (multiple-value-bind (callable callable-available)
              (if (svref record 2)
                  (read-binding (svref record 2))
                  (values function t))
            (unless callable-available
              (return-from frame-entry-context
                (values nil nil :unavailable-entry-callable)))
            (check-type callable function)
            (let ((count (list-length arguments)))
              (unless (and count (< count call-arguments-limit))
                (error "Invalid saved entry argument list.")))
            (values (copy-list arguments) callable nil)))))))

(defun reinvoke-callable (function)
  (check-type function function)
  (let ((record (nth 13 (function-debug-info function))))
    (unless record
      (return-from reinvoke-callable
        (values nil nil :unavailable-callable-provenance)))
    (when (eq record :exact-callable)
      (return-from reinvoke-callable (values function record nil)))
    (check-type record (simple-vector 2))
    (unless (and (eq (svref record 0) :global-function)
                 (valid-function-name-p (svref record 1)))
      (error "Invalid global function debug metadata."))
    (let* ((name (svref record 1))
           (reference (function-reference name nil))
           (current (when reference (function-reference-function reference))))
      (when (or (null current) (and (symbolp name) (macro-function name)))
        (error 'undefined-function :name name))
      (check-type current function)
      (values current record nil))))

(defun function-from-frame (frame)
  (let ((return-address (- (frame-code-address frame)
                           (if (sixth frame) 0 1))))
    (multiple-value-bind (fn offset)
        (return-address-to-function return-address)
      (values fn offset))))

(defun decode-debug-register (reg)
  #+x86-64
  (elt *debug-x86-64-register-encodings* reg)
  #+arm64
  (elt *debug-arm64-register-encodings* reg))

(defun decode-precise-debug-info (function encoded-info)
  (let ((result '())
        (index 0))
    (labels ((consume ()
               (prog1
                   (let ((value (aref encoded-info index)))
                     value)
                 (incf index)))
             (read-vu32 ()
               (let ((shift 0)
                     (result 0))
                 (loop
                    (let ((b (consume)))
                      (setf result (logior result (ash (logand b #x7F) shift)))
                    (when (not (logtest b #x80))
                      (return))
                    (incf shift 7)))
                 result))
             (read-location ()
               (let* ((loc (consume))
                      (real-loc (cond ((eql loc #xFF)
                                       (read-vu32))
                                      ((logtest loc #x80)
                                       (logand loc #x7F))
                                      (t
                                       (decode-debug-register loc))))
                      (repr (read-vu32))
                      (real-repr (ecase repr
                                   (#.+debug-repr-value+ :value)
                                   (#.+debug-repr-short-float+ 'short-float)
                                   (#.+debug-repr-single-float+ 'single-float)
                                   (#.+debug-repr-double-float+ 'double-float)
                                   (#.+debug-repr-mmx-vector+ 'mezzano.simd.x86-64:mmx-vector)
                                   (#.+debug-repr-sse-vector+ 'mezzano.simd.x86-64:sse-vector)
                                   (#.+debug-repr-fixnum+ 'fixnum)
                                   (#.+debug-repr-unsigned-byte-64+ :unsigned-byte-64)
                                   (#.+debug-repr-signed-byte-64+ :signed-byte-64))))
                 (values real-loc real-repr))))
      (loop
         (when (>= index (length encoded-info))
           (return))
         (let ((offset (read-vu32))
               (compressed-layout '()))
           (loop
              (let ((op (consume)))
                (ecase (logand op #xF0)
                  (#.+debug-end-entry-op+
                   (return))
                  (#.+debug-add-var-op+
                   (let ((var (function-pool-object function (read-vu32)))
                         (hiddenp (eql op +debug-add-hidden-var-op+)))
                     (multiple-value-bind (location repr)
                         (read-location)
                       (push `(:add ,(debug-binding-name var) ,location ,repr
                                    :hidden ,hiddenp
                                    :binding ,(when (debug-binding-p var) var))
                             compressed-layout))))
                  (#.+debug-drop-n-op+
                   (push `(:drop ,(logand op #x0F)) compressed-layout))
                  (#.+debug-drop-op+
                   (push `(:drop ,(read-vu32)) compressed-layout))
                  ((#.+debug-update-n-op+ #.+debug-update-op+)
                   (let ((var (if (eql op +debug-update-op+)
                                  (read-vu32)
                                  (logand op #x0F))))
                     (multiple-value-bind (location repr)
                         (read-location)
                       (push `(:update ,var ,location ,repr) compressed-layout)))))))
           (push `(,offset :compressed-layout ,(reverse compressed-layout)) result)))
      (reverse result))))

(defun decompress-debug-layout (prev-layout ops)
  (let ((current (copy-list prev-layout)))
    (dolist (op ops)
      (ecase (first op)
        (:add
         (setf current (append current
                               (list (rest op)))))
        (:drop
         (destructuring-bind (n) (rest op)
           (setf current (subseq current 0 n))))
        (:update
         (destructuring-bind (index loc repr) (rest op)
           (let ((existing (nth index current)))
             (setf (nth index current) (list* (first existing)
                                              loc repr
                                              (cdddr existing))))))))
    current))

(defun decompress-precise-debug-info (info)
  (loop
     with last-layout = ()
     for entry in info
     collect (destructuring-bind (offset &key compressed-layout)
                 entry
               (let ((new-layout (decompress-debug-layout last-layout compressed-layout)))
                 (setf last-layout new-layout)
                 `(,offset :layout ,new-layout)))))

(defun read-frame-slot (frame slot &optional (repr :value))
  (typecase slot
    (integer
     (unless (frame-stack-available-p frame)
       (return-from read-frame-slot (values nil nil)))
     (let ((address (+ (memref-unsigned-byte-64 (second frame) 0)
                       (* (- (1+ slot)) 8))))
       (values
        (case repr
          ((:value fixnum)
           (memref-t address))
          (:unsigned-byte-64
           (memref-unsigned-byte-64 address))
          (:signed-byte-64
           (memref-signed-byte-64 address))
          (short-float
           (%integer-as-short-float (memref-unsigned-byte-16 address)))
          (single-float
           (%integer-as-single-float (memref-unsigned-byte-32 address)))
          (double-float
           (%integer-as-double-float (memref-unsigned-byte-64 address)))
          (t
           (return-from read-frame-slot (values nil nil))))
        t)))
    ((cons (eql quote))
     (values (second slot) t))
    (cons
     (if (eq repr :value)
         (multiple-value-bind (value available-p)
             (read-frame-slot frame (first slot))
           (unless available-p
             (return-from read-frame-slot (values nil nil)))
           (dolist (index (rest slot))
             (setf value (elt value index)))
           (values value t))
         (values nil nil)))
    (t
     (let ((cell (assoc slot (fourth frame))))
       (values (cdr cell) (not (null cell)))))))

(defun write-frame-slot (frame slot value &optional (repr :value))
  (typecase slot
    (integer
     (unless (frame-stack-available-p frame)
       (error "This activation has no established stack frame."))
     (let ((type (case repr
                   (:value t)
                   (:unsigned-byte-64 '(unsigned-byte 64))
                   (:signed-byte-64 '(signed-byte 64))
                   ((fixnum short-float single-float double-float) repr)
                   (otherwise
                    (error "Cannot write to this variable. Unknown representation ~S." repr)))))
       (unless (typep value type)
         (error 'type-error :datum value :expected-type type)))
     (let ((address (+ (memref-unsigned-byte-64 (second frame) 0)
                       (* (- (1+ slot)) 8))))
       (case repr
         ((:value fixnum)
          (setf (memref-t address) value))
         (:unsigned-byte-64
          (setf (memref-unsigned-byte-64 address) value))
         (:signed-byte-64
          (setf (memref-signed-byte-64 address) value))
         (short-float
          (setf (memref-unsigned-byte-16 address) (%short-float-as-integer value)))
         (single-float
          (setf (memref-unsigned-byte-32 address) (%single-float-as-integer value)))
         (double-float
          (setf (memref-unsigned-byte-64 address) (%double-float-as-integer value)))
         (t
          (error "Cannot write to this variable. Unknown representation ~S." repr)))))
    ((cons (eql quote))
     (error "Cannot write to this variable. Is constant."))
    (cons
     ;; Environment vector path.
     ;; Looks like: (environment-slot [parent-indices...] value-index)
     (case repr
       (:value
        (multiple-value-bind (vec available-p)
            (read-frame-slot frame (first slot))
          (unless available-p
            (error "The closure environment is unavailable."))
          (loop for (index . tail) on (rest slot)
                if tail do (setf vec (elt vec index))
                else do (setf (elt vec index) value))
          value))
       (t
        (error "Cannot write to this variable. Unsupported representation ~S for environment access" repr))))
    (t
     ;; A register?
     (error "Cannot write to this variable. Unsupported location ~S" slot))))

(defun show-debug-frame ()
  (multiple-value-bind (function offset)
      (function-from-frame *current-debug-frame*)
    (format t "Frame ~D(~X): ~S + ~D~%"
            (first *current-debug-frame*)
            (second *current-debug-frame*)
            function offset)))

(defun local-variables-at-offset (function offset)
  (let ((data (decompress-precise-debug-info
               (decode-precise-debug-info
                function
                (debug-info-precise-variable-data
                 (function-debug-info function))))))
    (when (null data)
      ;; Precise information not present. Fall back on the stack map.
      (return-from local-variables-at-offset
        (loop
           for (name stack-slot) in (debug-info-local-variable-locations
                                     (function-debug-info function))
           collect (list name stack-slot :value))))
    (loop
       with last-layout = '()
       for entry in data
       do (destructuring-bind (entry-offset &key layout &allow-other-keys)
              entry
            (when (> entry-offset offset)
              (return last-layout))
            (setf last-layout layout))
       finally (return last-layout))))

(defun frame-locals (frame &key show-hidden)
  (multiple-value-bind (fn offset)
      (function-from-frame frame)
    (when (function-reference-p fn)
      (let ((real-fn (function-reference-function fn)))
        (when (not real-fn)
          (return-from frame-locals '()))
        (setf fn real-fn
              offset 0)))
    (let* ((info (function-debug-info fn))
           (var-id -1)
           (result '())
           (locals (local-variables-at-offset fn offset)))
      (loop
         for (name location repr . plist) in locals
         do (destructuring-bind (&key hidden binding)
                plist
              (when (or show-hidden (not hidden))
                (push (list name (incf var-id) location repr binding) result))))
      (multiple-value-bind (env-slot env-layout)
          (sys.int::debug-info-closure-layout info)
        (when env-slot
          (let ((base-path (list env-slot)))
            (dolist (level env-layout)
              (loop
                 for i from 1
                 for name in level
                 when (and name (not (debug-control-binding-p name)))
                 do (push (list (debug-binding-name name) (incf var-id)
                                (reverse (list* i base-path)) :value
                                (when (debug-binding-p name) name))
                          result))
              (push 0 base-path)))))
      (multiple-value-bind (env-var env-layout)
          (sys.int::debug-info-precise-closure-layout info)
        (when env-var
          (let ((env-slot
                  (second (find env-var locals
                                :key (lambda (entry)
                                       (or (getf (cdddr entry) :binding)
                                           (first entry)))))))
            (when env-slot
              (let ((base-path (list env-slot)))
                (dolist (level env-layout)
                  (loop
                     for i from 1
                     for name in level
                     when (and name (not (debug-control-binding-p name)))
                     do (push (list (debug-binding-name name) (incf var-id)
                                    (reverse (list* i base-path)) :value
                                    (when (debug-binding-p name) name))
                              result))
                  (push 0 base-path)))))))
      (reverse result))))

(defun debugger-show-variables (frame)
  (loop
     for (name id location repr) in (frame-locals frame)
     do (multiple-value-bind (value available-p)
            (read-frame-slot frame location repr)
          (format t "  ~D ~S: " id name)
          (if available-p
              (format t "~S~%" value)
              (format t "[unavailable]~%")))))

(defun debugger-read-variable (frame id)
  (let ((info (find id (frame-locals frame) :key #'second)))
    (cond (info
           (destructuring-bind (name id location repr &optional binding)
               info
             (declare (ignore id binding))
             (multiple-value-bind (value available-p)
                 (read-frame-slot frame location repr)
               (unless available-p
                 (error "Variable ~S is unavailable." name))
               (values value name))))
          (t
           (format t "Unknown variable id ~S." id)))))

(defun debugger-write-variable (frame id value)
  (let ((info (find id (frame-locals frame) :key #'second)))
    (cond (info
           (destructuring-bind (name id location repr &optional binding)
               info
             (declare (ignore id binding))
             (write-frame-slot frame location value repr)
             name))
          (t
           (format t "Unknown variable id ~S." id)))))

(defun debugger-main (&optional condition)
  (with-standard-io-syntax
    (let* ((mezzano.fast-eval:*lazy-lambda-evaluation* nil)
           (*print-readably* nil)
           (*standard-input* *debug-io*)
           (*standard-output* *debug-io*)
           (debug-level *debugger-depth*)
           (*debugger-depth* (1+ *debugger-depth*))
           (restarts (compute-restarts condition))
           (restart-count (length restarts))
           (*debugger-condition* condition)
           (frames nil)
           (n-frames 0)
           (*current-debug-frame*))
      (let ((prev-fp nil))
        (map-backtrace
         (lambda (frame)
           (incf n-frames)
           (let ((raw (frame-raw-data frame)))
             (setf (first raw) (1- (frame-depth frame))
                   (third raw) prev-fp)
             (push raw frames))
           (setf prev-fp (frame-fp frame)))))
      (setf frames (nreverse frames))
      ;; Can't deal with the top-most frame.
      (decf n-frames)
      (pop frames)
      ;; Remove a few more frames that're done.
      (setf *current-debug-frame* (first frames))
      (fresh-line)
      (write condition :escape nil :readably nil)
      (fresh-line)
      (show-restarts restarts)
      (fresh-line)
      (backtrace :limit *default-frames-to-print*)
      (fresh-line)
      (write-line "Enter a restart number or evaluate a form. :help for help.")
      (clear-input)
      (loop
         (let ((* nil) (** nil) (*** nil)
               (/ nil) (// nil) (/// nil)
               (+ nil) (++ nil) (+++ nil)
               (- nil))
           (loop
              (with-simple-restart (abort "Return to debugger top level.")
                (fresh-line)
                (format t "~A/~D] " (package-shortest-name *package*) debug-level)
                (finish-output)
                (let ((form (read)))
                  (fresh-line)
                  (typecase form
                    (integer
                     (if (and (>= form 0) (< form restart-count))
                         (invoke-restart-interactively (nth (- restart-count form 1) restarts))
                         (format t "Restart number ~D out of bounds.~%" form)))
                    (keyword
                     (case form
                       (:help
                        (format t "~&You are in the debugger. Commiserations!~%")
                        (format t "Commands:~%")
                        (format t "  :help      This help message.~%")
                        (format t "  :restarts  Display available restarts.~%")
                        (format t "  :up        Move to a higher (inner) frame.~%")
                        (format t "  :down      Move to a lower (outer) frame.~%")
                        (format t "  :bottom    Move to the lowest (outermost) fra\me.~%")
                        (format t "  :top       Move to the highest (innermost) frame.~%")
                        (format t "  :current   Print the current frame.~%")
                        (format t "  :vars      Display variables in the current frame.~%")
                        (format t "             Beware, *print-line* and *print-level* don't work yet.~%")
                        (format t "  :read      Read a variable by id (from :vars) from the current frame.~%")
                        (format t "  :write     Write a variable by id (from :vars) to the current frame.~%")
                        (format t "  :bt        Print a complete backtrace.~%")
                        (format t "  :condition Condition that caused the debugger to be invoked.~%")
                        (format t "  :terminate Terminate the current thread.~%")
                        (format t "Integers are treated at restart IDs.~%")
                        (format t "Good luck.~%"))
                       (:restarts
                        (fresh-line)
                        (show-restarts restarts))
                       (:up
                        (if (>= (first *current-debug-frame*) n-frames)
                            (format t "At innermost frame!~%")
                            (setf *current-debug-frame* (nth (1+ (first *current-debug-frame*)) frames)))
                        (show-debug-frame))
                       (:down
                        (if (zerop (first *current-debug-frame*))
                            (format t "At outermost frame!~%")
                            (setf *current-debug-frame* (nth (1- (first *current-debug-frame*)) frames)))
                        (show-debug-frame))
                       (:bottom
                        (setf *current-debug-frame* (first frames))
                        (show-debug-frame))
                       (:top
                        (setf *current-debug-frame* (first (last frames)))
                        (show-debug-frame))
                       (:current
                        (show-debug-frame))
                       (:vars
                        (show-debug-frame)
                        (debugger-show-variables *current-debug-frame*))
                       (:read
                        (format t "~&ID: ")
                        (finish-output)
                        (let ((result (multiple-value-list (debugger-read-variable *current-debug-frame* (read)))))
                          (setf *** **
                                ** *
                                * (first result)
                                /// //
                                // /
                                / result
                                +++ ++
                                ++ +
                                + form)
                          (when result
                            (dolist (v result)
                              (fresh-line)
                              (write v)))))
                       (:write
                        (let (slot value)
                          (format t "~&ID: ")
                          (finish-output)
                          (setf slot (read))
                          (format t "~&Value: ")
                          (finish-output)
                          (setf value (eval (read)))
                          (debugger-write-variable *current-debug-frame* slot value)))
                       (:bt
                        (backtrace))
                       (:condition
                        (let ((result (multiple-value-list *debugger-condition*)))
                          (setf *** **
                                ** *
                                * (first result)
                                /// //
                                // /
                                / result
                                +++ ++
                                ++ +
                                + form)
                          (when result
                            (dolist (v result)
                              (fresh-line)
                              (write v)))))
                       (:terminate
                        (throw 'mezzano.supervisor:terminate-thread nil))
                       (t (format t "Unknown command ~S~%" form))))
                    (t (let ((result (multiple-value-list (let ((- form))
                                                            (eval form)))))
                         (setf *** **
                               ** *
                               * (first result)
                               /// //
                               // /
                               / result
                               +++ ++
                               ++ +
                               + form)
                         (when result
                           (dolist (v result)
                             (fresh-line)
                             (write v))))))))))))))

(defparameter *global-debugger* nil)

(defun enter-debugger (condition)
  (funcall (or *global-debugger*
               'debugger-main)
           condition))

(defun show-restarts (restarts)
  (let ((restart-count (length restarts)))
    (format t "Available restarts:~%")
    (loop
       for i from 0
       for restart in restarts
       do (format t "~S ~S: ~A~%" (- restart-count i 1) (restart-name restart) restart))))

(defun platform-callee-save-regs ()
  #+arm64
  (list (cons :x13 nil) (cons :x14 nil))
  #-arm64
  nil)

(defun update-callee-save-regs (regs fp)
  (let ((new-fp (memref-unsigned-byte-64 fp 0))
        (ra (memref-unsigned-byte-64 fp 1)))
    (when (or (zerop new-fp)
              (zerop ra))
      (return-from update-callee-save-regs
        regs))
    (let* ((function (return-address-to-function ra))
           (debug-info (decompress-precise-debug-info
                        (decode-precise-debug-info
                         function
                         (debug-info-precise-variable-data
                          (function-debug-info function)))))
           (entry (first debug-info))
           (layout (cdr (getf (cdr entry) :layout)))
           (frame (list nil fp)))
      (setf regs
            (loop for pair in regs
                  for location = (assoc (car pair) layout)
                  when (or (null location)
                           (multiple-value-bind (value available-p)
                               (read-frame-slot frame (second location) (third location))
                             (when available-p (setf (cdr pair) value))
                             available-p))
                    collect pair))))
  regs)

(defun safe-return-address-to-function (address)
  (assert (within-function-area-p address))
  (return-address-to-function address))

(defun backtrace-next-frame (thread stack-pointer frame-pointer return-address)
  "Return the caller's SP, FP, PC, saved-PC slot, frame link, and interrupted-PC flag.
The frame link is NIL when this transition leaves FP unchanged."
  (declare (ignore thread))
  (multiple-value-bind (fn fn-offset)
      (safe-return-address-to-function return-address)
    (multiple-value-bind (framep interruptp pushed-values pushed-values-register
                          layout-address layout-length
                          multiple-values incoming-arguments
                          block-or-tagbody-thunk extra-registers
                          entry-offset restart)
        (gc-info-for-function-offset fn fn-offset)
      (cond (interruptp
             (when (not framep)
               (error "Frameless interrupt frames not implemented" framep interruptp pushed-values pushed-values-register
                      layout-address layout-length
                      multiple-values incoming-arguments
                      block-or-tagbody-thunk extra-registers
                      entry-offset restart))
             (values
              ;; Stack pointer is past the frame pointer & additional saved state.
              (memref-unsigned-byte-64 frame-pointer 4)
              (memref-unsigned-byte-64 frame-pointer 0)
              (memref-unsigned-byte-64 frame-pointer 1)
              (+ frame-pointer 8) frame-pointer t))
            (framep
             (values
              ;; Stack pointer is past the frame pointer & saved return address.
              (+ frame-pointer 16)
              (memref-unsigned-byte-64 frame-pointer 0)
              (memref-unsigned-byte-64 frame-pointer 1)
              (+ frame-pointer 8) frame-pointer nil))
            (t
             (values
              ;; In a no-frame function the stack layout is directly
              ;; represented by the layout field. Layout size = number of
              ;; elements on the stack, including the return address.
              (+ stack-pointer (* layout-length 8))
              ;; Frame pointer is unchanged.
              frame-pointer
              ;; Return address should be the first entry on the stack.
              (memref-unsigned-byte-64 stack-pointer (1- layout-length))
              (+ stack-pointer (* (1- layout-length) 8)) nil nil))))))

(defun %map-backtrace (fn)
  (do* ((i 0 (1+ i))
        (callee-save-regs
         (platform-callee-save-regs)
         (update-callee-save-regs callee-save-regs fp))
        (fp (read-frame-pointer)
            (memref-unsigned-byte-64 fp 0)))
      ;; Stop when return address or frame pointer is zero.
      ((or (= fp 0)
           (eql (memref-signed-byte-64 fp 1) 0)))
    (funcall fn i fp (loop for (x . y) in callee-save-regs collect (cons x y)))))

(defstruct frame
  (depth 0 :read-only t)
  (fp 0 :read-only t)
  (callee-save-regs '() :read-only t)
  (pc-slot nil :read-only t)
  (interrupted-p nil :read-only t))

(defun frame-raw-data (frame)
  (list (frame-depth frame) (frame-fp frame) nil
        (frame-callee-save-regs frame)
        (frame-pc-slot frame) (frame-interrupted-p frame)))

(defstruct local-variable
  (name nil :read-only t)
  location
  representation)

(defun frame-local-variables (frame &key show-hidden)
  (loop
     for (name id location repr) in (frame-locals (frame-raw-data frame)
                                                  :show-hidden show-hidden)
     collect (make-local-variable :name name :location location :representation repr)))

(defun local-variable-value (frame local-variable)
  (read-frame-slot (frame-raw-data frame)
                   (local-variable-location local-variable)
                   (local-variable-representation local-variable)))

(defun frame-function (frame)
  "Return the function associated with frame.
Returns the function that was called, the actual function object being
executed, and the offset into it."
  (multiple-value-bind (actual-function offset)
      (function-from-frame (frame-raw-data frame))
    (when (function-reference-p actual-function)
      (return-from frame-function
        (values actual-function actual-function offset)))
    (let ((function actual-function)
          (name (function-name actual-function)))
      ;; Poke around in some CLOS discriminating functions to get
      ;; better names.
      (when (or (and (consp name)
                     (eql (first name) 'mezzano.clos::1-effective-discriminator))
                (equal name '(lambda :in mezzano.clos::std-compute-discriminating-function))
                (equal name '(lambda :in mezzano.clos::compute-1-effective-discriminator))
                (equal name '(lambda :in mezzano.clos::compute-n-effective-discriminator))
                (equal name '(lambda :in mezzano.clos::compute-reader-discriminator))
                (equal name '(lambda :in mezzano.clos::compute-writer-discriminator)))
        (loop
           for var in (frame-local-variables frame)
           when (eql (local-variable-name var) 'mezzano.clos::gf)
           do
             (multiple-value-bind (value available-p)
                 (local-variable-value frame var)
               (when available-p (setf function value)))
             (return)))
      (values function actual-function offset))))

(defun print-frame (frame &key (stream *debug-io*))
  (format stream "~S" (frame-function frame)))

(defgeneric function-source-location (function &key))

(defmethod function-source-location ((function compiled-function) &key (offset 0))
  (declare (ignore offset))
  (let* ((info (function-debug-info function))
         (pathname (mezzano.internals::debug-info-source-pathname info))
         (tlf (mezzano.internals::debug-info-source-top-level-form-number info)))
    (make-source-location :file pathname
                          :top-level-form-number tlf)))

(defmethod function-source-location ((function standard-generic-function) &key offset)
  (declare (ignore offset))
  (let ((location (slot-value function 'mezzano.clos::source-location)))
    (when location
      (function-source-location location))))

(defmethod function-source-location ((function function-reference) &key offset)
  (declare (ignore offset))
  (let ((fn (function-reference-function function)))
    (when fn
      (function-source-location fn))))

(defun map-backtrace (fn)
  #+x86-64
  (let* ((anchor (read-frame-pointer))
         (stack-pointer (+ anchor 16))
         (frame-pointer (memref-unsigned-byte-64 anchor))
         (pc-slot (+ anchor 8))
         (interrupted-p nil))
    (loop for depth from 0
          until (zerop (memref-unsigned-byte-64 pc-slot))
          do (funcall fn (make-frame :depth depth :fp anchor
                                     :pc-slot pc-slot :interrupted-p interrupted-p))
             (multiple-value-bind (next-sp next-fp next-pc next-slot link interruptp)
                 (backtrace-next-frame
                  (mezzano.supervisor:current-thread)
                  stack-pointer frame-pointer
                  (memref-unsigned-byte-64 pc-slot))
               (when (or (zerop next-fp) (zerop next-pc)) (return))
               (setf stack-pointer next-sp
                     frame-pointer next-fp
                     pc-slot next-slot
                     interrupted-p interruptp)
               (when link (setf anchor link)))))
  #-x86-64
  (%map-backtrace
   (lambda (depth fp callee-save-regs)
     (funcall fn (make-frame :depth depth :fp fp :callee-save-regs callee-save-regs)))))

(defun map-backtrace2 (fn)
  (%map-backtrace2
   (lambda (depth fp callee-save-regs)
     (funcall fn (make-frame :depth depth :fp fp :callee-save-regs callee-save-regs)))))

(defun backtrace (&key (stream *debug-io*) limit)
  "Print a backtrace on STREAM."
  (map-backtrace
   (lambda (frame)
     (when (and limit (> (frame-depth frame) limit))
       (return-from backtrace))
     (let* ((fn (frame-function frame))
            (name (or (if (functionp fn) (function-name fn)) fn)))
       (format stream "~&~X ~X ~S" (frame-fp frame)
               (frame-code-address (frame-raw-data frame)) name)))))

(defvar *traced-functions* '())
(defvar *trace-depth* 0)
(defvar *suppress-trace* nil)

;;; There is additional support in (setf function-reference-function) for trace wrappers.
(defclass trace-wrapper ()
  ((%name :initarg :name :reader trace-wrapper-name)
   (%original :initarg :original :accessor trace-wrapper-original)
   (%break-on-trace :initarg :break-on-trace :accessor trace-wrapper-break-on-trace))
  (:metaclass mezzano.clos:funcallable-standard-class)
  (:default-initargs :break-on-trace nil))

(defmethod print-object ((instance trace-wrapper) stream)
  (print-unreadable-object (instance stream :identity t)
    (format stream "Trace wrapper for ~A" (trace-wrapper-name instance))))

(defun trace-method-invocation (gf method function args)
  (if *suppress-trace*
      (apply function args)
      (let ((*suppress-trace* t))
        (let ((*print-readably* nil)
              (*print-length* 5)
              (*print-level* 5))
          (format *trace-output* "~D: Enter ~A ~A ~:S~%" *trace-depth* gf method args))
        (let ((result :error))
          (unwind-protect
               (handler-bind ((error (lambda (condition) (setf result condition))))
                 (setf result (multiple-value-list (let ((*trace-depth* (1+ *trace-depth*))
                                                         (*suppress-trace* nil))
                                                     (apply function args)))))
            (let ((*print-readably* nil)
                  (*print-length* 5)
                  (*print-level* 5))
              (format *trace-output* "~D: Leave ~A ~A ~:S~%" *trace-depth* gf method result)))
          (values-list result)))))

(defparameter *trace-print-length* 5)
(defparameter *trace-print-level* 5)

(defun trace-wrapper (name wrapper args)
  (let ((old-definition (trace-wrapper-original wrapper)))
    (if *suppress-trace*
        (apply old-definition args)
        (let ((*suppress-trace* t))
          (with-standard-io-syntax
            (let ((*print-readably* nil)
                  (*print-length* *trace-print-length*)
                  (*print-level* *trace-print-level*))
              (format *trace-output* "~D: Enter ~A ~:S~%" *trace-depth* name args)))
          (let ((bot-condition (trace-wrapper-break-on-trace wrapper)))
            (when (and bot-condition (eval bot-condition))
              (break "Trace break for ~S with args ~:S" old-definition args)))
          (let ((result :error))
            (unwind-protect
                 (handler-bind ((error (lambda (condition) (setf result condition))))
                   (setf result (multiple-value-list (let ((*trace-depth* (1+ *trace-depth*))
                                                           (*suppress-trace* nil))
                                                       (apply old-definition args)))))
              (with-standard-io-syntax
                (let ((*print-readably* nil)
                      (*print-length* *trace-print-length*)
                      (*print-level* *trace-print-level*))
                  (format *trace-output* "~D: Leave ~A ~:S~%" *trace-depth* name result))))
            (values-list result))))))

(defun trace-function (name &rest options)
  (when (fboundp name)
    (pushnew name *traced-functions* :test #'equal)
    (let* ((fref (function-reference name))
           (fn (function-reference-function fref)))
      (cond ((typep fn 'trace-wrapper)
             (apply #'reinitialize-instance fn options))
            (t
             (let ((wrapper (apply #'make-instance
                                   'trace-wrapper
                                   :name name
                                   :original fn
                                   options)))
               (mezzano.clos:set-funcallable-instance-function
                wrapper
                (lambda (&rest args)
                  (declare (dynamic-extent args)
                           (lambda-name trace-wrapper))
                  (trace-wrapper name wrapper args)))
               (setf (function-reference-function fref) wrapper)))))))

(defun %trace (&rest functions)
  (loop
     with break-on-trace = nil
     with methods = nil
     while functions
     for name = (pop functions)
     do
       (cond ((eql name :break)
              (setf break-on-trace (pop functions)))
             ((eql name :methods)
              (setf methods (pop functions)))
             (t
              (trace-function name :break-on-trace break-on-trace)
              (when (and methods
                         (fboundp name))
                (let ((f (fdefinition name)))
                  (when (typep f 'standard-generic-function)
                    (setf (mezzano.clos:generic-function-trace-p f) t)))))))
  *traced-functions*)

(defun untrace-function (name)
  (let* ((fref (function-reference name))
         (fn (function-reference-function fref)))
    (setf *traced-functions* (remove name *traced-functions* :test #'equal))
    (when (typep fn 'trace-wrapper)
      (let ((original (trace-wrapper-original fn)))
        (when (typep original 'standard-generic-function)
          (setf (mezzano.clos:generic-function-trace-p original) nil))
      ;; Directly set the fref to override the existing trace wrapper.
        (setf (function-reference-function fref) original)))))

(defun %untrace (&rest functions)
  (dolist (name (or functions
                    *traced-functions*))
    (untrace-function name)))

(defmacro trace (&rest functions)
  `(%trace ,@(mapcar (lambda (f) (list 'quote f)) functions)))

(defmacro untrace (&rest functions)
  `(%untrace ,@(loop for fn in functions collect `',fn)))

(defun find-all-frefs ()
  (remove-duplicates
   (coerce (get-all-objects
            #'function-reference-p)
          'list)))

(defun get-all-frefs-in-function (function)
  (when (funcallable-instance-p function)
    (setf function (funcallable-instance-function function)))
  (when (closure-p function)
    (setf function (%closure-function function)))
  (loop
     for i below (function-pool-size function)
     for entry = (function-pool-object function i)
     when (function-reference-p entry)
     collect entry
     when (compiled-function-p entry) ; closures
     append (get-all-frefs-in-function entry)))

(defun specializer-name (specializer)
  (if (typep specializer 'standard-class)
      (mezzano.clos:class-name specializer)
      specializer))

(defun list-callers (function-designator)
  (loop
     with fref-for-fn = (function-reference function-designator)
     with callers = '()
     for fref in (find-all-frefs)
     for fn = (function-reference-function fref)
     for name = (function-reference-name fref)
     when fn
     do
       (cond ((typep fn 'standard-generic-function)
              (dolist (m (mezzano.clos:generic-function-methods fn))
                  (let* ((mf (mezzano.clos:method-function m))
                         (mf-frefs (get-all-frefs-in-function mf)))
                    (when (member fref-for-fn mf-frefs)
                      (push `((defmethod ,name
                                  ,@(mezzano.clos:method-qualifiers m)
                                ,(mapcar #'specializer-name
                                         (mezzano.clos:method-specializers m)))
                              ,(function-source-location mf))
                            callers)))))
               ((member fref-for-fn
                        (get-all-frefs-in-function fn))
                (push `((defun ,name) ,(function-source-location fn)) callers)))
     finally (return callers)))

(defun list-callees (function-designator)
  (let* ((fn (fdefinition function-designator))
         ;; Grovel around in the function's constant pool looking for
         ;; function-references.  These may be for #', but they're
         ;; probably going to be for normal calls.
         ;; TODO: This doesn't work well on interpreted functions or
         ;; funcallable instances.
         (callees (remove-duplicates (get-all-frefs-in-function fn))))
    (loop
       for fref in callees
       for name = (function-reference-name fref)
       for fn = (function-reference-function fref)
       when fn
       collect `((defun ,name) ,(function-source-location fn)))))

(defgeneric function-lambda-list (function))

(defmethod function-lambda-list ((name (eql 'block)))
  '(name &body body))

(defmethod function-lambda-list ((name (eql 'catch)))
  '(tag &body body))

(defmethod function-lambda-list ((name (eql 'eval-when)))
  '(situations &body body))

(defmethod function-lambda-list ((name (eql 'flet)))
  '(definitions &body body))

(defmethod function-lambda-list ((name (eql 'function)))
  '(name))

(defmethod function-lambda-list ((name (eql 'go)))
  '(tag))

(defmethod function-lambda-list ((name (eql 'if)))
  '(test-form then-form &optional else-form))

(defmethod function-lambda-list ((name (eql 'labels)))
  '(definitions &body body))

(defmethod function-lambda-list ((name (eql 'let)))
  '(bindings &body body))

(defmethod function-lambda-list ((name (eql 'let*)))
  '(bindings &body body))

(defmethod function-lambda-list ((name (eql 'load-time-value)))
  '(form &optional read-only-p))

(defmethod function-lambda-list ((name (eql 'locally)))
  '(&body body))

(defmethod function-lambda-list ((name (eql 'macrolet)))
  '(definitions &body body))

(defmethod function-lambda-list ((name (eql 'multiple-value-call)))
  '(function-form &rest values-forms))

(defmethod function-lambda-list ((name (eql 'multiple-value-prog1)))
  '(values-form &rest forms))

(defmethod function-lambda-list ((name (eql 'progn)))
  '(&rest forms))

(defmethod function-lambda-list ((name (eql 'progv)))
  '(symbols values &body body))

(defmethod function-lambda-list ((name (eql 'quote)))
  '(value))

(defmethod function-lambda-list ((name (eql 'return-from)))
  '(name &optional result))

(defmethod function-lambda-list ((name (eql 'setq)))
  '(&rest pairs))

(defmethod function-lambda-list ((name (eql 'symbol-macrolet)))
  '(bindings &body body))

(defmethod function-lambda-list ((name (eql 'tagbody)))
  '(&rest statements))

(defmethod function-lambda-list ((name (eql 'the)))
  '(value-type form))

(defmethod function-lambda-list ((name (eql 'throw)))
  '(tag result-form))

(defmethod function-lambda-list ((name (eql 'unwind-protect)))
  '(protected-form &body cleanup-forms))

(defmethod function-lambda-list ((name symbol))
  (cond ((macro-function name)
         (mezzano.debug:macro-function-lambda-list name))
        (t
         (function-lambda-list (fdefinition name)))))

(defmethod function-lambda-list ((name list))
  (function-lambda-list (fdefinition name)))

(defmethod function-lambda-list ((function compiled-function))
  (debug-info-lambda-list
   (function-debug-info function)))

(defmethod function-lambda-list ((function mezzano.clos:generic-function))
  (mezzano.clos:generic-function-lambda-list function))

(defmacro step (form)
  `(let () nil ,form))
