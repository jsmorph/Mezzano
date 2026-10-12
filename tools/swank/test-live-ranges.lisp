(defpackage #:lispm-live-range-test
  (:use #:cl)
  (:local-nicknames (#:ra #:mezzano.compiler.backend.register-allocator)
                    (#:ir #:mezzano.compiler.backend)))
(in-package #:lispm-live-range-test)

(defun fixture (count live-rows debug-rows &optional (max-debug t))
  (assert (= (length live-rows) (length debug-rows)))
  (let ((registers (make-array count))
        (variables (make-array count))
        (ids (make-hash-table :test 'eq))
        (live (make-hash-table :test 'eq))
        (debug (make-hash-table :test 'eq))
        (clobbers (make-hash-table :test 'eq))
        (order nil))
    (dotimes (i count)
      (setf (aref registers i) (make-instance 'ir:virtual-register :name i)
            (gethash (aref registers i) ids) i
            (aref variables i)
            (make-instance 'mezzano.compiler:lexical-variable :name i
                           :plist (when (evenp i) '(mezzano.compiler::preserve-for-debugger t)))))
    (loop for live-row in live-rows
          for debug-row in debug-rows
          for index from 0
          for inst = (make-instance 'ir:label :name index)
          do (push inst order)
             (setf (gethash inst live) (mapcar (lambda (i) (aref registers i)) live-row)
                   (gethash inst debug) (mapcar (lambda (i)
                                                 (list (aref variables i) (aref registers i)))
                                               debug-row)
                   (gethash inst clobbers) '(:rax)))
    (make-instance 'ra::linear-allocator
                   :vreg-to-id ids :id-to-vreg registers :ordering (nreverse order)
                   :architecture (make-instance 'mezzano.compiler:x86-64-target)
                   :live-in live :live-out live :instruction-clobbers clobbers
                   :debug-variable-value-map debug :max-debug-p max-debug)))

(defun range-signature (range)
  (list (ra::live-range-vreg-id range) (ra::live-range-start range)
        (ra::live-range-end range) (ra::live-range-zombie range)
        (sort (copy-list (ra::live-range-conflicts range)) #'string<)))

(defun signatures (allocator)
  (sort (map 'list #'range-signature (ra::allocator-remaining-ranges allocator))
        #'string< :key #'prin1-to-string))

(defun check (allocator expected reference)
  (let ((baseline (when reference
                    (funcall reference allocator)
                    (signatures allocator))))
    (ra::build-live-ranges allocator)
    (let ((result (signatures allocator)))
      (when reference (assert (equal result baseline)))
      (assert (equal (sort (mapcar (lambda (range) (subseq range 0 4)) result)
                           #'string< :key #'prin1-to-string)
                     (sort (copy-tree expected) #'string< :key #'prin1-to-string)))
      (loop for ranges being the hash-values of (ra::allocator-vreg-ranges allocator)
            do (assert (every #'<=
                              (map 'list #'ra::live-range-start ranges)
                              (cdr (map 'list #'ra::live-range-start ranges))))))
    t))

(defun run (&optional reference)
  (dolist (max-debug '(nil t))
    (check (fixture 3 '((0) () (0 1) (1) () () (2) ())
                      '((0 2) (0 2) (0 1 2) (0 1 2) (1 2) () () (2)) max-debug)
           (append '((0 0 0 nil) (0 1 1 t) (0 2 2 nil) (0 3 3 t)
                     (1 2 3 nil) (2 0 4 t) (2 6 6 nil) (2 7 7 t))
                   (when max-debug '((1 4 4 t))))
           reference))
  (check (fixture 1 '(() () ()) '((0 0) (0 0) (0 0)))
         '((0 0 2 t) (0 0 2 t)) reference)
  (check (fixture 0 '() '()) '() reference)
  (let* ((count 800)
         (all (loop for i below count collect i))
         (allocator (fixture count
                             (loop for i below 64 collect (when (member i '(0 63)) '(0)))
                             (make-list 64 :initial-element all)))
         (expected (append '((0 0 0 nil) (0 1 62 t) (0 63 63 nil))
                           (loop for i from 1 below count collect (list i 0 63 t)))))
    (check allocator expected reference))
  (format t "PASS live, debug, dead, alias, empty, and 800-variable ranges.~%")
  t)

(run)
