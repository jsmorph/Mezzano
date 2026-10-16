(defpackage #:lispm-instruction-boundary-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:d #:mezzano.debug)
                    (#:c #:mezzano.compiler) (#:a #:mezzano.lap)
                    (#:x #:mezzano.lap.x86) (#:arm #:mezzano.lap.arm64)
                    (#:s #:mezzano.supervisor) (#:dis #:mezzano.disassemble))
  (:export #:run))
(in-package #:lispm-instruction-boundary-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun starts (map)
  (loop for offset below (length map)
        when (= (sbit map offset) 1) collect offset))

(defun check-assembly (architecture code offsets end &optional bytes)
  (let* ((entry (vector :entry))
         (parameters (vector :parameters))
         (callable (vector :callable))
         (info (append (list :debug-info 'fixture nil nil nil nil nil nil nil nil nil)
                       (list entry parameters callable))))
    (multiple-value-bind (mc constants)
        (a:perform-assembly-using-target
         (c::canonicalize-target architecture) code :base-address 16
         :info (list 'fixture info))
      (let ((result (aref constants 1)))
        (assert (= (length mc) (- end 16)))
        (assert (= (length result) 15))
        (assert (eq result info))
        (assert (eq entry (nth 11 result)))
        (assert (eq parameters (nth 12 result)))
        (assert (eq callable (nth 13 result)))
        (assert (= (length (i::debug-info-instruction-starts result)) end))
        (assert (equal (starts (i::debug-info-instruction-starts result)) offsets))
        (when bytes (assert (equalp mc (coerce bytes '(vector (unsigned-byte 8))))))))))

(defun check-x86 ()
  (check-assembly :x86-64
                 '((x:nop) (x:push :rbp) (x:mov64 :rbp :rsp) (x:ret))
                 '(16 17 18 21) 22)
  (check-assembly :x86-64
                 '((x:rep) (x:nop) (x:cs) (x:rep) (x:nop)
                   (x:lock x:not64 (:rax)) (x:lock) (x:not64 (:rax))
                   (x:!code64) (x:ret))
                 '(16 18 21 25 29) 30
                 '(#xF3 #x90 #x2E #xF3 #x90 #xF0 #x48 #xF7 #x10
                   #xF0 #x48 #xF7 #x10 #xC3))
  (check-assembly :x86-64
                 '((x:nop) (:d8 #x90) (:d16/le #x9090) (:d32/le #x90909090)
                   (:d64/le #x9090909090909090) (:d8 #x90)
                   (:align 16 :value #x90) (x:nop)
                   (:align 8 :value #x90) (x:ret))
                 '(16 48 56) 57)
  (check-assembly :x86-64
                 '(begin (x:nop) (x:jmp finish) (:d8 #x90)
                   finish (x:jmp begin) (x:ret))
                 '(16 17 20 22) 23
                 '(#x90 #xEB #x01 #x90 #xEB #xFA #xC3))
  (check-assembly :x86-64
                 (append '(begin (x:jmp finish))
                         (list (cons :d8 (make-list 200 :initial-element #x90)))
                         '(finish (x:nop) (x:jmp begin) (x:ret)))
                 '(16 221 222 227) 228)
  (check-assembly :x86-64
                 '((x:jmp :rax) (:d64/le #x9090909090909090 #x9090909090909090)
                   (x:nop) (x:ret))
                 '(16 35 36) 37
                 (append '(#x48 #xFF #xE0)
                         (make-list 16 :initial-element #x90) '(#x90 #xC3)))
  (check-assembly :x86-64
                 '((x:hint-taken) (x:jmp finish) (:d8 #x90) finish (x:nop) (x:ret))
                 '(16 20 21) 22 '(#x3E #xEB #x01 #x90 #x90 #xC3))
  (dolist (prefix '((x:repne #xF2) (x:repnz #xF2) (x:rep #xF3)
                    (x:cs #x2E) (x:ss #x36) (x:ds #x3E) (x:es #x26)
                    (x:fs #x64) (x:gs #x65) (x:hint-not-taken #x2E)
                    (x:hint-taken #x3E) (x:operand-size-override #x66)
                    (x:address-size-override #x67)))
    (check-assembly :x86-64 (list (list (first prefix)) '(x:nop) '(x:ret))
                    '(16 18) 19 (list (second prefix) #x90 #xC3)))
  (check-assembly :x86-64
                 '((x:!code64) (x:rep) (:d8 #x90) (x:nop) (x:cs))
                 '(18) 20)
  (multiple-value-bind (mc constants)
      (a:perform-assembly-using-target
       (c::canonicalize-target :x86-64) '((x:nop) (x:ret))
       :base-address 16 :info '(fixture nil))
    (assert (equalp mc #(#x90 #xC3)))
    (assert (null (aref constants 1))))
  (let ((info (list :debug-info 'legacy-lap nil nil nil nil nil nil nil nil)))
    (multiple-value-bind (mc constants)
        (a:perform-assembly-using-target
         (c::canonicalize-target :x86-64) '((x:nop) (x:ret))
         :base-address 16 :info (list 'legacy-lap info))
      (declare (ignore mc))
      (assert (= (length (aref constants 1)) 15))
      (assert (equal (starts (i::debug-info-instruction-starts (aref constants 1)))
                     '(16 17))))))

(defun check-arm64 ()
  (check-assembly :arm64
                 '((arm:nop) (:d64/le #xD503201FD503201F) (:align 16)
                   (arm:ret))
                 '(16 32) 36)
  (check-assembly :arm64
                 '((arm:b finish) (:d64/le 0) finish (arm:nop) (arm:ret))
                 '(16 28 32) 36))

(defvar *boundary-special* 37)

(defun native-special () *boundary-special*)

(defun native-target (x)
  (if x (values 37 x) (values 42 nil)))

(i::define-lap-function file-target (())
  (:gc :no-frame :layout #*0)
  (x:jmp finish)
  (:d64/le #x9090909090909090)
  (:align 16 :value #x90)
 finish
  (x:nop)
  (x:ret))

(defun rejected (function offset reason)
  (assert
   (handler-case
       (progn (d::service-validate-instruction-breakpoint-location function offset) nil)
     (d:debugger-service-error (condition)
       (eq reason (d:debugger-service-error-reason condition))))))

(defun check-function (function)
  (let* ((info (i::function-debug-info function))
         (map (i::debug-info-instruction-starts info))
         (locations (starts map))
         (before (copy-seq map)))
    (assert (typep map 'simple-bit-vector))
    (assert (equal (multiple-value-list
                    (d::service-validate-instruction-breakpoint-location
                     function (first locations)))
                   (list function (first locations))))
    (loop for offset from 16 below (i::function-code-size function)
          do (if (member offset locations)
                 (assert (eq function
                             (d::service-validate-instruction-breakpoint-location
                              function offset)))
                 (rejected function offset :not-instruction-start)))
    (dolist (offset (list -1 0 15 (i::function-code-size function) (expt 2 100) 16.0 nil))
      (rejected function offset :invalid-instruction-offset))
    (unwind-protect
         (progn
           (setf (nth 14 info) nil)
           (rejected function (first locations) :instruction-boundaries-unavailable))
      (setf (nth 14 info) map))
    (mezzano.extensions:gc :full t)
    (assert (eq map (i::debug-info-instruction-starts (i::function-debug-info function))))
    (assert (equalp before map))
    locations))

(defun check-decoder (function)
  (let ((instructions (dis:context-instructions (dis:make-disassembler-context function))))
    (assert (every #'identity instructions))
    (assert (equal (starts (i::debug-info-instruction-starts (i::function-debug-info function)))
                   (map 'list #'dis:inst-offset instructions)))))

(defun check-native ()
  (assert (null (i::debug-info-instruction-starts nil)))
  (assert (null (i::debug-info-instruction-starts '(:debug-info old))))
  (rejected nil 16 :not-compiled-function)
  (rejected #'s::load-instruction-breakpoint-registers 16 :resident-function)
  (assert (equal (check-function #'file-target) '(16 32 33)))
  (check-function #'native-target)
  (check-function #'native-special)
  (check-decoder #'native-target)
  (check-decoder #'native-special)
  (dolist (debug '(0 1 3))
    (let* ((c::*optimize-policy* (list 'safety 3 'debug debug 'speed 1))
           (function (compile nil '(lambda (x) (if x (1+ x) 37))))
           (before (multiple-value-list (funcall function 41))))
      (check-function function)
      (check-decoder function)
      (assert (equal before (multiple-value-list (funcall function 41))))
      (assert (= (funcall function nil) 37))))
  (let* ((factory (compile nil '(lambda (x) (lambda () (incf x)))))
         (closure (funcall factory 36)))
    (check-function (i::%closure-function closure))
    (check-decoder (i::%closure-function closure))
    (assert (= (funcall closure) 37)))
  (let* ((symbol (gensym "OWNED-BOUNDARY-"))
         (old (progn (compile symbol '(lambda () 37)) (fdefinition symbol)))
         (map (i::debug-info-instruction-starts (i::function-debug-info old))))
    (unwind-protect
         (progn
           (compile symbol '(lambda () 42))
           (check-function old)
           (assert (eq map (i::debug-info-instruction-starts (i::function-debug-info old))))
           (assert (= (funcall old) 37))
           (assert (= (funcall symbol) 42)))
      (fmakunbound symbol))))

(defun run ()
  (let ((before (s::instruction-breakpoints)))
    (check-x86)
    (check-arm64)
    (check-native)
    (assert (equal before (s::instruction-breakpoints))))
  (format t "PASS exact instruction starts, prefixes, branches, data/alignment, both assemblers, native compilation/loading, validation, legacy rejection, redefinition, GC and unchanged breakpoint slots.~%")
  t)
