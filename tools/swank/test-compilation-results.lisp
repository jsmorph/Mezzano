(defpackage #:lispm-compilation-results-test
  (:use #:cl)
  (:local-nicknames (#:s #:mezzano.supervisor))
  (:export #:run))
(in-package #:lispm-compilation-results-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defvar *probe-condition*)
(defvar *nested-result*)
(defvar *nested-source*)
(defvar *entered*)
(defvar *resume*)

(defun emit-diagnostic (kind)
  (ecase kind
    (:clean)
    ((:style :warning) (warn *probe-condition*))
    (:error (cerror "Continue the owned compiler test." *probe-condition*)))
  42)

(defmacro diagnostic (kind)
  (emit-diagnostic kind))

(defmacro nested-diagnostic ()
  (setf *nested-result*
        (multiple-value-list (compile nil '(lambda () (diagnostic :style)))))
  42)

(defmacro nested-file-diagnostic ()
  (setf *nested-result*
        (multiple-value-list
         (compile-file *nested-source* :parallel :force :verbose nil :print nil)))
  42)

(defmacro gated-diagnostic (kind)
  (s:fifo-push kind *entered*)
  (s:fifo-pop *resume*)
  (if (eq kind :clean)
      42
      (progn (warn "Owned concurrent compiler warning.") 42)))

(defun check-flags (values warning failure)
  (assert (= (length values) 3))
  (assert (eql (not (null (second values))) warning))
  (assert (eql (not (null (third values))) failure))
  (first values))

(defun call-with-source (forms function)
  (let* ((source (pathname (format nil "SYS:HOME;~A.LISP" (gensym "COMPILATION-RESULTS-"))))
         (output (compile-file-pathname source)))
    (unwind-protect
         (progn
           (with-open-file (stream source :direction :output :if-exists :error)
             (with-standard-io-syntax
               (dolist (form forms)
                 (write form :stream stream)
                 (terpri stream))))
           (funcall function source))
      (when (probe-file source) (delete-file source))
      (when (probe-file output) (delete-file output)))))

(defun check-diagnostic (kind)
  (let* ((*probe-condition*
           (make-condition (ecase kind
                             (:clean 'simple-condition)
                             (:style 'mezzano.internals::simple-style-warning)
                             (:warning 'simple-warning)
                             (:error 'simple-error))
                           :format-control "Owned compiler diagnostic."))
         (warnings (not (eq kind :clean)))
         (failure (member kind '(:warning :error)))
         (observed 0))
    (handler-bind ((warning (lambda (condition)
                              (assert (eq condition *probe-condition*))
                              (incf observed)))
                   (error (lambda (condition)
                            (when (eq condition *probe-condition*)
                              (incf observed)
                              (invoke-restart 'continue)))))
      (assert (= (funcall
                  (check-flags
                   (multiple-value-list
                    (compile nil `(lambda () (diagnostic ,kind))))
                   warnings (not (null failure))))
                 42))
      (dolist (parallel '(nil :force))
        (call-with-source
         `((eval-when (:compile-toplevel) (emit-diagnostic ,kind)))
         (lambda (source)
           (assert (pathnamep
                    (check-flags
                     (multiple-value-list
                      (compile-file source :parallel parallel :verbose nil :print nil))
                     warnings (not (null failure)))))))))
    (assert (= observed (if warnings 3 0)))))

(defun check-worker-warning ()
  (dolist (parallel '(nil :force))
    (call-with-source
     '((defun compilation-worker-warning ()
         ((lambda (value) value))))
     (lambda (source)
       (check-flags
        (multiple-value-list
         (compile-file source :parallel parallel :verbose nil :print nil))
        t t)))))

(defun check-nested-file ()
  (call-with-source
   '((defun compilation-worker-warning () ((lambda (value) value))))
   (lambda (source)
     (let ((*nested-source* source)
           (*nested-result* nil))
       (check-flags
        (multiple-value-list
         (compile nil '(lambda () (nested-file-diagnostic)))) t t)
       (check-flags *nested-result* t t)))))

(defun check-nested ()
  (let ((*probe-condition*
          (make-condition 'mezzano.internals::simple-style-warning
                          :format-control "Owned nested compiler warning."))
        (*nested-result* nil))
    (check-flags
     (multiple-value-list (compile nil '(lambda () (nested-diagnostic)))) t nil)
    (check-flags *nested-result* t nil)
    (assert (= (funcall (first *nested-result*)) 42))
    (check-flags (multiple-value-list (compile nil '(lambda () 42))) nil nil))
  (let ((condition (make-condition 'simple-error :format-control "Owned propagation test.")))
    (assert
     (eq (handler-case
             (compile nil `(lambda () (macrolet ((fail () (error ',condition))) (fail))))
           (error (observed) observed))
         condition))))

(defun check-concurrent ()
  (let* ((*entered* (s:make-fifo 2))
         (*resume* (s:make-fifo 2))
         (results (s:make-fifo 2))
         (threads nil))
    (unwind-protect
         (progn
           (dolist (kind '(:clean :warning))
             (let ((kind kind))
               (push
                (s:make-thread
                 (lambda ()
                   (s:fifo-push
                    (handler-case
                        (list kind
                              (multiple-value-list
                               (compile nil `(lambda () (gated-diagnostic ,kind)))))
                      (error (condition) condition))
                    results))
                 :name "Owned compilation results"
                 :initial-bindings `((*entered* ,*entered*)
                                     (*resume* ,*resume*)
                                     (*error-output* ,*error-output*)))
                threads)))
           (dotimes (i 2) (s:fifo-pop *entered*))
           (dotimes (i 2) (s:fifo-push t *resume*))
           (dotimes (i 2)
             (let ((result (s:fifo-pop results)))
               (when (typep result 'error) (error result))
               (let ((warning (eq (first result) :warning)))
                 (check-flags (second result) warning warning)))))
      (dolist (thread threads)
        (unless (nth-value 1 (s:thread-join thread nil))
          (s:terminate-thread thread))))))

(defun check-compiled-definition ()
  (let ((name (gensym "COMPILED-INSTALL-"))
        (macro-name (gensym "COMPILED-MACRO-")))
    (unwind-protect
         (progn
           (assert (eq (check-flags (multiple-value-list (compile nil #'identity)) nil nil)
                       #'identity))
           (assert (eq (check-flags (multiple-value-list (compile name #'identity)) nil nil)
                       name))
           (assert (eq (fdefinition name) #'identity))
           (assert (eq (check-flags (multiple-value-list (compile name)) nil nil) name))
           (setf (macro-function macro-name)
                 (lambda (form environment) (declare (ignore form environment)) 41))
           (let ((replacement
                   (lambda (form environment) (declare (ignore form environment)) 42)))
             (assert (eq (check-flags
                          (multiple-value-list (compile macro-name replacement)) nil nil)
                         macro-name))
             (assert (eq (macro-function macro-name) replacement))
             (assert (= (macroexpand (list macro-name)) 42))))
      (fmakunbound name)
      (fmakunbound macro-name))))

(defun run ()
  (dolist (kind '(:clean :style :warning :error)) (check-diagnostic kind))
  (check-worker-warning)
  (check-nested)
  (check-nested-file)
  (check-concurrent)
  (check-compiled-definition)
  (format t "PASS compiler diagnostic flags, condition identity, serial/parallel phases, nested/concurrent isolation, and compiled-function installation.~%")
  t)
