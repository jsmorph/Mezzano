(in-package :mezzano.debug)

(defun process-wait-description (state item)
  (case state
    ((:waiting-for-page-read :waiting-for-page-write)
     (values (if (eq state :waiting-for-page-read) :page-read :page-write)
             (if (typep item '(unsigned-byte 64))
                 (format nil "#x~X" item)
                 (bounded-display-label item))))
    (:pager-request
     (values :pager-request (if (functionp item) "[function]" (bounded-display-label item))))
    (:sleeping
     (typecase item
       (mezzano.supervisor::mutex
        (values :mutex (bounded-display-label (mezzano.supervisor::mutex-name item))))
       (mezzano.supervisor::condition-variable
        (values :condition-variable
                (bounded-display-label (mezzano.supervisor::condition-variable-name item))))
       (mezzano.supervisor::event
        (values :event (bounded-display-label (mezzano.supervisor::event-name item))))
       (mezzano.supervisor::wait-queue
        (values :wait-queue (bounded-display-label (mezzano.supervisor::wait-queue-name item))))
       ((or string symbol) (values :reason (bounded-display-label item)))
       (t (values :object "[object]"))))
    (t (values nil nil))))

(defun process-summary ()
  (let ((stops
          (with-service-lock
            (sort (loop for stop being the hash-values of *service-stops*
                        when (eq (service-stop-state stop) :stopped)
                          collect (cons (service-stop-thread stop) (service-handle stop)))
                  #'< :key (lambda (entry) (service-stop-id (service-handle-stop (cdr entry))))))))
    (list :title "Processes"
          :run-time-units-per-second internal-time-units-per-second
          :threads
          (loop for thread in (mezzano.supervisor:all-threads)
                append
                (multiple-value-bind (name state priority item run-time)
                    (mezzano.supervisor::sample-thread-information thread)
                  (unless (eq state :dead)
                    (multiple-value-bind (wait-kind wait)
                        (process-wait-description state item)
                      (list (list :name (bounded-display-label name)
                                  :state state :priority priority
                                  :wait-kind wait-kind :wait wait :run-time run-time
                                  :stops (loop for (owner . handle) in stops
                                               when (eq owner thread) collect handle))))))))))

(defun print-process-summary (summary &optional (stream *standard-output*))
  (format stream "Recorded run time uses ~D units per second.~%"
          (getf summary :run-time-units-per-second))
  (format stream "Active scheduling intervals remain uncharged until switch-out.~%")
  (format stream "Name~32TState~54TPriority~68TRun time~%")
  (dolist (row (getf summary :threads))
    (format stream "~A~32T~A~54T~A~68T~D~%"
            (getf row :name) (getf row :state) (getf row :priority) (getf row :run-time))
    (when (getf row :wait-kind)
      (format stream "  Waiting: ~A ~A~%" (getf row :wait-kind) (getf row :wait)))
    (when (getf row :stops)
      (format stream "  Debugger stops: ~{~D~^, ~}~%"
              (mapcar (lambda (handle) (service-stop-id (service-handle-stop handle)))
                      (getf row :stops)))))
  (values))
