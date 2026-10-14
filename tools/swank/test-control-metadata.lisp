(defpackage #:lispm-control-metadata-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals) (#:d #:mezzano.debug))
  (:export #:run))
(in-package #:lispm-control-metadata-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(eval-when (:compile-toplevel :load-toplevel :execute)
  (defparameter *block-source*
    '(lambda (inspect)
       (block done
         (let ((x 37))
           (funcall inspect
                    (lambda (hook)
                      (funcall hook)
                      (return-from done (values x 43))))
           :missed))))
  (defparameter *tagbody-source*
    '(lambda (inspect)
       (let ((x 37))
         (tagbody
          start
            (funcall inspect (lambda (hook) (funcall hook) (incf x) (go finish)))
            (error "GO failed to leave its closure.")
          finish)
         (values x 43))))
  (defmacro define-target (name source)
    (list* 'defun name (cdr (symbol-value source)))))

(define-target block-target *block-source*)
(define-target tagbody-target *tagbody-source*)

(defun check-control-closure (exit kind debug target)
  (let* ((controls (i::closure-control-bindings exit))
         (destinations (mapcar (lambda (entry)
                                 (multiple-value-list
                                  (i::control-context-destination (third entry))))
                               controls)))
    (if (zerop debug)
        (assert (null controls))
        (progn
          (assert (= (length controls) 1))
          (destructuring-bind (actual-kind binding context) (first controls)
            (assert (eq actual-kind kind))
            (assert (i::debug-binding-p binding))
            (assert (typep context 'fixnum))
            (multiple-value-bind (function offset available)
                (i::control-context-destination context)
              (assert available)
              (assert (eq function target))
              (assert (typep offset '(integer 16 *))))
            (assert
             (loop for (offset . scope) in
                   (i::debug-info-source-scopes (i::function-debug-info exit))
                   thereis
                   (and (listp scope)
                        (member binding
                                (mapcar #'second
                                        (getf scope (if (eq kind :block)
                                                        :blocks :go-tags)))
                                :test #'eq)))))))
    (mezzano.extensions:gc :full t)
    (assert (equal controls (i::closure-control-bindings exit)))
    (assert (equal destinations
                   (mapcar (lambda (entry)
                             (multiple-value-list
                              (i::control-context-destination (third entry))))
                           controls)))
    (dolist (entry controls)
      (multiple-value-bind (function offset available)
          (i::control-context-destination (third entry))
        (assert available)
        (assert (eq function target))
        (assert (typep offset '(integer 16 *)))))))

(defun check-active-closure-locals (exit debug)
  (let ((seen nil))
    (d:map-backtrace
     (lambda (frame)
       (when (eq (nth-value 1 (d:frame-function frame)) (i::%closure-function exit))
         (setf seen t)
         (let* ((raw (i::frame-raw-data frame))
                (locals (i::frame-locals raw)))
           (assert (notany (lambda (local)
                             (i::debug-control-binding-p (first local)))
                           locals))
           (when (= debug 3)
             (let ((x (find 'x locals :key #'first)))
               (assert x)
               (multiple-value-bind (value available)
                   (i::read-frame-slot raw (third x) (fourth x))
                 (assert available)
                 (assert (= value 37)))))))))
    (assert seen)
    seen))

(defun check-target (target kind debug expected &optional before-inspection)
  (let ((seen nil))
    (multiple-value-bind (a b)
        (funcall target
                 (lambda (exit)
                   (when before-inspection (funcall before-inspection))
                   (check-control-closure exit kind debug target)
                   (funcall exit (lambda ()
                                   (setf seen (check-active-closure-locals exit debug))))))
      (assert (= a expected))
      (assert (= b 43)))
    (assert seen)))

(defun nested-block-target (inspect)
  (block done
    (let ((x 37))
      (let ((outer (lambda () (return-from done (values x 43)))))
        (block done
          (let ((x 99))
            (funcall inspect outer (lambda () (return-from done (values x 73))))
            (error "A captured block did not transfer.")))))))

(defun visible-control-entry (exit namespace name)
  (let ((binding
          (loop for (offset . scope) in
                (i::debug-info-source-scopes (i::function-debug-info exit))
                thereis (and (listp scope)
                             (second (assoc name (getf scope namespace)))))))
    (assert (i::debug-binding-p binding))
    (let ((entry (find binding (i::closure-control-bindings exit) :key #'second)))
      (assert entry)
      entry)))

(defun check-nested-blocks ()
  (dolist (inner-p '(nil t))
    (multiple-value-bind (a b)
        (nested-block-target
         (lambda (outer inner)
           (let ((outer-entry (visible-control-entry outer :blocks 'done))
                 (inner-entry (visible-control-entry inner :blocks 'done)))
             (assert (eq (first outer-entry) :block))
             (assert (eq (first inner-entry) :block))
             (assert (eq (i::debug-binding-name (second outer-entry)) 'done))
             (assert (eq (i::debug-binding-name (second inner-entry)) 'done))
             (assert (not (eq (second outer-entry) (second inner-entry))))
             (assert (/= (third outer-entry) (third inner-entry)))
             (mezzano.extensions:gc :full t)
             (assert (equal outer-entry (visible-control-entry outer :blocks 'done)))
             (assert (equal inner-entry (visible-control-entry inner :blocks 'done)))
             (funcall (if inner-p inner outer)))))
      (assert (= a (if inner-p 99 37)))
      (assert (= b (if inner-p 73 43))))))

(defun nested-tagbody-target (inspect)
  (let ((x 37) (result nil))
    (tagbody
     start
       (let ((outer (lambda () (incf x) (go finish))))
         (let ((x 99))
           (tagbody
            start
              (funcall inspect outer (lambda () (incf x) (go finish)))
              (error "A captured GO did not transfer.")
            finish)
           (setf result x)))
     finish)
    (values (or result x) 43)))

(defun check-nested-tagbodies ()
  (dolist (inner-p '(nil t))
    (multiple-value-bind (a b)
        (nested-tagbody-target
         (lambda (outer inner)
           (let ((outer-entry (visible-control-entry outer :go-tags 'finish))
                 (inner-entry (visible-control-entry inner :go-tags 'finish)))
             (assert (eq (first outer-entry) :tagbody))
             (assert (eq (first inner-entry) :tagbody))
             (assert (not (eq (second outer-entry) (second inner-entry))))
             (assert (/= (third outer-entry) (third inner-entry)))
             (mezzano.extensions:gc :full t)
             (assert (equal outer-entry (visible-control-entry outer :go-tags 'finish)))
             (assert (equal inner-entry (visible-control-entry inner :go-tags 'finish)))
             (funcall (if inner-p inner outer)))))
      (assert (= a (if inner-p 100 38)))
      (assert (= b 43)))))

(defun check-redefinition ()
  (let ((old #'block-target)
        (replacement (compile nil '(lambda (inspect) (declare (ignore inspect)) 88))))
    (unwind-protect
         (progn
           (check-target old :block 3 37
                         (lambda () (setf (fdefinition 'block-target) replacement)))
           (assert (eq (fdefinition 'block-target) replacement))
           (assert (= (block-target nil) 88)))
      (setf (fdefinition 'block-target) old))))

(defun run ()
  (check-nested-blocks)
  (check-nested-tagbodies)
  (check-redefinition)
  (check-target #'block-target :block 3 37)
  (check-target #'tagbody-target :tagbody 3 38)
  (dolist (debug '(0 1 3))
    (loop for source in (list *block-source* *tagbody-source*)
          for kind in '(:block :tagbody)
          for expected in '(37 38)
          do (multiple-value-bind (target warnings failure)
                 (compile nil (list* 'lambda (second source)
                                     (list 'declare
                                           (list 'optimize (list 'debug debug)
                                                 '(safety 3) '(speed 1)))
                                     (cddr source)))
               (assert (and target (not warnings) (not failure)))
               (check-target target kind debug expected))))
  (format t "PASS compiled control identities, source/layout sharing, closure locals, DEBUG 0/1/3, BLOCK/GO, multiple values, and moving GC.~%")
  t)
