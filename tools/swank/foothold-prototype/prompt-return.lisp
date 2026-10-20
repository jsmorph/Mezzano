(in-package #:lispm-foothold-binding-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *prompt-return-cases* nil)

(defun prompt-return-observation (mode mask wanted start row)
  (s:event-wait start)
  (setf (getf row :output)
        (multiple-value-list
         (s::call-with-foothold-binding
          (lambda ()
            (let* ((tag (dc:make-prompt-tag "Owned prompt return"))
                   (saved nil)
                   (output
                     (ecase mode
                       (:ordinary
                        (multiple-value-list
                         (dc:call-with-prompt
                          tag (lambda () (values-list wanted))
                          (lambda (&rest args) (error "Unexpected handler ~S" args)))))
                       (:resumed
                        (dc:call-with-prompt
                         tag (lambda () (dc:abort-to-prompt tag))
                         (lambda (continuation) (setf saved continuation)))
                        (multiple-value-list (apply saved wanted))))))
              (setf (getf row :caller-entered) t
                    (getf row :caller-delivered) (getf row :delivered)
                    (getf row :caller-values) output)
              (values-list output)))
          mask t)))
  (setf (getf row :after) (state))
  row)

(defun prompt-return-case (mode mask count collect &optional escape)
  (let* ((wanted (loop for index below count collect (list :moving-return index)))
         (row (list :mode mode :mask mask :count count :collect collect :escape escape
                    :wanted wanted :callbacks 0 :delivered nil :caller-entered nil
                    :caller-delivered nil :caller-values nil :output nil :cleanup nil :after nil))
         (start (s:make-event)) (entered (s:make-event)) (resume (s:make-event))
         (thread
           (s:make-thread
            (lambda ()
              (unwind-protect
                   (catch 'prompt-return-exit
                     (restart-case
                         (prompt-return-observation mode mask wanted start row)
                       (abort () :escaped)))
                (setf (getf row :cleanup) (state))))
            :name "Owned prompt-return delivery target")))
    (setf s::*foothold-binding-probe-target* thread
          s::*foothold-binding-probe-stage* :prepared-prompt-return
          s::*foothold-binding-probe-entered* entered
          s::*foothold-binding-probe-resume* resume)
    (unwind-protect
         (progn
           (setf (s:event-state start) t)
           (await (lambda () (s:event-state entered)))
           (assert (plusp (s::thread-inhibit-footholds thread)))
           (when (eq collect :boundaries)
             (setf s::*foothold-binding-probe-collect* thread))
           (s:establish-thread-foothold
            thread
            (lambda ()
              (incf (getf row :callbacks))
              (setf (getf row :delivered) t)
              (when collect (i::gc :full t))
              (when escape
                (ecase escape
                  (:throw (throw 'prompt-return-exit :escaped))
                  (:restart (invoke-restart 'abort))))
              (values :callback 90 91 92 93 94 95 96)))
           (assert (zerop (getf row :callbacks)))
           (setf (s:event-state resume) t)
           (multiple-value-bind (values joined) (s:thread-join thread)
             (assert joined)
             (assert (if escape (equal values '(:escaped)) (eq (first values) row))))
           (await (lambda () (eq (s::sample-thread-state thread) :dead)))
           (setf (getf row :correct)
                 (and (= (getf row :callbacks) 1)
                      (equal (getf row :cleanup) '(0 t))
                      (eq (getf row :caller-entered) (or (null escape) (= mask 1)))
                      (if (getf row :caller-entered)
                          (and (eq (getf row :caller-delivered) (zerop mask))
                               (= (length (getf row :caller-values)) count)
                               (every #'eq wanted (getf row :caller-values)))
                          (null (getf row :caller-values)))
                      (if escape
                          (null (getf row :output))
                          (and (equal (getf row :after) '(0 t))
                               (= (length (getf row :output)) count)
                               (every #'eq wanted (getf row :output))))))
           (push row *prompt-return-cases*)
           (format t "~S~%" row)
           (assert (getf row :correct) () "Prompt return failed: ~S" row)
           row)
      (setf (s:event-state start) t
            (s:event-state resume) t
            s::*foothold-binding-probe-target* nil
            s::*foothold-binding-probe-stage* nil
            s::*foothold-binding-probe-entered* nil
            s::*foothold-binding-probe-resume* nil
            s::*foothold-binding-probe-collect* nil))))

(defun check-prompt-return ()
  (setf *prompt-return-cases* nil)
  (dolist (mode '(:ordinary :resumed))
    (dolist (mask '(0 1))
      (dolist (count '(0 1 5 8))
        (dolist (collect '(nil t))
          (prompt-return-case mode mask count collect)))
      (dolist (escape '(:throw :restart))
        (dolist (collect '(nil t))
          (prompt-return-case mode mask 8 collect escape)))))
  (dolist (mode '(:ordinary :resumed))
    (dolist (mask '(0 1))
      (prompt-return-case mode mask 8 :boundaries)))
  (assert (= 52 (length *prompt-return-cases*)))
  :prompt-return-delivery-tested)
