(in-package :mezzano.debug)

(defclass evaluation-output-stream (mezzano.gray:fundamental-character-output-stream)
  ((buffer :initform (make-array 128 :element-type 'character
                                   :adjustable t :fill-pointer 0)
           :reader evaluation-output-buffer)))

(defun check-evaluation-output (stream)
  (unless (mezzano.gray:stream-open-p stream)
    (error 'stream-error :stream stream))
  (evaluation-output-buffer stream))

(defmethod mezzano.gray:stream-write-char ((stream evaluation-output-stream) character)
  (with-service-lock
    (vector-push-extend character (check-evaluation-output stream)))
  character)

(defmethod mezzano.gray:stream-write-string
    ((stream evaluation-output-stream) string &optional (start 0) end)
  (with-service-lock
    (let ((buffer (check-evaluation-output stream)))
      (loop for index from start below (or end (length string))
            do (vector-push-extend (char string index) buffer))))
  string)

(defmethod mezzano.gray:stream-line-column ((stream evaluation-output-stream))
  (with-service-lock
    (let* ((buffer (evaluation-output-buffer stream))
           (newline (position #\Newline buffer :from-end t)))
      (- (length buffer) (if newline (1+ newline) 0)))))

(defstruct (evaluation-job (:constructor %make-evaluation-job))
  name boot source package input thread output-stream values representations
  (state :running))

(defstruct (evaluation-handle (:constructor %make-evaluation-handle (boot job)))
  (boot nil :read-only t)
  (job nil :read-only t))

(defvar *evaluation-jobs* (make-hash-table :test #'equal))

(defun evaluation-handle (job)
  (%make-evaluation-handle (mezzano.supervisor:current-boot-id) job))

(defun check-evaluation-handle (handle)
  (unless (and (evaluation-handle-p handle)
               (eq (evaluation-handle-boot handle)
                   (mezzano.supervisor:current-boot-id)))
    (service-error :expired-job))
  (let ((job (evaluation-handle-job handle)))
    (when (eq (evaluation-job-state job) :released)
      (service-error :released-job))
    job))

(defun evaluate-job-source (source)
  (with-input-from-string (stream source)
    (let ((eof (cons nil nil))
          (result nil))
      (loop for form = (read stream nil eof)
            until (eq form eof)
            do (setf result (multiple-value-list (eval form))))
      result)))

(defun run-evaluation-job (job)
  (call-with-debugger-service
   (lambda ()
     (let* ((*package* (evaluation-job-package job))
            (*readtable* (copy-readtable nil))
            (*standard-input* (make-string-input-stream (evaluation-job-input job)))
            (*standard-output* (evaluation-job-output-stream job))
            (*error-output* *standard-output*)
            (*trace-output* *standard-output*)
            (*terminal-io* (make-two-way-stream *standard-input* *standard-output*))
            (*query-io* *terminal-io*)
            (*debug-io* *terminal-io*)
            (state :unwound)
            (values nil)
            (representations nil))
       (unwind-protect
            (restart-case
                (progn
                  (setf values (evaluate-job-source (evaluation-job-source job))
                        representations (mapcar #'service-print values)
                        state :returned))
              (abort ()
                :report "Abort this evaluation job."
                (setf state :aborted
                      values nil
                      representations nil)))
         (with-service-lock
           (setf (mezzano.gray:stream-open-p (evaluation-job-output-stream job)) nil
                 (evaluation-job-values job) values
                 (evaluation-job-representations job) representations
                 (evaluation-job-state job) state)))))))

(defun start-evaluation-job (name source &key (package "CL-USER") (input ""))
  (unless (and (stringp name) (= (length name) 64)
               (every (lambda (character) (find character "0123456789abcdef")) name))
    (service-error :invalid-job-name))
  (check-type source string)
  (check-type input string)
  (let ((package (or (find-package package) (service-error :invalid-package))))
    (with-service-lock
      (let ((existing (gethash name *evaluation-jobs*)))
        (when existing
          (when (eq (evaluation-job-state existing) :released)
            (service-error :released-job))
          (unless (and (eq (evaluation-job-boot existing)
                           (mezzano.supervisor:current-boot-id))
                       (string= (evaluation-job-source existing) source)
                       (eq (evaluation-job-package existing) package)
                       (string= (evaluation-job-input existing) input))
            (service-error :request-conflict))
          (return-from start-evaluation-job (evaluation-handle existing))))
      (let ((job (%make-evaluation-job
                  :name (copy-seq name)
                  :boot (mezzano.supervisor:current-boot-id)
                  :source (copy-seq source) :package package :input (copy-seq input)
                  :output-stream (make-instance 'evaluation-output-stream))))
        (setf (evaluation-job-thread job)
              (mezzano.supervisor:make-thread
               (lambda () (run-evaluation-job job))
               :name (concatenate 'string "Evaluation " name))
              (gethash (evaluation-job-name job) *evaluation-jobs*) job)
        (evaluation-handle job)))))

(defun evaluation-jobs ()
  (with-service-lock
    (loop for job being the hash-values of *evaluation-jobs*
          unless (eq (evaluation-job-state job) :released)
            collect (evaluation-handle job))))

(defun evaluation-job-information (handle)
  (with-service-lock
    (let ((job (check-evaluation-handle handle)))
      (list :name (copy-seq (evaluation-job-name job))
            :state (evaluation-job-state job)
            :thread (mezzano.supervisor:thread-name (evaluation-job-thread job))
            :current-boot-p (eq (evaluation-job-boot job)
                               (mezzano.supervisor:current-boot-id))
            :stops (loop for stop being the hash-values of *service-stops*
                         when (and (eq (service-stop-thread stop)
                                       (evaluation-job-thread job))
                                   (eq (service-stop-state stop) :stopped))
                           collect (service-handle stop))
            :values (mapcar #'copy-seq (evaluation-job-representations job))
            :output-length (length (evaluation-output-buffer
                                    (evaluation-job-output-stream job)))))))

(defun evaluation-job-output (handle start &optional end)
  (with-service-lock
    (let* ((job (check-evaluation-handle handle))
           (buffer (evaluation-output-buffer (evaluation-job-output-stream job)))
           (end (or end (length buffer))))
      (unless (and (integerp start) (integerp end)
                   (<= 0 start end (length buffer)))
        (service-error :invalid-output-range))
      (values (subseq buffer start end) end))))

(defun evaluation-job-result-values (handle)
  (with-service-lock
    (let ((job (check-evaluation-handle handle)))
      (unless (eq (evaluation-job-state job) :returned)
        (service-error :job-not-returned))
      (copy-list (evaluation-job-values job)))))

(defun release-evaluation-job (handle)
  (with-service-lock
    (let ((job (check-evaluation-handle handle)))
      (when (eq (evaluation-job-state job) :running)
        (service-error :job-active))
      (setf (slot-value (evaluation-job-output-stream job) 'buffer) nil
            (evaluation-job-source job) nil
            (evaluation-job-package job) nil
            (evaluation-job-input job) nil
            (evaluation-job-thread job) nil
            (evaluation-job-output-stream job) nil
            (evaluation-job-values job) nil
            (evaluation-job-representations job) nil
            (evaluation-job-state job) :released)))
  (values))
