(defpackage #:lispm-local-lowering-test
 (:use #:cl)
 (:local-nicknames (#:c #:mezzano.compiler) (#:ir #:mezzano.compiler.backend))
 (:export #:run))
(in-package #:lispm-local-lowering-test)
(declaim (optimize (safety 3) (debug 3) (speed 1)))

(defun definition (path name)
 (let ((*package* (find-package :mezzano.compiler.backend))
       (*read-eval* nil) (end (cons nil nil)))
  (with-open-file (in path)
   (loop for form = (read in nil end)
         do (when (eq form end) (error "Missing definition ~S in ~S." name path))
         when (and (consp form) (eq (first form) 'defun) (eq (second form) name))
         return form))))

(defun checked-compile (form)
 (let ((c::*optimize-policy* '(safety 3 debug 1 speed 1)))
  (multiple-value-bind (function warnings failure) (compile nil form)
   (assert (and function (not warnings) (not failure)))
   function)))

(defun source-lowerer (path helper-name)
 (let ((helper (definition path helper-name))
       (caller (definition path 'ir::lower-local-variables)))
  (checked-compile
   (list 'lambda (third caller)
         (list* 'flet (list (cdr helper)) (cdddr caller))))))

(defun source-pipeline (passes pipeline-path helper-name)
 (let* ((helper (definition passes helper-name))
        (caller (definition passes 'ir::lower-local-variables))
        (pipeline (definition pipeline-path 'ir::compile-backend-function-1))
        (local (list (second caller) (third caller)
                     (list* 'flet (list (cdr helper)) (cdddr caller)))))
  (checked-compile
   (list 'lambda (third pipeline)
         (list* 'flet (list local) (cdddr pipeline))))))

(defun variables (count)
 (loop for index below count
       collect (make-instance 'c::lexical-variable :name 'same-name
                :plist (when (evenp index) (list 'c::preserve-for-debugger t)))))

(defun graph (variables environment)
 (let* ((function (make-instance 'ir::backend-function))
        (bindings (loop for variable in variables for index from 0
                       collect (make-instance 'ir::bind-local-instruction
                                :ast variable
                                :value (make-instance 'ir::virtual-register :name (list :initial index))
                                :source-environment environment))))
  (dolist (binding bindings) (ir::append-instruction function binding))
  (ir::append-instruction function (make-instance 'ir::label :source-environment nil))
  (dotimes (round 2)
   (loop for binding in (reverse (butlast bindings)) for index from 0
         do (ir::append-instruction function
              (make-instance 'ir::store-local-instruction :local binding
               :value (make-instance 'ir::virtual-register :name (list :store round index))
               :source-environment (if (zerop round) :unknown environment)))
            (ir::append-instruction function
              (make-instance 'ir::load-local-instruction :local binding
               :destination (make-instance 'ir::virtual-register :name (list :load round index))
               :source-environment (if (zerop round) environment nil)))))
  (dolist (binding (butlast bindings))
   (ir::append-instruction function
     (make-instance 'ir::unbind-local-instruction :local binding :source-environment environment)))
  function))

(defun normalized (function variables)
 (let ((registers (make-hash-table :test #'eq)) (rows nil))
  (flet ((register (value)
           (assert (typep value 'ir::virtual-register))
           (let ((name (slot-value value 'ir::%name)))
            (when (typep name 'c::lexical-variable)
             (multiple-value-bind (old present) (gethash name registers)
              (if present (assert (eq value old)) (setf (gethash name registers) value)))
             (assert (eq (not (null (typep value 'ir::debug-variable-register)))
                         (not (null (c::preserve-variable-for-debugger-p name))))))
            (list (class-name (class-of value)) name (ir::virtual-register-kind value)))))
   (ir::do-instructions (instruction function)
    (push
     (list (class-name (class-of instruction))
           (ir::instruction-source-environment instruction)
           (typecase instruction
            (ir::move-instruction
             (list (register (ir::move-source instruction))
                   (register (ir::move-destination instruction))))
            (ir::debug-bind-variable-instruction
             (list (ir::debug-variable instruction) (register (ir::debug-value instruction))
                   (ir::debug-representation instruction)))
            (ir::debug-unbind-variable-instruction (ir::debug-variable instruction))
            (ir::label nil)
            (t (error "Unexpected lowered instruction ~S." instruction))))
     rows)))
  (assert (= (hash-table-count registers) (length variables)))
  (assert (= (length (remove-duplicates
                      (loop for register being the hash-values of registers collect register)
                      :test #'eq))
             (length variables)))
  (nreverse rows)))

(defun check-equivalence (old new)
 (let ((environment (c::extend-environment nil :declarations '((notinline identity)))))
  (dolist (count '(0 1 4 32 128 512 2048))
   (let* ((variables (variables count))
          (left (graph variables environment))
          (right (graph variables environment)))
    (funcall old left) (funcall new right)
    (assert (equal (normalized left variables) (normalized right variables)))))
  (format t "PASS indexed/reference lowering instruction order, binding identities, register classes, empty/unused bindings and source environments.~%")))

(defun source-lowerer-with-gc (path)
 (let* ((helper (definition path 'ir::lower-local-variable-references))
        (caller (definition path 'ir::lower-local-variables))
        (binding (second (third helper)))
        (collected (gensym "COLLECTED-")))
  (checked-compile
   `(lambda ,(third caller)
     (let ((,collected nil))
      (flet ((,(second helper) ,(third helper)
               (unless ,collected
                (let ((before (mezzano.internals::lisp-object-address
                               (ir::bind-local-ast ,binding))))
                 (setf ,collected t)
                 (mezzano.extensions:gc :full t)
                 (assert (/= before
                             (mezzano.internals::lisp-object-address
                              (ir::bind-local-ast ,binding))))))
               ,@(cdddr helper)))
       ,@(cdddr caller))
      (assert ,collected))))))

(defun check-moving-index (old candidate)
 (let ((new (source-lowerer-with-gc candidate))
       (environment (c::extend-environment nil :declarations '((notinline identity)))))
  (dolist (count '(4 128))
   (let* ((variables (variables count))
          (left (graph variables environment))
          (right (graph variables environment)))
    (funcall old left) (funcall new right)
    (assert (equal (normalized left variables) (normalized right variables)))))
  (format t "PASS live reference index, moved bindings and reference lists through full GC.~%")))

(defun measure (lower count repetitions)
 (let* ((variables (variables count))
        (functions (loop repeat repetitions collect (graph variables :unknown)))
        (start (get-internal-real-time)))
  (dolist (function functions) (funcall lower function))
  (/ (- (get-internal-real-time) start) internal-time-units-per-second)))

(defun benchmark (old new)
 (let ((results nil))
  (dolist (count '(32 128 512 2048))
   (let ((old-repetitions (max 1 (floor 1048576 (* count count))))
         (new-repetitions (floor 32768 count)))
    (dotimes (trial 3)
     (let (old-time new-time)
      (if (evenp trial)
          (setf old-time (measure old count old-repetitions)
                new-time (measure new count new-repetitions))
          (setf new-time (measure new count new-repetitions)
                old-time (measure old count old-repetitions)))
      (assert (and (plusp old-time) (plusp new-time)))
      (let ((row (list :bindings count :trial trial
                       :old-repetitions old-repetitions :old-seconds old-time
                       :new-repetitions new-repetitions :new-seconds new-time
                       :old-per-pass (/ old-time old-repetitions)
                       :new-per-pass (/ new-time new-repetitions))))
       (push row results)
       (format t "~S~%" row))))))
  (nreverse results)))

(defun run (baseline candidate pipeline-path)
 (let* ((names '(ir::lower-one-local-variable ir::lower-local-variable-references
                 ir::lower-local-variables ir::compile-backend-function-1))
        (functions (mapcar (lambda (name) (and (fboundp name) (fdefinition name))) names))
        (registry c::*constant-fold-modes*) (lock c::*constant-fold-modes-lock*)
        (entries (loop for key being the hash-keys of registry using (hash-value value)
                       collect (cons key value)))
        (old (source-lowerer baseline 'ir::lower-one-local-variable))
        (new (source-lowerer candidate 'ir::lower-local-variable-references)))
  (check-equivalence old new)
  (check-moving-index old candidate)
  (let ((run (find-symbol "RUN" "LISPM-BACKEND-ENVIRONMENT-TEST")))
   (assert (fboundp run))
   (funcall run (source-pipeline baseline pipeline-path 'ir::lower-one-local-variable))
   (format t "PASS original source pipeline runtime and environment tests.~%")
   (funcall run (source-pipeline candidate pipeline-path 'ir::lower-local-variable-references))
   (format t "PASS indexed source pipeline runtime and environment tests.~%"))
  (let ((results (benchmark old new)))
   (loop for name in names for function in functions
         do (assert (eq (and (fboundp name) (fdefinition name)) function)))
   (assert (eq registry c::*constant-fold-modes*))
   (assert (eq lock c::*constant-fold-modes-lock*))
   (assert (= (hash-table-count registry) (length entries) 543))
   (dolist (entry entries)
    (multiple-value-bind (value present) (gethash (car entry) registry)
     (assert present) (assert (eq value (cdr entry)))))
   (format t "PASS installed compiler function identities and all 543 registry entries unchanged.~%")
   results)))
