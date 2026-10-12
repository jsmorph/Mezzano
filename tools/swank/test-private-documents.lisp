(load (merge-pathnames "debugger-client.lisp" *load-truename*))
(defpackage :lispm-private-documents-test (:use :cl :lispm-debugger-client))
(in-package :lispm-private-documents-test)

(defparameter *port* (parse-integer (or (second sb-ext:*posix-argv*) "4006")))

(defun connected (session function)
  (call-with-session session function :port *port* :seconds 120))

(defun evaluate (source)
  (call-rpc (format nil "(swank:eval-and-grab-output ~S)" source)))

(defun rejected (source)
  (assert (equal (evaluate (format nil "(handler-case (progn ~A :accepted) (error () :rejected))" source))
                 '("" ":REJECTED"))))

(defun await-job (job)
  (let ((deadline (+ (get-internal-real-time) (* 20 internal-time-units-per-second))))
    (loop for info = (request :job-information job)
          when (getf info :stops) do (error "Private-document save stopped: ~S." info)
          unless (eq (getf info :state) :running) return info
          when (> (get-internal-real-time) deadline) do (error "Private-document save timed out: ~S." info)
          do (sleep 0.01))))

(defun topic-ids (result)
  (mapcar (lambda (topic) (getf topic :id)) (getf result :topics)))

(defun write-text (path text)
  (evaluate (format nil "(with-open-file (stream ~S :direction :output :if-exists :supersede)
                          (write-string ~S stream)) (values)" path text)))

(defun command-plan (source)
  (request :document-assistance source (length source) :parse))

(defun run-tests ()
  (let* ((session (make-session))
         (name (fresh-name))
         (path (format nil "SYS:HOME;PRIVATE-TEST-~A.PSB" name))
         (unicode-path nil)
         (ids '("doc/debugger.md#compiler-guarantees" "doc/project-guide.md" "doc/debugger.md#compiler-guarantees"))
         (other '("doc/document-examiner.md"))
         (job nil)
         (extra-jobs nil)
         (marker (format nil "PRIVATE-READER-~A" name)))
    (format t "Fixture session ~A, job ~A, path ~A~%" (session-name session) name path)
    (unwind-protect
         (progn
           (connected
            session
            (lambda ()
              (dolist (command '("Save Private Document" "Read Private Document"
                                 "Load Private Document" "Hardcopy Private Document"))
                (let ((plan (command-plan command)))
                  (assert (null (getf plan :error)))
                  (assert (string= (getf plan :argument) "SYS:HOME;PRIVATE.PSB"))
                  (assert (getf plan :complete-p))))
              (let* ((source "Save Private Document  ")
                     (reply (request :document-assistance source (length source) :space)))
                (assert (string= (getf reply :text) "Save Private Document SYS:HOME;PRIVATE.PSB ")))
              (let ((plan (command-plan "Read Private Document \"SYS:HOME;PRIVATE-TEST.PSB\"")))
                (assert (string= (getf plan :argument) "SYS:HOME;PRIVATE-TEST.PSB.NEWEST")))
              (send-request :save-private-document name path ids)))
           (connected
            session
            (lambda ()
              (setf job (find name (request :jobs)
                              :key (lambda (candidate) (getf (request :job-information candidate) :name))
                              :test #'equal))
              (assert job)
              (assert (equal job (request :save-private-document name path ids)))
              (assert (eq (getf (await-job job) :state) :returned))
              (assert (equal (topic-ids (request :read-private-document path)) ids))
              (evaluate (format nil "(mezzano.document-examiner:save-private-document ~S '~S) (values)" path other))
              (assert (equal job (request :save-private-document name path ids)))
              (assert (equal (topic-ids (request :read-private-document path)) other))
              (let* ((source (format nil "(cl:let ((cl:*print-case* :downcase))
                                          (swank/mezzano-debugger:request ~S :save-private-document ~S ~S '~S))"
                                     (session-name session) name path ids))
                     (reply (call-rpc source)))
                (assert (equal reply (list :ok job))))
              (let* ((source (format nil "(cl:let ((mezzano.document-examiner::*catalog*
                                                    (mezzano.document-examiner::make-catalog
                                                     :by-id (cl:make-hash-table :test 'cl:equal))))
                                          (swank/mezzano-debugger:request ~S :save-private-document ~S ~S '~S))"
                                     (session-name session) name path ids))
                     (reply (call-rpc source)))
                (assert (equal reply (list :ok job))))
              (handler-case
                  (progn (request :save-private-document name path other)
                         (error "Expected request conflict."))
                (request-error (condition)
                  (assert (eq (request-error-reason condition) :request-conflict))))))
           (connected
            session
            (lambda ()
              (rejected (format nil "(mezzano.document-examiner:save-private-document ~S '(\"unknown-private-topic-3917\"))" path))
              (assert (equal (topic-ids (request :read-private-document path)) other))
              (setf unicode-path
                    (read-from-string
                     (second (evaluate (format nil "(namestring (merge-pathnames ~S (translate-logical-pathname \"SYS:HOME;\")))"
                                               (format nil "private-🚀-~A.psb" name))))))
              (let ((unicode-job (request :save-private-document (fresh-name) unicode-path ids)))
                (push unicode-job extra-jobs)
                (assert (eq (getf (await-job unicode-job) :state) :returned))
                (assert (equal (topic-ids (request :read-private-document unicode-path)) ids)))
              (let ((empty-job (request :save-private-document (fresh-name) path nil)))
                (push empty-job extra-jobs)
                (assert (eq (getf (await-job empty-job) :state) :returned))
                (assert (null (getf (request :read-private-document path) :topics))))
              (dolist (text '("" "nil" "(:mezzano-document 2 :topics ())"
                              "(:mezzano-document 1 :topics ()) trailing"
                              "(:mezzano-document 1 :topics (\"doc/project-guide.md\" . 7))"
                              "#1=(:mezzano-document 1 :topics () . #1#)"
                              "(:mezzano-document 1 :topics #1=(\"doc/project-guide.md\" . #1#))"
                              "(:mezzano-document 1 :topics (42))"
                              "#1=(:mezzano-document 1 :topics (#1#))"
                              "(:mezzano-document 1 :topics (\"unknown-private-topic-3917\"))"))
                (write-text path text)
                (rejected (format nil "(mezzano.document-examiner:read-private-document ~S)" path)))
              (write-text path (format nil "#.(setf (symbol-value (intern ~S :cl-user)) :executed)" marker))
              (rejected (format nil "(mezzano.document-examiner:read-private-document ~S)" path))
              (assert (equal (evaluate (format nil "(boundp (intern ~S :cl-user))" marker)) '("" "NIL")))
              (format t "PASS private format, ordered and empty references, pathname defaults, Unicode path, rejected malformed/circular/trailing/reader-eval data, unread save reply, replay without rewriting or catalog lookup, and conflict.~%"))))
      (connected
       session
       (lambda ()
         (dolist (owned (append (when job (list job)) extra-jobs))
           (assert (member (getf (request :job-information owned) :state) '(:returned :aborted)))
           (request :release-job owned))
         (evaluate (format nil "(dolist (path '~S) (when (probe-file path) (delete-file path)))
                               (unintern ~S :cl-user) (values)"
                           (remove nil (list path unicode-path)) marker))
         (request :release-session))))
    (format t "PASS owned private files, jobs, marker, and session cleanup.~%")))

(run-tests)
