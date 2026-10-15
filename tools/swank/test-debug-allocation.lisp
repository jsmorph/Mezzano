(defpackage #:lispm-debug-allocation-test
  (:use #:cl)
  (:local-nicknames (#:c #:mezzano.compiler)
                    (#:ir #:mezzano.compiler.backend)
                    (#:ra #:mezzano.compiler.backend.register-allocator))
  (:export #:run))
(in-package #:lispm-debug-allocation-test)

(defun run ()
  (let* ((function (make-instance 'ir:backend-function))
         (instructions (loop repeat 6 collect
                         (ir:append-instruction function
                           (make-instance 'ir:backend-instruction))))
         (x (make-instance 'c:lexical-variable :name 'x))
         (y (make-instance 'c:lexical-variable :name 'y))
         (z (make-instance 'c:lexical-variable :name 'z))
         (a (make-instance 'ir:virtual-register :name 'a))
         (b (make-instance 'ir:virtual-register :name 'b))
         (unknown (make-instance 'ir:virtual-register :name 'unknown))
         (first-range (make-instance 'ra::live-range :vreg a :vreg-id 0
                                    :start 0 :end 0 :conflicts nil :zombie nil))
         (second-range (make-instance 'ra::live-range :vreg b :vreg-id 1
                                     :start 1 :end 4 :conflicts nil :zombie nil))
         (resumed-range (make-instance 'ra::live-range :vreg a :vreg-id 0
                                      :start 2 :end 3 :conflicts nil :zombie t))
         (starts (make-hash-table))
         (allocations (make-hash-table))
         (spilled (make-hash-table))
         (original (make-hash-table))
         (entries (list (list x a :value) (list y b :value)))
         (allocator (make-instance 'ra::linear-allocator
                                   :function function :ordering instructions
                                   :range-starts starts :debug-variable-value-map original)))
    (setf (gethash 0 starts) (list first-range)
          (gethash 1 starts) (list second-range)
          (gethash 2 starts) (list resumed-range)
          (gethash first-range allocations) :r8
          (gethash second-range allocations) :r8
          (gethash resumed-range spilled) t
          (slot-value allocator 'ra::%allocations) allocations
          (slot-value allocator 'ra::%spilled) spilled)
    (loop for instruction in instructions
          for index from 0
          do (setf (gethash instruction original)
                   (case index
                     (0 (list (first entries)))
                     (5 (append entries (list (list z unknown :value))))
                     (t entries))))
    (ra::rebuild-debug-map allocator)
    (let ((map (ra::allocator-debug-variable-value-map allocator)))
      (loop for instruction in instructions
            for expected in (list (list (list x :r8)) (list (list y :r8))
                                  (list (list x a) (list y :r8))
                                  (list (list x a) (list y :r8))
                                  (list (list y :r8)) nil)
            for index from 0
            for observed = (gethash instruction map)
            do (assert (= (length observed) (length expected))
                       () "Debug layout at instruction ~D: ~S, expected ~S."
                       index observed expected)
               (dolist (entry expected)
                 (let ((record (assoc (first entry) observed)))
                   (assert (and record (eq (second record) (second entry))
                                (eq (third record) :value))))))
      (assert (eq (gethash (third instructions) map)
                  (gethash (fourth instructions) map)))))
  (format t "PASS debug live-range endpoints, gaps, register reuse, spilled preservation, missing ranges, and layout sharing.~%")
  t)
