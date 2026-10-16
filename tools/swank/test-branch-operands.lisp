(defpackage #:lispm-branch-operands-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:d #:mezzano.disassemble)
                    (#:x #:mezzano.disassemble.x86-64) (#:lap #:mezzano.lap.x86))
  (:export #:run))
(in-package #:lispm-branch-operands-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(i::define-lap-function operand-bytes (())
  (:gc :no-frame :layout #*0)
  (:d8 #xEB #x00
       #xE9 #x00 #x00 #x00 #x00
       #xE8 #x00 #x00 #x00 #x00
       #xFF #x25 #x00 #x00 #x00 #x00
       #xFF #x15 #x00 #x00 #x00 #x00
       #xFF #xE0
       #xFF #xD0
       #x74 #x00
       #x0F #x84 #x00 #x00 #x00 #x00
       #xC3))

(i::define-lap-function jump-table-bytes (())
  (:gc :no-frame :layout #*0)
  (lap:jmp :rax)
  table
  (:d64/le (- destination table))
  destination
  (lap:ret)
  (:d8 #x90 #x90 #x90 #x90 #x90 #x90 #x90 #x90))

(defun check-instruction (context offset opcode kind size)
  (let* ((instruction (d:instruction-at context offset))
         (operand (first (x::inst-operands instruction))))
    (assert instruction)
    (assert (eq (x::inst-opcode instruction) opcode))
    (assert (= (d:inst-size instruction) size))
    (ecase kind
      (:relative (assert (typep operand 'x::relative-address)))
      (:memory (assert (typep operand 'x::effective-address))
               (assert (not (typep operand 'x::relative-address))))
      (:register (assert (eq operand :rax))))
    (when (member kind '(:relative :memory))
      (assert (eq (x::ea-base operand) :rip))
      (assert (zerop (x::ea-disp operand))))
    (dolist (labels '(nil t))
      (let ((text (with-output-to-string (*standard-output*)
                    (d:print-instruction context instruction
                                         :print-labels labels :print-annotations nil))))
        (if (eq kind :memory)
            (assert (search "(:RIP " text))
            (assert (not (search "(:RIP " text)))))
      (assert (stringp (with-output-to-string (*standard-output*)
                        (d:print-instruction context instruction
                                             :print-labels labels :print-annotations t)))))))

(defun run ()
  (let ((context (d:make-disassembler-context #'operand-bytes)))
    (dolist (entry '((16 lap:jmp :relative 2) (18 lap:jmp :relative 5)
                     (23 lap:call :relative 5) (28 lap:jmp :memory 6)
                     (34 lap:call :memory 6) (40 lap:jmp :register 2)
                     (42 lap:call :register 2) (44 lap:jz :relative 2)
                     (46 lap:jz :relative 6)))
      (apply #'check-instruction context entry)))
  (let* ((context (d:make-disassembler-context #'jump-table-bytes))
         (jump (d:instruction-at context 16))
         (instruction (d:instruction-at context (+ 16 (d:inst-size jump)))))
    (assert instruction)
    (assert (eq (x::inst-opcode instruction) :jump-target))
    (let ((text (with-output-to-string (*standard-output*)
                  (d:print-instruction context instruction))))
      (assert (search ":D64/LE (- L" text))))
  (format t "PASS short/near relative JMP/Jcc, relative CALL, RIP-memory and register CALL/JMP operands and rendering with labels/annotations and valid/false jump tables.~%")
  t)
