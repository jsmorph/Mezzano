(defpackage :lispm-function-metadata-test
  (:use :cl)
  (:local-nicknames (:int :mezzano.internals)
                    (:x86 :mezzano.lap.x86)))
(in-package :lispm-function-metadata-test)

(defvar *function*)
(defvar *root*)
(defvar *length*)

(defun check-size (function length)
  (assert (= (int::function-gc-metadata-size function) length))
  (assert (= (nth-value 1 (int::function-gc-info function)) length))
  (assert (= (int::object-size function)
             (* 4 (ceiling (+ (int::function-code-size function)
                              (* 8 (int::function-pool-size function))
                              length)
                           32)))))

(defun header-boundaries ()
  (dolist (length '(0 65535 65536 70062))
    (let* ((bytes (make-array length :element-type '(unsigned-byte 8)
                                    :initial-element 165))
           (function (int::make-function int::+object-tag-function+
                                         #() nil #() bytes)))
      (check-size function length)
      (when (plusp length)
        (assert (= (int::function-gc-metadata-byte function (1- length)) 165)))
      (assert (handler-case
                  (progn (int::function-gc-metadata-byte function length) nil)
                (error () t)))))
  (assert (handler-case
              (progn
                (int::make-function
                 int::+object-tag-function+ #() nil #()
                 (make-array (ash 1 24) :element-type '(unsigned-byte 8)))
                nil)
            (error () t)))
  (format t "PASS function metadata length boundaries and overflow rejection.~%"))

(defun collect ()
  (mezzano.extensions:gc :full t))

#+x86-64
(defun prepare ()
  (setf *root* (vector (copy-seq "metadata root") (list :constant-pool)))
  (setf *function*
        (int::assemble-lap
         (append
          '((:gc :no-frame :layout #*0)
            (x86:push :rbp)
            (:gc :no-frame :layout #*00)
            (x86:mov64 :rbp :rsp)
            (:gc :frame)
            (x86:push :r8)
            (x86:push 0))
          (loop for i below 12000
                append (list (if (evenp i)
                                 '(:gc :frame :layout #*10 :multiple-values 0)
                                 '(:gc :frame :layout #*10))
                             '(x86:nop)))
          '((x86:mov32 :ecx 0)
            (x86:call (:named-call collect))
            (x86:mov64 :r8 (:rbp -8))
            (x86:mov32 :ecx #.(ash 1 int::+n-fixnum-bits+))
            (x86:leave)
            (:gc :no-frame :layout #*0)
            (x86:ret)))
         'large-metadata (list :fixture *root*) nil :x86-64)
        *length* (int::function-gc-metadata-size *function*))
  (assert (> *length* 65535))
  (format t "Created function with ~D bytes of GC metadata.~%" *length*))

(defun check ()
  (check-size *function* *length*)
  (let ((entries (int::decode-function-gc-info *function*)))
    (assert (= (length entries) 12004))
    (assert (every (lambda (entry) (< (first entry) (int::function-code-size *function*)))
                   entries))
    (assert (equalp (getf (cddr (car (last entries))) :layout) #*0)))
  (assert (eq (second (int::function-pool-object *function* 1)) *root*))
  (let ((before (int::lisp-object-address *root*)))
    (assert (eq (funcall *function* *root*) *root*))
    (assert (/= before (int::lisp-object-address *root*))))
  (assert (equalp *root* #("metadata root" (:constant-pool))))
  (check-size *function* *length*)
  (format t "PASS large function metadata, constant pool, active frame, and full GC.~%"))

(defun run ()
  (header-boundaries)
  (prepare)
  (check)
  t)

(in-package :cl-user)
