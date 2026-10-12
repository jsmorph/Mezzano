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

(defclass evaluation-input-stream
    (mezzano.gray:unread-char-mixin mezzano.gray:fundamental-character-input-stream)
  ((buffer :initform (make-array 128 :element-type 'character
                                   :adjustable t :fill-pointer 0)
           :reader evaluation-input-buffer)
   (position :initform 0 :accessor evaluation-input-position)
   (eof-p :initform nil :accessor evaluation-input-eof-p)
   (waiting-p :initform nil :accessor evaluation-input-waiting-p)
   (event :initform (mezzano.supervisor:make-event :name 'evaluation-input)
          :reader evaluation-input-event)))

(defun extend-evaluation-input (stream text)
  (let* ((buffer (evaluation-input-buffer stream))
         (start (length buffer))
         (end (+ start (length text))))
    (when (> end (array-dimension buffer 0))
      (adjust-array buffer (max end (* 2 (array-dimension buffer 0)))))
    (loop for index from 0 below (length text)
          do (setf (aref buffer (+ start index)) (char text index)))
    (setf (fill-pointer buffer) end)))

(defun read-evaluation-character (stream)
  (unless (mezzano.gray:stream-open-p stream)
    (error 'stream-error :stream stream))
  (cond ((< (evaluation-input-position stream)
            (length (evaluation-input-buffer stream)))
         (prog1 (char (evaluation-input-buffer stream)
                      (evaluation-input-position stream))
           (incf (evaluation-input-position stream))))
        ((evaluation-input-eof-p stream) :eof)
        (t nil)))

(defmethod mezzano.gray:stream-read-char ((stream evaluation-input-stream))
  (loop
    (unwind-protect
         (let ((character
                 (with-service-lock
                   (or (read-evaluation-character stream)
                       (progn
                         (setf (mezzano.supervisor:event-state
                                (evaluation-input-event stream)) nil
                               (evaluation-input-waiting-p stream) t)
                         nil)))))
           (when character (return character))
           (mezzano.supervisor:event-wait (evaluation-input-event stream)))
      (with-service-lock
        (setf (evaluation-input-waiting-p stream) nil)))))

(defmethod mezzano.gray:stream-read-char-no-hang ((stream evaluation-input-stream))
  (with-service-lock (read-evaluation-character stream)))

(defmethod mezzano.gray:stream-clear-input ((stream evaluation-input-stream))
  (with-service-lock
    (setf (evaluation-input-position stream)
          (length (evaluation-input-buffer stream))))
  nil)

(defmethod mezzano.gray:interactive-stream-p ((stream evaluation-input-stream))
  t)

(defun close-evaluation-input (stream)
  (setf (mezzano.gray:stream-open-p stream) nil)
  (when (typep stream 'evaluation-input-stream)
    (setf (mezzano.supervisor:event-state (evaluation-input-event stream)) t))
  t)

(defmethod mezzano.gray:close ((stream evaluation-input-stream) &key abort)
  (declare (ignore abort))
  (with-service-lock (close-evaluation-input stream)))

(defstruct (evaluation-job (:constructor %make-evaluation-job))
  name boot source package input interactive-p input-stream thread output-stream values representations
  listener listener-result
  interrupt-ready-p interrupt
  (next-interrupt-id 0)
  (interrupts (make-hash-table))
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

(defstruct (evaluation-interrupt (:constructor %make-evaluation-interrupt))
  id boot (state :new) result)

(defun deliver-evaluation-interrupt (job interrupt)
  (let ((entered-p nil))
    (unwind-protect
         (progn
           (with-service-lock
             (when (eq (evaluation-interrupt-state interrupt) :pending)
               (cond ((not (eq (evaluation-interrupt-boot interrupt)
                               (mezzano.supervisor:current-boot-id)))
                      (setf (evaluation-interrupt-state interrupt) :expired))
                     ((not (eq (evaluation-job-state job) :running))
                      (setf (evaluation-interrupt-state interrupt) :cancelled
                            (evaluation-interrupt-result interrupt) :job-complete))
                     ((not (evaluation-job-interrupt-ready-p job)))
                     (*service-current-stop*
                      (setf (evaluation-interrupt-state interrupt) :cancelled
                            (evaluation-interrupt-result interrupt) :already-stopped))
                     (t
                      (setf entered-p t
                            (evaluation-interrupt-state interrupt) :running))))
             (when (and (member (evaluation-interrupt-state interrupt)
                                '(:expired :cancelled))
                        (eq (evaluation-job-interrupt job) interrupt))
               (setf (evaluation-job-interrupt job) nil)))
           (when entered-p
             (restart-case
                 (service-debugger
                  (make-condition 'simple-condition
                                  :format-control "Evaluation interrupted."
                                  :format-arguments nil))
               (continue ()
                 :report "Continue evaluation."
                 nil))
             (with-service-lock
               (setf (evaluation-interrupt-state interrupt) :returned)
               (when (eq (evaluation-job-interrupt job) interrupt)
                 (setf (evaluation-job-interrupt job) nil)))))
      (when entered-p
        (with-service-lock
          (when (eq (evaluation-interrupt-state interrupt) :running)
            (setf (evaluation-interrupt-state interrupt) :unwound))
          (when (eq (evaluation-job-interrupt job) interrupt)
            (setf (evaluation-job-interrupt job) nil)))))))

(defun arm-evaluation-interrupts (job)
  (let ((interrupt
          (with-service-lock
            (setf (evaluation-job-interrupt-ready-p job) t)
            (evaluation-job-interrupt job))))
    (when interrupt (deliver-evaluation-interrupt job interrupt))))

(defun interrupt-evaluation-job (handle id)
  (with-service-lock
    (let* ((job (check-evaluation-handle handle))
           (existing (gethash id (evaluation-job-interrupts job))))
      (when existing
        (unless (eq (evaluation-interrupt-boot existing)
                    (mezzano.supervisor:current-boot-id))
          (service-error :request-conflict))
        (return-from interrupt-evaluation-job id))
      (unless (eql id (evaluation-job-next-interrupt-id job))
        (service-error :request-order))
      (unless (eq (evaluation-job-state job) :running)
        (service-error :job-complete))
      (when (evaluation-job-interrupt job)
        (service-error :interrupt-busy))
      (when (eq (evaluation-job-thread job) (mezzano.supervisor:current-thread))
        (service-error :self-interrupt))
      (let ((interrupt (%make-evaluation-interrupt
                        :id id :boot (mezzano.supervisor:current-boot-id)))
            (next-id (1+ id)))
        (when (evaluation-job-interrupt-ready-p job)
          (mezzano.supervisor:establish-thread-foothold
           (evaluation-job-thread job)
           (lambda () (deliver-evaluation-interrupt job interrupt))))
        (setf (gethash id (evaluation-job-interrupts job)) interrupt
              (evaluation-job-interrupt job) interrupt
              (evaluation-job-next-interrupt-id job) next-id
              (evaluation-interrupt-state interrupt) :pending)
        id))))

(defun evaluation-job-interrupt-result (handle id)
  (with-service-lock
    (let* ((job (check-evaluation-handle handle))
           (interrupt (or (gethash id (evaluation-job-interrupts job))
                          (service-error :unknown-interrupt))))
      (list :state (evaluation-interrupt-state interrupt)
            :current-boot-p (eq (evaluation-interrupt-boot interrupt)
                               (mezzano.supervisor:current-boot-id))
            :result (evaluation-interrupt-result interrupt)))))

(defun run-evaluation-job (job)
  (call-with-debugger-service
   (lambda ()
     (let* ((*package* (evaluation-job-package job))
            (*readtable* (copy-readtable nil))
            (*standard-input* (evaluation-job-input-stream job))
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
                (unwind-protect
                     (progn
                       (arm-evaluation-interrupts job)
                       (setf values (if (evaluation-job-listener job)
                                        (mezzano.command-processor::execute-input
                                         (evaluation-job-listener job) job (evaluation-job-source job))
                                        (evaluate-job-source (evaluation-job-source job)))
                             representations (mapcar #'service-print values)
                             state :returned))
                  (with-service-lock
                    (setf (evaluation-job-interrupt-ready-p job) nil)))
              (abort ()
                :report "Abort this evaluation job."
                (setf state :aborted
                      values nil
                      representations nil)))
         (with-service-lock
           (let ((interrupt (evaluation-job-interrupt job)))
             (when (and interrupt (eq (evaluation-interrupt-state interrupt) :pending))
               (setf (evaluation-interrupt-state interrupt) :cancelled
                     (evaluation-interrupt-result interrupt) :job-complete
                     (evaluation-job-interrupt job) nil)))
           (close-evaluation-input (evaluation-job-input-stream job))
           (setf (mezzano.gray:stream-open-p (evaluation-job-output-stream job)) nil
                 (evaluation-job-values job) values
                 (evaluation-job-representations job) representations
                 (evaluation-job-state job) state)))))))

(defun start-evaluation-job (name source &key (package "CL-USER") (input "") interactive listener)
  (unless (and (stringp name) (= (length name) 64)
               (every (lambda (character) (find character "0123456789abcdef")) name))
    (service-error :invalid-job-name))
  (check-type source string)
  (check-type input string)
  (let ((package (or (find-package package) (service-error :invalid-package)))
        (interactive (not (null interactive))))
    (with-service-lock
      (let ((existing (gethash name *evaluation-jobs*)))
        (when existing
          (when (eq (evaluation-job-state existing) :released)
            (service-error :released-job))
          (unless (and (eq (evaluation-job-boot existing)
                           (mezzano.supervisor:current-boot-id))
                       (string= (evaluation-job-source existing) source)
                       (or listener (eq (evaluation-job-package existing) package))
                       (eq (evaluation-job-listener existing) listener)
                       (string= (evaluation-job-input existing) input)
                       (eq (evaluation-job-interactive-p existing) interactive))
            (service-error :request-conflict))
          (return-from start-evaluation-job (evaluation-handle existing))))
      (when listener
        (let ((active (mezzano.command-processor::listener-job listener)))
          (when (and active (eq (evaluation-job-state active) :running))
            (service-error :listener-busy)))
        (setf package (mezzano.command-processor::listener-package listener)))
      (let ((job (%make-evaluation-job
                  :name (copy-seq name)
                  :boot (mezzano.supervisor:current-boot-id)
                  :source (copy-seq source) :package package :input (copy-seq input)
                  :interactive-p interactive :listener listener
                  :input-stream (if interactive
                                    (let ((stream (make-instance 'evaluation-input-stream)))
                                      (extend-evaluation-input stream input)
                                      stream)
                                    (make-string-input-stream (copy-seq input)))
                  :output-stream (make-instance 'evaluation-output-stream))))
        (when listener (setf (mezzano.command-processor::listener-job listener) job))
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
            :listener-result (copy-service-result (evaluation-job-listener-result job))
            :thread (mezzano.supervisor:thread-name (evaluation-job-thread job))
            :current-boot-p (eq (evaluation-job-boot job)
                               (mezzano.supervisor:current-boot-id))
            :stops (loop for stop being the hash-values of *service-stops*
                         when (and (eq (service-stop-thread stop)
                                       (evaluation-job-thread job))
                                   (eq (service-stop-state stop) :stopped))
                           collect (service-handle stop))
            :next-interrupt-id (evaluation-job-next-interrupt-id job)
            :interrupt-id (when (evaluation-job-interrupt job)
                            (evaluation-interrupt-id (evaluation-job-interrupt job)))
            :input-mode (if (evaluation-job-interactive-p job) :interactive :batch)
            :input-length (if (evaluation-job-interactive-p job)
                              (length (evaluation-input-buffer (evaluation-job-input-stream job)))
                              (length (evaluation-job-input job)))
            :input-eof-p (if (evaluation-job-interactive-p job)
                             (evaluation-input-eof-p (evaluation-job-input-stream job))
                             t)
            :input-waiting-p (and (evaluation-job-interactive-p job)
                                  (evaluation-input-waiting-p (evaluation-job-input-stream job)))
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

(defun supply-evaluation-input (handle offset text &key eof)
  (check-type text string)
  (with-service-lock
    (let* ((job (check-evaluation-handle handle))
           (stream (evaluation-job-input-stream job)))
      (unless (evaluation-job-interactive-p job)
        (service-error :input-not-interactive))
      (unless (and (integerp offset) (<= 0 offset))
        (service-error :input-conflict))
      (let* ((buffer (evaluation-input-buffer stream))
             (length (length buffer))
             (end (+ offset (length text))))
        (when (and (<= end length)
                   (string= buffer text :start1 offset :end1 end)
                   (or (not eof)
                       (and (evaluation-input-eof-p stream) (= end length))))
          (return-from supply-evaluation-input end))
        (unless (= offset length)
          (service-error :input-conflict))
        (unless (and (eq (evaluation-job-state job) :running)
                     (mezzano.gray:stream-open-p stream)
                     (not (evaluation-input-eof-p stream)))
          (service-error :input-closed))
        (extend-evaluation-input stream text)
        (when eof (setf (evaluation-input-eof-p stream) t))
        (setf (mezzano.supervisor:event-state (evaluation-input-event stream)) t)
        end))))

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
      (clrhash (evaluation-job-interrupts job))
      (when (evaluation-job-interactive-p job)
        (setf (slot-value (evaluation-job-input-stream job) 'buffer) nil))
      (setf (slot-value (evaluation-job-output-stream job) 'buffer) nil
            (evaluation-job-source job) nil
            (evaluation-job-listener job) nil
            (evaluation-job-listener-result job) nil
            (evaluation-job-package job) nil
            (evaluation-job-input job) nil
            (evaluation-job-input-stream job) nil
            (evaluation-job-thread job) nil
            (evaluation-job-output-stream job) nil
            (evaluation-job-values job) nil
            (evaluation-job-representations job) nil
            (evaluation-job-state job) :released)))
  (values))
