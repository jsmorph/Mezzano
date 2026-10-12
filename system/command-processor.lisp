(in-package :mezzano.command-processor)

(defstruct listener
  (package (find-package "CL-USER"))
  (pathname *default-pathname-defaults*)
  job)

(defparameter *commands*
  '((:name "Help" :id :help
     :help "List the supported commands. :Format Brief or Detailed selects the description."
     :keywords (("Format" :format "Brief" "Brief")))
    (:name "Set Package" :id :set-package :type :package
     :help "Select this Listener's Lisp package.")
    (:name "Show Herald" :id :show-herald
     :help "Display the guest Lisp implementation and machine information."
     :keywords (("Detailed" :boolean "No" "Yes")))
    (:name "Show Command Processor Status" :id :show-command-processor-status
     :help "Display the Listener mode, prompt, package, and pathname default.")
    (:name "Clear Output History" :id :clear-output-history
     :help "Clear the displayed transcript. Retain input history and guest jobs.")
    (:name "Show Directory" :id :show-directory :type :directory
     :help "List guest pathnames matching a directory or wildcard pathname.")
    (:name "Show File" :id :show-file :type :pathname
     :help "Display a guest text file.")
    (:name "Load File" :id :load-file :type :pathname
     :help "Load a guest file using Common Lisp LOAD.")
    (:name "Compile File" :id :compile-file :type :pathname
     :help "Compile a guest Lisp file. :Load Yes loads the result. :Binary File selects the output."
     :keywords (("Load" :boolean "No" "Yes") ("Binary File" :pathname nil nil)))))

(defparameter *debugger-commands*
  '((:name "Show Backtrace" :id :show-backtrace :help "Display retained call frames.")
    (:name "Show Proceed Options" :id :show-proceed-options :help "Display available restarts.")
    (:name "Show Frame" :id :show-frame :help "Display the selected frame and available locals. Original argument values are unavailable.")
    (:name "Show Local" :id :show-local :type :local :help "Display All locals, or a local by its zero-based decimal index.")
    (:name "Set Current Frame" :id :set-current-frame :type :frame :help "Select a zero-based frame index from Show Backtrace.")))

(define-condition input-error (error)
  ((text :initarg :text :reader input-error-text))
  (:report (lambda (condition stream) (write-string (input-error-text condition) stream))))

(defun input-error (control &rest arguments)
  (error 'input-error :text (apply #'format nil control arguments)))

