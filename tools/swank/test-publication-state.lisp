(defpackage #:lispm-publication-state-test
  (:use #:cl)
  (:local-nicknames (#:d #:mezzano.debug) (#:i #:mezzano.internals)
                    (#:r #:mezzano.runtime) (#:s #:mezzano.supervisor)
                    (#:cp #:mezzano.command-processor))
  (:export #:capture #:check))
(in-package #:lispm-publication-state-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *state* nil)

(defun retain-table (table)
  (cons table (loop for key being the hash-keys of table using (hash-value value)
                    collect (cons key value))))

(defun check-table (saved &optional additional)
  (let ((table (car saved)) (entries (cdr saved)))
    (unless additional (assert (= (hash-table-count table) (length entries))))
    (dolist (entry entries)
      (multiple-value-bind (value present) (gethash (car entry) table)
        (assert (and present (eq value (cdr entry))))))))

(defun retain-fields (object readers)
  (list object readers (mapcar (lambda (reader) (funcall reader object)) readers)))

(defun check-fields (saved)
  (destructuring-bind (object readers values) saved
    (loop for reader in readers for expected in values
          do (assert (eq (funcall reader object) expected) ()
                     "Publication changed ~S." reader))))

(defun capture (ids expected-jobs)
  (assert (null *state*))
  (d::with-service-lock
    (assert (= (hash-table-count d::*service-stops*) (length ids)))
    (assert (= (loop for job being the hash-values of d::*evaluation-jobs*
                     count (not (eq (d::evaluation-job-state job) :released)))
               expected-jobs))
    (let ((fields nil) (tables nil) (sequences nil))
      (dolist (id ids)
        (let ((stop (gethash id d::*service-stops*)))
          (assert stop)
          (assert (null (d::service-stop-active stop)))
          (assert (null (d::service-stop-pending stop)))
          (push (retain-fields
                 stop '(d::service-stop-id d::service-stop-thread d::service-stop-condition
                        d::service-stop-restarts d::service-stop-frames d::service-stop-parent
                        d::service-stop-child d::service-stop-owner d::service-stop-state
                        d::service-stop-generation d::service-stop-next-command-id
                        d::service-stop-commands d::service-stop-pending d::service-stop-active
                        d::service-stop-event d::service-stop-current-frame
                        d::service-stop-evaluation-history d::service-stop-inspection-values
                        d::service-stop-inspection-identities d::service-stop-next-inspection-id
                        d::service-stop-evaluation-environment d::service-stop-standard-values
                        d::service-stop-standard-value-warnings))
                fields)
          (dolist (sequence (list (d::service-stop-frames stop)
                                  (d::service-stop-evaluation-history stop)
                                  (d::service-stop-standard-value-warnings stop)))
            (push (cons sequence (copy-seq sequence)) sequences))
          (dolist (table (list (d::service-stop-commands stop)
                              (d::service-stop-inspection-values stop)
                              (d::service-stop-inspection-identities stop)))
            (push (retain-table table) tables))
          (maphash
           (lambda (id command)
             (declare (ignore id))
             (push (retain-fields command
                                  '(d::service-command-boot d::service-command-operation
                                    d::service-command-argument d::service-command-io
                                    d::service-command-state d::service-command-result))
                   fields))
           (d::service-stop-commands stop))))
      (maphash
       (lambda (name job)
         (declare (ignore name))
         (unless (eq (d::evaluation-job-state job) :released)
           (push (retain-fields
                 job '(d::evaluation-job-name d::evaluation-job-boot d::evaluation-job-source
                       d::evaluation-job-package d::evaluation-job-input
                       d::evaluation-job-interactive-p d::evaluation-job-input-stream
                       d::evaluation-job-thread d::evaluation-job-output-stream
                       d::evaluation-job-values d::evaluation-job-representations
                       d::evaluation-job-listener d::evaluation-job-listener-result
                       d::evaluation-job-interrupt-ready-p d::evaluation-job-interrupt
                       d::evaluation-job-next-interrupt-id d::evaluation-job-interrupts
                       d::evaluation-job-state))
                fields)
          (push (retain-table (d::evaluation-job-interrupts job)) tables)
          (dolist (sequence (list (d::evaluation-job-name job) (d::evaluation-job-source job)
                                  (d::evaluation-job-input job)
                                  (d::evaluation-job-representations job)
                                  (d::evaluation-output-buffer (d::evaluation-job-output-stream job))))
            (push (cons sequence (copy-seq sequence)) sequences))
          (let ((input (d::evaluation-job-input-stream job)))
            (when (typep input 'd::evaluation-input-stream)
              (push (retain-fields input
                                   '(d::evaluation-input-buffer d::evaluation-input-position
                                     d::evaluation-input-eof-p d::evaluation-input-waiting-readers
                                     d::evaluation-input-event))
                    fields)
              (let ((buffer (d::evaluation-input-buffer input)))
                (push (cons buffer (copy-seq buffer)) sequences))))))
       d::*evaluation-jobs*)
      (setf *state*
            (list :boot (s:current-boot-id) :fields fields :tables tables :sequences sequences
                  :registry (list (retain-table d::*service-stops*)
                                  (retain-table d::*evaluation-jobs*))
                  :sessions (retain-table swank/mezzano-debugger::*sessions*)
                  :special-forms (retain-table mezzano.full-eval::*special-forms*)
                  :globals
                  (loop for name in
                        '(i::*debugger-depth* i::*global-debugger*
                          i::*trace-print-length* i::*trace-print-level* i::*llf-architecture*
                          i::*parallel-compile-file-dots-per-line* i::*type-info* i::*eval-hook*
                          mezzano.compiler::*optimize-policy* mezzano.compiler::*perform-tce*
                          d::*service-lock* d::*service-stops* d::*evaluation-jobs*
                          d::*clear-evaluation-lock* mezzano.full-eval::*special-forms*
                          swank/mezzano-debugger::*sessions* swank/mezzano-debugger::*lock*)
                        collect (list name (r::symbol-global-value-cell name)
                                      (i::symbol-global-value name)))
                  :functions
                  (loop for name in
                        '(cl-user::complete cl-user::curl r::%symbol-value-cell-by-cell
                          r::%symbol-value-cell-from-stack r::clear-symbol-binding-cache
                          r::call-with-special-binding-interval)
                        collect (cons name (fdefinition name)))
                  :source-roots (copy-tree (logical-pathname-translations "SYS"))
                  :commands (copy-tree cp::*commands*)
                  :debugger-commands (copy-tree cp::*debugger-commands*)))))
  (check)
  t)

(defun check (&key after-boot allow-additional)
  (assert *state*)
  (assert (eq (not (eq (getf *state* :boot) (s:current-boot-id))) after-boot))
  (d::with-service-lock
    (dolist (saved (getf *state* :fields)) (check-fields saved))
    (dolist (saved (getf *state* :tables)) (check-table saved))
    (dolist (saved (getf *state* :registry)) (check-table saved allow-additional))
    (check-table (getf *state* :sessions) t)
    (check-table (getf *state* :special-forms))
    (dolist (saved (getf *state* :sequences))
      (assert (equalp (car saved) (cdr saved)))))
  (dolist (saved (getf *state* :globals))
    (destructuring-bind (name cell value) saved
      (assert (eq (r::symbol-global-value-cell name) cell))
      (assert (eq (i::symbol-global-value name) value))))
  (dolist (saved (getf *state* :functions))
    (assert (eq (fdefinition (car saved)) (cdr saved))))
  (assert (equal (logical-pathname-translations "SYS") (getf *state* :source-roots)))
  (loop for saved in (getf *state* :commands)
        do (assert (equal saved (find (getf saved :id) cp::*commands*
                                     :key (lambda (entry) (getf entry :id))))))
  (loop for saved in (getf *state* :debugger-commands)
        do (assert (equal saved (find (getf saved :id) cp::*debugger-commands*
                                     :key (lambda (entry) (getf entry :id))))))
  (format t "PASS preserved publication records, jobs, buffers, application functions, globals, roots and prior commands; boot changed ~S.~%" after-boot)
  t)
