(defpackage #:lispm-backend-cfg-test
  (:use #:cl)
  (:local-nicknames (#:ir #:mezzano.compiler.backend))
  (:export #:run))
(in-package #:lispm-backend-cfg-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun entry ()
  (make-instance 'ir::argument-setup-instruction
                 :closure nil :count nil :required nil :optional nil :rest nil))

(defun check-map (table expected)
  (assert (= (hash-table-count table) (length expected)))
  (dolist (edge expected)
    (multiple-value-bind (value present-p) (gethash (car edge) table)
      (assert present-p)
      (assert (equal value (cdr edge))))))

(defun check-graph (builder mode)
  (let* ((function (make-instance 'ir::backend-function))
         (entry (entry))
         (left (make-instance 'ir::label))
         (right (make-instance 'ir::label))
         (dead (make-instance 'ir::label))
         (value (make-instance 'ir::virtual-register)))
    (ir::append-instruction function entry)
    (when (eq mode :mixed)
      (ir::append-instruction function
        (make-instance 'ir::begin-nlx-instruction
                       :context value :targets (list right right))))
    (ir::append-instruction function
      (if (eq mode :switch)
          (make-instance 'ir::switch-instruction
                         :value value :targets (list left right left))
          (make-instance 'ir::branch-instruction :value value
                         :true-target left
                         :false-target (if (eq mode :mixed) left right))))
    (ir::append-instruction function left)
    (ir::append-instruction function
      (if (eq mode :switch)
          (make-instance 'ir::switch-instruction
                         :value value :targets (list right left right))
          (make-instance 'ir::jump-instruction
                         :target (if (eq mode :mixed) right left))))
    (ir::append-instruction function right)
    (ir::append-instruction function (make-instance 'ir::return-instruction :value value))
    (ir::append-instruction function dead)
    (ir::append-instruction function (make-instance 'ir::return-instruction :value value))
    (multiple-value-bind (blocks predecessors successors) (funcall builder function)
      (assert (equal blocks (list entry left right dead)))
      (ecase mode
        (:mixed
         (check-map predecessors (list (list left entry) (list right left entry)))
         (check-map successors (list (list entry left right) (list left right))))
        (:branch
         (check-map predecessors (list (list left left entry) (list right entry)))
         (check-map successors (list (list entry right left) (list left left))))
        (:switch
         (check-map predecessors (list (list left left entry) (list right left entry)))
         (check-map successors (list (list entry right left) (list left left right))))))))

(defun check-empty-edges (builder)
  (let* ((function (make-instance 'ir::backend-function))
         (entry (entry)))
    (ir::append-instruction function entry)
    (ir::append-instruction function (make-instance 'ir::return-instruction :value nil))
    (multiple-value-bind (blocks predecessors successors) (funcall builder function)
      (assert (equal blocks (list entry)))
      (check-map predecessors nil)
      (check-map successors nil))))

(defun check-invalid-target (builder kind)
  (let ((function (make-instance 'ir::backend-function))
        (foreign (make-instance 'ir::backend-function))
        (target (make-instance 'ir::label)))
    (ir::append-instruction function (entry))
    (ecase kind
      (:dangling
       (ir::append-instruction function (make-instance 'ir::jump-instruction :target target)))
      (:foreign
       (ir::append-instruction foreign (entry))
       (ir::append-instruction foreign (make-instance 'ir::return-instruction :value nil))
       (ir::append-instruction foreign target)
       (ir::append-instruction foreign (make-instance 'ir::return-instruction :value nil))
       (ir::append-instruction function (make-instance 'ir::jump-instruction :target target)))
      (:interior
       (ir::append-instruction function
         (make-instance 'ir::begin-nlx-instruction :context nil :targets (list target)))
       (ir::append-instruction function target)
       (ir::append-instruction function (make-instance 'ir::return-instruction :value nil))))
    (assert (handler-case (progn (funcall builder function) nil)
              (simple-error () t)))))

(defun run (&optional (builder #'ir::build-cfg))
  (check-empty-edges builder)
  (dolist (mode '(:mixed :branch :switch)) (check-graph builder mode))
  (dolist (kind '(:dangling :foreign :interior)) (check-invalid-target builder kind))
  (format t "PASS CFG block order, edge order, duplicates, cycles, nonlocal edges, and invalid targets.~%")
  t)
(in-package #:cl-user)
