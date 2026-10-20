(in-package #:lispm-foothold-binding-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *saved-binding-cases* nil)

(defun saved-binding-worker (depth row ready go)
  (unwind-protect
       (s::call-with-foothold-binding
        (lambda ()
          (let ((outer (dc:make-prompt-tag "Saved binding outer prompt")))
            (flet ((capture ()
                     (s::call-with-foothold-binding
                      (lambda ()
                        (let ((input (multiple-value-list (dc:abort-to-prompt outer))))
                          (setf (getf row :body-values) input
                                (getf row :body-state) (state)
                                (getf row :body-callbacks) (getf row :callbacks))
                          (values-list input)))
                      0 t)))
              (dc:call-with-prompt
               outer
               (lambda ()
                 (ecase depth
                   (1 (capture))
                   (2 (dc:call-with-prompt
                       (dc:make-prompt-tag "Saved binding inner prompt")
                       #'capture
                       (lambda (&rest args) (error "Unexpected saved handler ~S" args))))))
               (lambda (continuation) (setf (getf row :saved) continuation))))
            (setf (getf row :waiting-state) (state)
                  (s:event-state ready) t)
            (s:event-wait go)
            (setf (getf row :output)
                  (multiple-value-list (apply (getf row :saved) (getf row :wanted)))
                  (getf row :resumer-state) (state))
            row))
        1 nil)
    (setf (getf row :cleanup) (state))))

(defun prepare-saved-bindings ()
  (assert (null *saved-binding-cases*))
  (dolist (depth '(1 2))
    (let* ((ready (s:make-event)) (go (s:make-event))
           (row (list :depth depth :saved nil
                      :wanted (loop for index below 8 collect (list :saved-moving depth index))
                      :callbacks 0 :callback-state nil :waiting-state nil
                      :body-values nil :body-state nil :body-callbacks nil
                      :output nil :resumer-state nil :cleanup nil))
           (thread (s:make-thread
                    (lambda () (saved-binding-worker depth row ready go))
                    :name (format nil "Owned saved binding depth ~D" depth))))
      (s:event-wait ready)
      (assert (equal (getf row :waiting-state) '(1 nil)))
      (assert (dc:resumable-p (getf row :saved)))
      (s:establish-thread-foothold
       thread
       (lambda ()
         (incf (getf row :callbacks))
         (setf (getf row :callback-state) (state))
         (i::gc :full t)
         (values :ignored 2 3 4 5 6 7 8)))
      (assert (zerop (getf row :callbacks)))
      (push (list :row row :thread thread :go go) *saved-binding-cases*)))
  :captured-bindings-and-callbacks-ready)

(defun check-saved-bindings ()
  (assert (= (length *saved-binding-cases*) 2))
  (dolist (case *saved-binding-cases*)
    (let* ((row (getf case :row)) (thread (getf case :thread))
           (wanted (getf row :wanted)))
      (assert (dc:resumable-p (getf row :saved)))
      (assert (zerop (getf row :callbacks)))
      (assert (= (length (s::thread-pending-footholds thread)) 1))
      (assert (= (s::thread-inhibit-footholds thread) 1))
      (assert (null (s::thread-allow-with-footholds thread)))
      (setf (s:event-state (getf case :go)) t)
      (multiple-value-bind (values joined) (s:thread-join thread)
        (assert joined)
        (assert (eq (first values) row)))
      (await (lambda () (eq (s::sample-thread-state thread) :dead)))
      (assert (= (getf row :callbacks) 1))
      (assert (= (getf row :body-callbacks) 1))
      (assert (equal (getf row :callback-state) '(0 t)))
      (assert (equal (getf row :body-state) '(0 t)))
      (assert (equal (getf row :resumer-state) '(1 nil)))
      (assert (equal (getf row :cleanup) '(0 t)))
      (dolist (values (list (getf row :body-values) (getf row :output)))
        (assert (= (length values) 8))
        (assert (every #'eq wanted values)))
      (format t "~S~%" row)))
  :captured-bindings-and-callbacks-restored)
