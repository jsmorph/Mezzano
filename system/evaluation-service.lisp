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
   (waiting-readers :initform 0 :accessor evaluation-input-waiting-readers)
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

(defun evaluation-input-waiting-p (stream)
  (plusp (evaluation-input-waiting-readers stream)))

(defmethod mezzano.gray:stream-read-char ((stream evaluation-input-stream))
  (loop
    (let ((waiting nil))
      (unwind-protect
           (let ((character
                   (with-service-lock
                     (or (read-evaluation-character stream)
                         (progn
                           (setf (mezzano.supervisor:event-state
                                  (evaluation-input-event stream)) nil)
                           (incf (evaluation-input-waiting-readers stream))
                           (setf waiting t)
                           nil)))))
             (when character (return character))
             (mezzano.supervisor:event-wait (evaluation-input-event stream)))
        (with-service-lock
          (when waiting
            (decf (evaluation-input-waiting-readers stream))))))))

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

(defun evaluation-job-interruptible-p (job)
  (let ((interrupt (evaluation-job-interrupt job))
        (stop (service-thread-current-stop (evaluation-job-thread job))))
    (and (eq (evaluation-job-state job) :running)
         (or (null stop) (service-stop-active stop))
         (or (null interrupt)
             (and (eq (evaluation-interrupt-state interrupt) :running)
                  stop
                  (service-stop-active stop)))
         t)))

(defun deliver-evaluation-interrupt (job interrupt &optional previous)
  (let ((entered-p nil)
        (returned-p nil))
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
                     ((and *service-current-stop*
                           (not (and *service-current-command*
                                     (eq *service-current-command*
                                         (service-stop-active *service-current-stop*)))))
                      (setf (evaluation-interrupt-state interrupt) :cancelled
                            (evaluation-interrupt-result interrupt) :already-stopped))
                     (t
                      (setf entered-p t
                            (evaluation-interrupt-state interrupt) :running)))))
           (when entered-p
             (restart-case
                 (service-debugger
                  (make-condition 'simple-condition
                                  :format-control (if *service-current-stop*
                                                      "Debugger command interrupted."
                                                      "Evaluation interrupted.")
                                  :format-arguments nil))
               (continue ()
                 :report "Continue the interrupted computation."
                 nil))
             (setf returned-p t)))
      (with-service-lock
        (when entered-p
          (setf (evaluation-interrupt-state interrupt)
                (if returned-p :returned :unwound)))
        (when (and (not (member (evaluation-interrupt-state interrupt)
                               '(:pending :running)))
                   (eq (evaluation-job-interrupt job) interrupt))
          (setf (evaluation-job-interrupt job)
                (when (and previous
                           (eq (evaluation-interrupt-state previous) :running))
                  previous)))))))

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
      (when (and (evaluation-job-interrupt job)
                 (not (evaluation-job-interruptible-p job)))
        (service-error :interrupt-busy))
      (when (eq (evaluation-job-thread job) (mezzano.supervisor:current-thread))
        (service-error :self-interrupt))
      (let ((interrupt (%make-evaluation-interrupt
                        :id id :boot (mezzano.supervisor:current-boot-id)))
            (previous (evaluation-job-interrupt job))
            (next-id (1+ id)))
        (when (evaluation-job-interrupt-ready-p job)
          (mezzano.supervisor:establish-thread-foothold
           (evaluation-job-thread job)
           (lambda () (deliver-evaluation-interrupt job interrupt previous))))
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

(defun start-evaluation-job (name source &key (package "CL-USER") (input "")
                                            interactive listener allow-concurrent-listener)
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
          (when (and active (eq (evaluation-job-state active) :running)
                     (not allow-concurrent-listener))
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
    (let* ((job (check-evaluation-handle handle))
           (metadata (copy-service-result (evaluation-job-listener-result job))))
      (when metadata
        (setf (getf metadata :presentations) (nreverse (getf metadata :presentations))))
      (list :name (copy-seq (evaluation-job-name job))
            :state (evaluation-job-state job)
            :listener-result metadata
            :thread (bounded-display-label
                     (mezzano.supervisor:thread-name (evaluation-job-thread job)))
            :current-boot-p (eq (evaluation-job-boot job)
                               (mezzano.supervisor:current-boot-id))
            :stops (loop for stop being the hash-values of *service-stops*
                         when (and (eq (service-stop-thread stop)
                                       (evaluation-job-thread job))
                                   (eq (service-stop-state stop) :stopped))
                           collect (service-handle stop))
            :next-interrupt-id (evaluation-job-next-interrupt-id job)
            :interruptible-p (evaluation-job-interruptible-p job)
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

(defun release-evaluation-record (job)
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
        (evaluation-job-state job) :released))

(defun release-evaluation-job (handle)
  (with-service-lock
    (release-evaluation-record (check-evaluation-handle handle)))
  (values))

(defvar *clear-evaluation-lock* (mezzano.supervisor:make-mutex 'clear-evaluations))

(defun request-evaluation-termination (job thread)
  (loop
    (case (with-service-lock
            (cond ((not (eq (evaluation-job-state job) :running)) :complete)
                  ((evaluation-job-interrupt-ready-p job) :ready)))
      (:complete (return nil))
      (:ready
       (mezzano.supervisor:terminate-thread thread)
       (return t)))
    (sleep 0.01)))

(defun clear-evaluation-history (current-job)
  (mezzano.supervisor:with-mutex (*clear-evaluation-lock*)
    (clear-evaluation-history-locked current-job)))

(defun clear-evaluation-history-locked (current-job)
  (assert (mezzano.supervisor:mutex-held-p *clear-evaluation-lock*))
  (let ((jobs nil)
        (threads nil)
        (stops nil)
        (terminated 0)
        (released-jobs 0)
        (released-stops 0)
        (stop-ids nil)
        (active-stops 0))
    (with-service-lock
      (maphash (lambda (name job)
                 (declare (ignore name))
                 (unless (or (eq job current-job)
                             (eq (evaluation-job-state job) :released))
                   (push job jobs)
                   (when (eq (evaluation-job-state job) :running)
                     (push (cons job (evaluation-job-thread job)) threads))))
               *evaluation-jobs*)
      (setf stops (loop for stop being the hash-values of *service-stops*
                        collect stop)))
    (dolist (entry threads)
      (request-evaluation-termination (car entry) (cdr entry)))
    (dolist (entry threads)
      (when (eq (mezzano.supervisor:thread-join (cdr entry))
                'mezzano.supervisor:terminate-thread)
        (incf terminated)))
    (with-service-lock
      (dolist (job jobs)
        (unless (eq (evaluation-job-state job) :released)
          (release-evaluation-record job)
          (incf released-jobs)))
      (dolist (stop (loop for stop being the hash-values of *service-stops*
                         when (or (member stop stops)
                                  (member (service-stop-thread stop) threads :key #'cdr))
                           collect stop))
        (if (eq (service-stop-state stop) :closed)
            (progn
              (push (service-stop-id stop) stop-ids)
              (release-service-stop stop)
              (incf released-stops))
            (incf active-stops))))
    (list :jobs released-jobs :stops released-stops
          :terminated terminated :active-stops active-stops
          :job-names (mapcar #'evaluation-job-name jobs) :stop-ids stop-ids)))