(defun whitespacep (character)
  (find character '(#\Space #\Tab #\Newline #\Return)))

(defun trim-input (source)
  (string-trim '(#\Space #\Tab #\Newline #\Return) source))

(defun words (text)
  (loop with start = 0
        for end = (position #\Space text :start start)
        collect (subseq text start end)
        while end do (setf start (1+ end))))

(defun prefixp (prefix text)
  (and (<= (length prefix) (length text))
       (string-equal prefix text :end2 (length prefix))))

(defstruct lexeme value start end quoted-p)

(defun tokenize (source)
  (let ((position 0) (tokens nil))
    (loop
      (loop while (and (< position (length source)) (whitespacep (char source position)))
            do (incf position))
      (when (= position (length source)) (return (nreverse tokens)))
      (let ((start position))
        (if (char= (char source position) #\")
            (let ((*read-eval* nil))
              (handler-case
                  (multiple-value-bind (value end) (read-from-string source t nil :start position)
                    (unless (or (= end (length source)) (whitespacep (char source end)))
                      (input-error "A quoted argument must end before a space."))
                    (push (make-lexeme :value value :start start :end end :quoted-p t) tokens)
                    (setf position end))
                (reader-error () (input-error "Finish the quoted argument."))
                (end-of-file () (input-error "Finish the quoted argument."))))
            (progn
              (loop while (and (< position (length source))
                               (not (whitespacep (char source position)))) do (incf position))
              (push (make-lexeme :value (subseq source start position) :start start :end position)
                    tokens)))))))

(defun name-match-p (tokens name)
  (let ((parts (words name)))
    (loop for token in tokens for part in parts
          always (and (not (lexeme-quoted-p token)) (prefixp (lexeme-value token) part)))))

(defun find-command (tokens commands)
  (let ((matches (remove-if-not (lambda (command) (name-match-p tokens (getf command :name))) commands)))
    (values (when (= (length matches) 1) (first matches)) matches)))

(defun quote-argument (text)
  (if (or (zerop (length text))
          (char= (char text 0) #\:)
          (find-if (lambda (char) (or (whitespacep char) (find char "\",\\"))) text))
      (write-to-string text :escape t :readably t)
      text))

(defun form-input-p (source listener context)
  (let ((text (trim-input source)))
    (and (plusp (length text))
         (or (char= (char text 0) #\,)
             (and (not (alpha-char-p (char text 0))) (not (char= (char text 0) #\:)))
             (and (eq context :listener)
                  (not (find-command (tokenize text) *commands*))
                  (let ((*package* (listener-package listener)) (*read-eval* nil))
                    (handler-case
                        (multiple-value-bind (value end) (read-from-string text)
                          (and (= end (length text)) (symbolp value) (boundp value)))
                      (error () nil))))))))

(defun argument-default (type listener)
  (case type
    (:package (package-name (listener-package listener)))
    (:pathname (namestring (listener-pathname listener)))
    (:directory (namestring (make-pathname :name :wild :type :wild :version :wild
                                          :defaults (listener-pathname listener))))
    (:local "All")))

(defun argument-choices (type)
  (case type
    (:package (sort (remove-duplicates
                    (loop for package in (list-all-packages)
                          append (cons (package-name package) (copy-list (package-nicknames package))))
                    :test #'string-equal) #'string-lessp))
    (:format '("Brief" "Detailed"))
    (:boolean '("Yes" "No"))
    (:local '("All"))))

(defun argument-prompt (type default)
  (format nil "(~A~@[ [default ~A]~])"
          (case type (:package "A package") ((:pathname :directory) "pathname")
                (:format "Brief or Detailed") (:boolean "Yes or No")
                (:local "local index or All") (:frame "frame index"))
          default))

(defun parse-argument (text type listener)
  (let* ((choices (argument-choices type))
         (matches (remove-if-not (lambda (choice) (prefixp text choice)) choices))
         (exact (find text choices :test #'string-equal)))
    (when choices
      (cond (exact (setf text exact))
            ((= (length matches) 1) (setf text (first matches)))
            ((> (length matches) 1) (input-error "Ambiguous argument ~S: ~{~A~^, ~}." text matches))
            ((not (eq type :local)) (input-error "Invalid argument ~S. Expected ~{~A~^ or ~}." text choices))))
    (case type
      (:package (or (find-package text) (input-error "No package named ~S." text)))
      ((:pathname :directory) (merge-pathnames (pathname text) (listener-pathname listener)))
      (:boolean (string-equal text "Yes"))
      (:format (if (string-equal text "Detailed") :detailed :brief))
      ((:frame :local)
       (if (and (eq type :local) (string-equal text "All")) :all
           (or (and (plusp (length text)) (every #'digit-char-p text) (parse-integer text))
               (input-error "Expected a nonnegative decimal index, received ~S." text)))))))

(defun command-tokens (source)
  (let* ((text (trim-input source))
         (start (if (and (plusp (length text)) (char= (char text 0) #\:)) 1 0)))
    (tokenize (subseq text start))))

(defun parse-command (source listener context)
  (let* ((tokens (command-tokens source))
         (commands (if (eq context :debugger) *debugger-commands* *commands*)))
    (multiple-value-bind (command matches) (find-command tokens commands)
      (unless command
        (input-error (if matches "Ambiguous command. Choose ~{~A~^, ~}." "Unknown command. Available commands: ~{~A~^, ~}.")
                     (mapcar (lambda (entry) (getf entry :name)) (or matches commands))))
      (let* ((count (length (words (getf command :name))))
             (rest (nthcdr count tokens))
             (type (getf command :type))
             (argument nil)
             (keywords nil))
        (when (< (length tokens) count) (input-error "Complete the command name ~A." (getf command :name)))
        (when type
          (let ((text (if (and rest (or (lexeme-quoted-p (first rest))
                                       (not (prefixp ":" (lexeme-value (first rest))))))
                          (lexeme-value (pop rest))
                          (argument-default type listener))))
            (unless text (input-error "~A requires ~A." (getf command :name) (argument-prompt type nil)))
            (setf argument (parse-argument text type listener))))
        (loop while rest do
          (let* ((token (pop rest))
                 (text (lexeme-value token))
                 (definitions (getf command :keywords)))
            (unless (and (not (lexeme-quoted-p token)) (prefixp ":" text))
              (input-error "Unexpected argument ~S." text))
            (let* ((name-tokens (cons (make-lexeme :value (subseq text 1)) rest))
                   (matches (remove-if-not (lambda (entry) (name-match-p name-tokens (first entry))) definitions))
                   (definition (when (= (length matches) 1) (first matches))))
              (unless definition (input-error "Unknown or ambiguous keyword ~A." text))
              (let* ((name (first definition)) (count (length (words name)))
                     (type (second definition)))
                (when (< (length name-tokens) count) (input-error "Complete keyword :~A." name))
                (setf rest (nthcdr (1- count) rest))
                (when (assoc name keywords :test #'equal) (input-error "Duplicate keyword :~A." name))
                (let ((value (if (and rest (or (lexeme-quoted-p (first rest))
                                              (not (prefixp ":" (lexeme-value (first rest))))))
                                 (lexeme-value (pop rest)) (fourth definition))))
                  (unless value (input-error ":~A requires a value." name))
                  (push (cons name (parse-argument value type listener)) keywords))))))
        (dolist (definition (getf command :keywords))
          (unless (assoc (first definition) keywords :test #'equal)
            (push (cons (first definition)
                        (when (third definition) (parse-argument (third definition) (second definition) listener))) keywords)))
        (values command argument keywords)))))

(defun listener-information (listener)
  (mezzano.debug::with-service-lock
    (list :package (package-name (listener-package listener))
          :mode :command-preferred :prompt "Command: "
          :default-pathname (namestring (listener-pathname listener))
          :busy-p (and (listener-job listener)
                       (eq (mezzano.debug::evaluation-job-state (listener-job listener)) :running)))))

(defun start-listener (listener name source &key interactive)
  (mezzano.debug:start-evaluation-job name source :interactive interactive :listener listener))

(defun execute-input (listener job source)
  (let* ((*package* (listener-package listener))
         (*default-pathname-defaults* (listener-pathname listener))
         (formp (form-input-p source listener :listener))
         (metadata (list :kind (if formp :form :command) :command nil :error nil
                         :effects nil :presentations nil)))
    (setf (mezzano.debug::evaluation-job-listener-result job) metadata)
    (unwind-protect
         (if formp
             (let ((source (trim-input source)))
               (mezzano.debug::evaluate-job-source
                (if (char= (char source 0) #\,) (subseq source 1) source)))
             (handler-case
                 (multiple-value-bind (command argument keywords) (parse-command source listener :listener)
                   (setf (getf metadata :command) (getf command :id))
                   (execute-command command argument keywords listener job metadata)
                   nil)
               (input-error (condition)
                 (setf (getf metadata :error) (input-error-text condition))
                 (format t "~A~%" condition)
                 nil)))
      (mezzano.debug::with-service-lock
        (setf (listener-package listener) *package*
              (listener-pathname listener) *default-pathname-defaults*)))))

(defun present-pathname (pathname job metadata)
  (let* ((text (namestring pathname))
         (start (length (mezzano.debug::evaluation-output-buffer
                         (mezzano.debug::evaluation-job-output-stream job)))))
    (write-string text)
    (push (list :start start :end (+ start (length text)) :type :pathname :value text)
          (getf metadata :presentations))
    (terpri)))

(defun execute-command (command argument keywords listener job metadata)
  (flet ((option (name) (cdr (assoc name keywords :test #'equal))))
    (case (getf command :id)
      (:help
       (dolist (entry *commands*)
         (format t "~A~%" (getf entry :name))
         (when (eq (option "Format") :detailed) (format t "  ~A~%" (getf entry :help)))))
      (:set-package (setf *package* argument) (format t "Package: ~A~%" (package-name argument)))
      (:show-herald
       (format t "~A ~A~%" (lisp-implementation-type) (lisp-implementation-version))
       (when (option "Detailed") (format t "Machine: ~A~%Software: ~A ~A~%" (machine-type) (software-type) (software-version))))
      (:show-command-processor-status
       (format t "Mode: Command-Preferred~%Prompt: ~S~%Package: ~A~%Pathname default: ~A~%"
               "Command: " (package-name *package*) (namestring (listener-pathname listener))))
      (:clear-output-history (setf (getf metadata :effects) (list (list :operation :clear-output-history))))
      (:show-directory
       (let ((path (if (and (null (pathname-name argument)) (null (pathname-type argument)))
                       (make-pathname :name :wild :type :wild :version :wild :defaults argument) argument)))
         (dolist (entry (sort (copy-list (directory path)) #'string-lessp :key #'namestring))
           (present-pathname entry job metadata))))
      (:show-file
       (with-open-file (stream argument :direction :input)
         (loop with buffer = (make-string 4096) for count = (read-sequence buffer stream)
               while (plusp count) do (write-string buffer *standard-output* :end count)))
       (setf *default-pathname-defaults* argument))
      (:load-file (load argument :verbose t) (setf *default-pathname-defaults* argument))
      (:compile-file
       (multiple-value-bind (output warnings failure)
           (compile-file argument :output-file (or (option "Binary File") (compile-file-pathname argument)))
         (declare (ignore warnings))
         (when failure (error "Compilation failed for ~A." argument))
         (when output (present-pathname output job metadata))
         (when (and output (option "Load")) (load output :verbose t)))
       (setf *default-pathname-defaults* argument)))))

(defun debugger-plan (command argument)
  (case (getf command :id)
    (:show-backtrace (list :operation "frames"))
    (:show-proceed-options (list :operation "restarts"))
    (:show-frame (list :operation "locals" :needs-frame t :display :frame))
    (:show-local (list :operation "locals" :needs-frame t :display :locals
                       :local-index (unless (eq argument :all) argument)))
    (:set-current-frame (list :operation "locals" :needs-frame t :display :frame
                              :select-frame argument))))

(defun join-words (words)
  (format nil "~{~A~^ ~}" words))

(defun common-prefix (strings)
  (if (null strings) ""
      (subseq (first strings) 0
              (loop for index below (length (first strings))
                    while (every (lambda (text) (and (< index (length text))
                                                     (char-equal (char text index) (char (first strings) index)))) strings)
                    count t))))

(defun keyword-token-p (token)
  (and token (not (lexeme-quoted-p token)) (prefixp ":" (lexeme-value token))))

(defun argument-context (command tokens listener action trailing leader)
  (let ((rest (nthcdr (length (words (getf command :name))) tokens))
        (base (concatenate 'string leader (getf command :name) " "))
        (definitions (copy-list (getf command :keywords))))
    (labels ((state (type value default)
               (list :base base :type type :value value :default default :keywords definitions))
             (accept-value (type default)
               (let ((value (when (and rest (not (keyword-token-p (first rest))))
                              (lexeme-value (pop rest)))))
                 (when (and (null rest)
                            (or (null value) (zerop trailing) (member action '(:space :complete :insert))))
                   (return-from argument-context (state type value default)))
                 (let ((text (or value default)))
                   (unless text (input-error "An argument is required: ~A." (argument-prompt type nil)))
                   (parse-argument text type listener)
                   (setf base (concatenate 'string base (quote-argument text) " "))))))
      (when (getf command :type)
        (accept-value (getf command :type) (argument-default (getf command :type) listener)))
      (loop while rest do
        (let* ((token (pop rest))
               (text (lexeme-value token)))
          (unless (keyword-token-p token) (input-error "Unexpected argument ~S." text))
          (let* ((name-tokens (cons (make-lexeme :value (subseq text 1)) rest))
                 (matches (remove-if-not (lambda (entry) (name-match-p name-tokens (first entry)))
                                         definitions))
                 (definition (when (= (length matches) 1) (first matches)))
                 (count (when definition (length (words (first definition))))))
            (unless matches (input-error "Unknown keyword ~A." text))
            (when (or (null definition) (< (length name-tokens) count)
                      (and (= (length name-tokens) count) (zerop trailing)))
              (return-from argument-context
                (list :base base :type :keyword :matches matches
                      :word-count (+ (length name-tokens) (if (> trailing 1) 1 0)))))
            (setf definitions (remove definition definitions)
                  rest (nthcdr (1- count) rest)
                  base (concatenate 'string base ":" (first definition) " "))
            (accept-value (second definition) (fourth definition)))))
      (state nil nil nil))))

(defun assistance (listener source cursor action &key (context :listener) presentation)
  (check-type source string)
  (unless (and (integerp cursor) (<= 0 cursor (length source))) (input-error "Invalid input cursor."))
  (let* ((prefix (subseq source 0 cursor))
         (suffix (subseq source cursor))
         (text (trim-input prefix))
         (colonp (and (plusp (length text)) (char= (char text 0) #\:))))
    (labels ((reply (&rest fields)
               (append (list :kind :command :text source :cursor cursor :prompt ""
                             :default nil :expected-type nil :help "" :candidates nil
                             :complete-p nil :error nil) fields))
             (replacement (response text)
               (setf (getf response :text) (concatenate 'string text suffix)
                     (getf response :cursor) (length text))
               response)
             (candidate (label text help)
               (list :label label :text (concatenate 'string text suffix)
                     :cursor (length text) :help help)))
      (handler-case
          (progn
            (when (and (eq context :debugger) (not colonp) (plusp (length text)))
              (input-error "Begin a debugger command with a colon."))
            (when (and (eq context :listener) (form-input-p prefix listener context))
              (when (eq action :insert) (input-error "A pathname argument is not expected here."))
              (let ((response (reply)))
                (setf (getf response :kind) :form (getf response :complete-p) t)
                (return-from assistance response)))
            (when (eq action :parse)
              (multiple-value-bind (command argument keywords) (parse-command prefix listener context)
                (declare (ignore keywords))
                (let ((response (reply)))
                  (setf (getf response :complete-p) t
                        (getf response :command) (getf command :id)
                        (getf response :argument) (if (packagep argument) (package-name argument)
                                                     (if (pathnamep argument) (namestring argument) argument)))
                  (return-from assistance
                    (append response (when (eq context :debugger) (debugger-plan command argument)))))))
            (let* ((commands (if (eq context :debugger) *debugger-commands* *commands*))
                   (tokens (command-tokens prefix))
                   (trailing (- (length prefix) (length (string-right-trim '(#\Space #\Tab #\Newline #\Return) prefix))))
                   (leader (if (or colonp (eq context :debugger)) ":" "")))
              (multiple-value-bind (command matches) (find-command tokens commands)
                (unless matches (input-error "Unknown command. Use HELP to list the supported commands."))
                (let* ((count (when command (length (words (getf command :name)))))
                       (namep (or (null command) (< (length tokens) count)
                                  (and (= (length tokens) count) (zerop trailing)))))
                  (when namep
                    (when (eq action :insert) (input-error "Complete a command that accepts a pathname first."))
                    (let ((response (reply))
                          (names (mapcar (lambda (entry) (getf entry :name)) matches)))
                      (setf (getf response :prompt) "(command name)"
                            (getf response :expected-type) :command
                            (getf response :help) "SPACE completes a word. COMPLETE completes the command name."
                            (getf response :candidates)
                            (mapcar (lambda (entry)
                                      (candidate (getf entry :name)
                                                 (concatenate 'string leader (getf entry :name) " ")
                                                 (getf entry :help))) matches))
                      (when (member action '(:space :complete))
                        (let* ((word-count (+ (length tokens) (if (> trailing 1) 1 0)))
                               (options (if (eq action :space)
                                            (mapcar (lambda (name) (let ((parts (words name)))
                                                                    (join-words (subseq parts 0 (min (length parts) (max 1 word-count)))))) names)
                                            names))
                               (completion (common-prefix options)))
                          (when (plusp (length completion))
                            (replacement response (concatenate 'string leader completion
                                                               (if (every (lambda (option) (string= option completion)) options) " " ""))))))
                      (return-from assistance response)))
                  (let* ((state (argument-context command tokens listener action trailing leader))
                         (base (getf state :base))
                         (type (getf state :type))
                         (default (getf state :default))
                         (value (getf state :value))
                         (keywords (getf state :keywords)))
                    (when (eq type :keyword)
                      (let* ((matches (getf state :matches))
                             (response (reply)))
                        (setf (getf response :prompt) "(keyword)"
                              (getf response :expected-type) :keyword
                              (getf response :help) (getf command :help)
                              (getf response :candidates)
                              (mapcar (lambda (entry) (candidate (concatenate 'string ":" (first entry))
                                                                (concatenate 'string base ":" (first entry) " ") "")) matches))
                        (when (member action '(:space :complete))
                          (let* ((word-count (getf state :word-count))
                                 (names (mapcar (lambda (entry)
                                                  (let ((parts (words (first entry))))
                                                    (if (eq action :space)
                                                        (join-words (subseq parts 0 (min (length parts) word-count)))
                                                        (first entry)))) matches))
                                 (completion (common-prefix names)))
                            (when (plusp (length completion))
                              (replacement response (concatenate 'string base ":" completion
                                                                 (if (every (lambda (name) (string= name completion)) names) " " ""))))))
                        (return-from assistance response)))
                    (let* ((response (reply))
                           (choices (remove-if-not (lambda (choice) (prefixp (or value "") choice)) (argument-choices type))))
                      (setf (getf response :command) (getf command :id)
                            (getf response :expected-type) (if (eq type :directory) :pathname type)
                            (getf response :default) default
                            (getf response :prompt) (if type (argument-prompt type default) (if keywords "(keywords or RETURN)" "(RETURN)"))
                            (getf response :help) (getf command :help)
                            (getf response :candidates)
                            (if type
                                (mapcar (lambda (choice) (candidate choice (concatenate 'string base (quote-argument choice) " ") "")) choices)
                                (mapcar (lambda (entry) (candidate (concatenate 'string ":" (first entry))
                                                                  (concatenate 'string base ":" (first entry) " ") "")) keywords)))
                      (handler-case (progn (parse-command prefix listener context) (setf (getf response :complete-p) t))
                        (input-error () nil))
                      (cond
                        ((eq action :insert)
                         (unless (member type '(:pathname :directory)) (input-error "A pathname argument is not expected here."))
                         (check-type presentation string)
                         (replacement response (concatenate 'string base (quote-argument presentation) " ")))
                        ((and type (member action '(:space :complete)))
                         (let ((completion (cond ((and (null value) default (> trailing 1)) default)
                                                 ((and value choices) (or (find value choices :test #'string-equal)
                                                                         (when (= (length choices) 1) (first choices))))
                                                 ((and value (null (argument-choices type)))
                                                  (parse-argument value type listener) value))))
                           (when completion (replacement response (concatenate 'string base (quote-argument completion) " "))))))
                      (when (and (member action '(:space :complete)) (null value)
                                 (string= (getf response :text) source))
                        (replacement response base))
                      response))))))
        (input-error (condition)
          (let ((response (reply)))
            (setf (getf response :error) (input-error-text condition))
            response))))))
