(in-package #:lispm-foothold-binding-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *value-cases* nil)

(defun call-with-test-prompts (depth function)
  (if (zerop depth)
      (funcall function)
      (dc:call-with-prompt
       (dc:make-prompt-tag "Owned nested mask prompt")
       (lambda () (call-with-test-prompts (1- depth) function))
       (lambda (&rest values)
         (error "Unexpected nested prompt handler: ~S." values)))))

(defun value-observation (parent child resumer wanted direct depth row)
  (let ((tag (dc:make-prompt-tag "Owned mask/value prompt")) (saved nil))
    (setf (getf row :started) (get-internal-real-time))
    (s::call-with-foothold-binding
     (lambda ()
       (dc:call-with-prompt tag
        (lambda ()
          (call-with-test-prompts depth
           (lambda ()
             (s::call-with-foothold-binding
              (lambda ()
                (setf (getf row :before) (state)
                      (getf row :input)
                      (multiple-value-list (dc:abort-to-prompt tag (values :yielded)))
                      (getf row :resumed) (state))
                (values-list (getf row :input)))
              (first child) (second child)))))
        (lambda (continuation marker)
          (setf saved continuation
                (getf row :marker) marker
                (getf row :handler) (state)))))
     (first parent) (second parent))
    (s::call-with-foothold-binding
     (lambda ()
       (setf (getf row :output)
             (multiple-value-list
              (if direct
                  (apply saved wanted)
                  (dc:call-with-prompt tag saved
                   (lambda (&rest values)
                     (error "Unexpected resume handler: ~S." values)))))
             (getf row :resumer) (state)))
     (first resumer) (second resumer))
    (setf (getf row :after) (state)
          (getf row :finished) (get-internal-real-time))
    row))

(defun value-case (parent child resumer count direct depth collect)
  (let* ((all (list (list :moving count) (copy-seq "values")
                    (vector 42 43) nil :fifth 6 7 8))
         (wanted (subseq all 0 count))
         (row (list :parent parent :child child :caller resumer
                    :count count :direct direct :depth depth :collect collect
                    :before nil :input nil :resumed nil :marker nil :handler nil
                    :output nil :resumer nil :after nil :started nil :finished nil))
         (start (s:make-event))
         (thread (s:make-thread
                  (lambda ()
                    (s:event-wait start)
                    (value-observation parent child resumer wanted direct depth row))
                  :name "Owned continuation mask/value target")))
    (unwind-protect
         (progn
           (when collect (setf s::*foothold-binding-probe-collect* thread))
           (setf (s:event-state start) t)
           (multiple-value-bind (values joined) (s:thread-join thread)
             (assert joined)
             (assert (eq (first values) row)))
           (await (lambda () (eq (s::sample-thread-state thread) :dead)))
           (push row *value-cases*)
           (assert (equal (getf row :before) child))
           (assert (eq (getf row :marker) :yielded))
           (assert (equal (getf row :handler) parent))
           (assert (equal (getf row :resumed) child))
           (assert (equal (getf row :resumer) resumer))
           (assert (equal (getf row :after) '(0 t)))
           (assert (= (length (getf row :input)) count))
           (assert (= (length (getf row :output)) count))
           (assert (every #'eq wanted (getf row :input)))
           (assert (every #'eq wanted (getf row :output)))
           (format t "PASS continuation P~S C~S R~S, ~D values, direct ~S, prompts ~D, GC ~S.~%"
                   parent child resumer count direct depth collect)
           (when collect
             (format t "Switch GC target elapsed ~,2F seconds.~%"
                     (/ (- (getf row :finished) (getf row :started))
                        internal-time-units-per-second))))
      (setf (s:event-state start) t
            s::*foothold-binding-probe-collect* nil))))

(defun check-values ()
  (setf *value-cases* nil)
  (dolist (parent '(0 1))
    (dolist (child '(0 1))
      (dolist (resumer '(0 1))
        (dolist (count '(0 1 5 8))
          (value-case (list parent t) (list child t) (list resumer t) count t 0 nil))
        (value-case (list parent t) (list child t) (list resumer t) 0 nil 0 nil))))
  (dolist (parent '((0 nil) (1 nil)))
    (dolist (child '((0 nil) (1 t)))
      (dolist (resumer '((0 t) (1 nil)))
        (value-case parent child resumer 8 t 2 nil))))
  (value-case '(0 t) '(1 nil) '(1 t) 8 t 2 t)
  (value-case '(1 nil) '(0 t) '(0 nil) 5 t 2 t)
  (assert (= 50 (length *value-cases*)))
  (format t "PASS 50 continuation mask/value cases, nested prompts, identities, and GC at switch preparation.~%")
  :continuation-mask-values-tested)
