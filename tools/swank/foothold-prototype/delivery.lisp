(in-package #:lispm-foothold-binding-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *delivery-cases* nil)

(defun delivery-observation (parent child wanted start row)
  (s:event-wait start)
  (let ((tag (dc:make-prompt-tag "Owned queued delivery prompt")) (saved nil))
    (s::call-with-foothold-binding
     (lambda ()
       (dc:call-with-prompt tag
        (lambda ()
          (s::call-with-foothold-binding
           (lambda ()
             (let ((input (multiple-value-list
                           (dc:abort-to-prompt tag (values :yielded)))))
               (setf (getf row :body-delivered) (getf row :delivered)
                     (getf row :input) input)
               (values-list input)))
           child t))
        (lambda (continuation marker)
          (setf saved continuation
                (getf row :marker) marker
                (getf row :handler-delivered) (getf row :delivered)))))
     parent t)
    (setf (getf row :output) (multiple-value-list (apply saved wanted))
          (getf row :after) (state))
    row))

(defun delivery-case (stage parent child &optional collect)
  (let* ((wanted (list (list :moving-value) 2 3 4 5 6 7 8))
         (row (list :stage stage :parent parent :child child :wanted wanted
                    :collect collect :callbacks 0 :delivered nil :handler-delivered nil
                    :body-delivered nil :marker nil :input nil :output nil :after nil))
         (start (s:make-event)) (entered (s:make-event)) (resume (s:make-event))
         (thread (s:make-thread
                  (lambda () (delivery-observation parent child wanted start row))
                  :name "Owned continuation delivery target")))
    (setf s::*foothold-binding-probe-target* thread
          s::*foothold-binding-probe-stage* stage
          s::*foothold-binding-probe-entered* entered
          s::*foothold-binding-probe-resume* resume)
    (unwind-protect
         (progn
           (setf (s:event-state start) t)
           (await (lambda () (s:event-state entered)))
           (assert (plusp (s::thread-inhibit-footholds thread)))
           (s:establish-thread-foothold
            thread
            (lambda ()
              (incf (getf row :callbacks))
              (setf (getf row :delivered) t)
              (when collect (i::gc :full t))
              (values 90 91 92 93 94 95 96 97)))
           (assert (zerop (getf row :callbacks)))
           (setf (s:event-state resume) t)
           (multiple-value-bind (values joined) (s:thread-join thread)
             (assert joined)
             (assert (eq (first values) row)))
           (await (lambda () (eq (s::sample-thread-state thread) :dead)))
           (setf (getf row :correct)
                 (and (= (getf row :callbacks) 1)
                      (eq (getf row :marker) :yielded)
                      (eq (getf row :handler-delivered)
                          (and (eq stage :prepared-suspension) (zerop parent)))
                      (eq (getf row :body-delivered)
                          (if (eq stage :prepared-resumption) (zerop child) t))
                      (= (length (getf row :input)) 8)
                      (= (length (getf row :output)) 8)
                      (every #'eq wanted (getf row :input))
                      (every #'eq wanted (getf row :output))
                      (equal (getf row :after) '(0 t))))
           (push row *delivery-cases*)
           (format t "~S~%" row)
           row)
      (setf (s:event-state start) t
            (s:event-state resume) t
            s::*foothold-binding-probe-target* nil
            s::*foothold-binding-probe-stage* nil
            s::*foothold-binding-probe-entered* nil
            s::*foothold-binding-probe-resume* nil))))

(defun check-delivery ()
  (setf *delivery-cases* nil)
  (delivery-case :prepared-suspension 0 0)
  (delivery-case :prepared-suspension 1 0)
  (delivery-case :prepared-resumption 0 0)
  (delivery-case :prepared-resumption 0 1)
  (assert (every (lambda (row) (getf row :correct)) *delivery-cases*) ()
          "Queued delivery did not precede unmasked continuation code.")
  :queued-continuation-delivery-tested)

(defun check-delivery-with-gc ()
  (setf *delivery-cases* nil)
  (delivery-case :prepared-suspension 0 0 t)
  (delivery-case :prepared-suspension 1 0 t)
  (delivery-case :prepared-resumption 0 0 t)
  (delivery-case :prepared-resumption 0 1 t)
  (assert (every (lambda (row) (getf row :correct)) *delivery-cases*) ()
          "Queued delivery with GC lost state or values.")
  :queued-continuation-delivery-gc-tested)
