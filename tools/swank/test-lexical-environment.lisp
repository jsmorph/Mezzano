(defpackage #:lispm-lexical-environment-test
  (:use #:cl #:mezzano.debug)
  (:local-nicknames (#:c #:mezzano.compiler) (#:d #:mezzano.debug)
                    (#:i #:mezzano.internals) (#:test #:lispm-service-test)
                    (#:x86 #:mezzano.compiler.backend.x86-64)
                    (#:arm #:mezzano.compiler.backend.arm64)
                    (#:frame #:lispm-frame-evaluation-test)
                    (#:catch-test #:lispm-catch-display-test))
  (:export #:run #:prepare-restore-test #:finish-restore-test))
(in-package #:lispm-lexical-environment-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))
(declaim (notinline scope-point))
(defvar *observer*)
(defvar *target* nil)
(defvar *cleanup-count* 0)
(defvar *fail-print* nil)
(defvar *print-count* 0)

(define-condition lexical-print-error (error) ())
(defclass print-probe () ())
(defmethod print-object ((object print-probe) stream)
  (if *fail-print*
      (progn (incf *print-count*) (error 'lexical-print-error))
      (write-string "LEXICAL-PROBE" stream)))

(defun check-emitters (scope)
  (let ((spills (make-hash-table)) (layouts (make-hash-table :test 'eq)))
    (let ((x86::*emitted-lap* nil))
      (x86::emit-debug-info nil spills layouts scope)
      (assert (eq (third (first x86::*emitted-lap*)) scope)))
    (let ((arm::*emitted-lap* nil) (arm::*callee-save-loc* nil))
      (arm::emit-debug-info nil spills layouts scope)
      (assert (eq (third (first arm::*emitted-lap*)) scope)))))

(eval-when (:compile-toplevel :load-toplevel :execute)
  (defun make-legacy-environment ()
    (let ((environment (make-instance 'c::lexical-environment)))
      (slot-makunbound environment 'c::%source-owner)
      environment)))

(defmacro saved-legacy-environment ()
  (list 'quote (make-legacy-environment)))

(defparameter *legacy-environment* (saved-legacy-environment))

(defun check-legacy-environment ()
  (assert (not (slot-boundp *legacy-environment* 'c::%source-owner)))
  (dolist (environment (list *legacy-environment*
                             (c::map-environment-bindings #'identity *legacy-environment*)
                             (c::extend-environment *legacy-environment*
                                                    :declarations '((optimize (debug 3))))))
    (assert (eq (c::debug-lexical-ancestry environment) :unknown))
    (assert (eq (getf (c::debug-source-scope environment) :lexical-environment) :unknown)))
  (assert (not (slot-boundp *legacy-environment* 'c::%source-owner))))

(defun check-metadata ()
  (let* ((a (gensym)) (b (gensym)) (current (gensym))
         (outer (make-instance 'c::lexical-variable :name 'x
                              :plist (list 'c::source-owner a)))
         (inner (make-instance 'c::lexical-variable :name 'x
                              :plist (list 'c::source-owner b)))
         (own (make-instance 'c::lexical-variable :name 'x
                            :plist (list 'c::source-owner current)))
         (function (make-instance 'c::lexical-variable :name 'x
                                 :plist (list 'c::source-owner a
                                              'c::debug-name '(function x))))
         (env (c::extend-environment
               (c::extend-environment
                (c::extend-environment nil :variables (list (list 'x outer))
                                          :functions (list (list 'x function)))
                :variables (list (list 'x inner)))
               :variables (list (list 'x own)))))
    (assert (eq (c::debug-lexical-ancestry env) :unknown))
    (setf (slot-value env 'c::%source-owner) current)
    (let ((expected (mapcar #'c::debug-variable-identity (list inner outer function))))
      (let ((scope (c::debug-source-scope env)))
        (assert (equal (getf scope :lexical-environment) expected))
        (check-emitters scope))
      (dolist (clone (list (c::extend-environment env :declarations '((optimize (debug 3))))
                          (c::map-environment-bindings #'identity env)))
        (assert (eq (slot-value clone 'c::%source-owner) current))
        (assert (equal (c::debug-lexical-ancestry clone) expected)))
      (let* ((c::*replacements* nil)
             (clone (c::map-environment-bindings #'c::copy-variable env))
             (copied (c::debug-lexical-ancestry clone)))
        (assert (equal (mapcar #'i::debug-binding-name copied) '(x x (function x))))
        (assert (every (lambda (left right) (not (eq left right))) copied expected))))
    (remf (c::lexical-variable-plist inner) 'c::source-owner)
    (assert (eq (c::debug-lexical-ancestry env) :unknown)))
  (let ((empty (make-instance 'c::lexical-environment)))
    (setf (slot-value empty 'c::%source-owner) (gensym))
    (assert (null (c::debug-lexical-ancestry empty)))))

(defun scope-point (point)
  (funcall *observer* point))

(declaim (inline inline-probe))
(defun inline-probe (own)
  (scope-point :inline)
  own)

(defmacro source-probe-body ()
  '(progn
     (scope-point :native)
     (inline-probe own)
     (let ((ancestor 31))
       ((lambda ()
          (declare (mezzano.internals::lambda-name lifted-probe))
          (scope-point :lifted)
          ancestor)))))

(defun source-probe (own)
  (source-probe-body))

(defun check-source-observation (frame point debug)
  (let ((raw (i::frame-raw-data frame)))
    (multiple-value-bind (function offset) (i::function-from-frame raw)
      (let* ((scope (i::source-scope-at-offset function offset))
             (bindings (getf scope :lexical-environment :unknown)))
        (assert (not (eq bindings :unknown)) () "~S" scope)
        (ecase point
          ((:native :inline) (assert (null bindings) () "~S" bindings))
          (:lifted
           (let ((binding (find 'ancestor bindings :key #'i::debug-binding-name)))
             (assert binding () "~S" bindings)
             (when (= debug 3)
               (let ((local (find binding (i::frame-locals raw) :key #'fifth)))
                 (assert local)
                 (multiple-value-bind (value available)
                     (i::read-frame-slot raw (third local) (fourth local))
                   (assert (and available (= value 31)))))))))))))

(defun check-source-owners (&optional (target #'source-probe) (debug 3))
  (let* ((observations nil)
         (*observer*
           (lambda (point)
             (let ((seen nil))
               (map-backtrace
                (lambda (frame)
                  (when (and (not seen)
                             (let ((function (nth-value 1 (frame-function frame))))
                               (or (eq function target)
                                   (and (eq point :inline) (eq function #'inline-probe))
                                   (and (eq point :lifted)
                                        (eq (i::function-name function) 'lifted-probe)))))
                    (setf seen t)
                    (push point observations)
                    (check-source-observation frame point debug))))
               (assert seen)))))
    (assert (= (funcall target 17) 31))
    (assert (equal (nreverse observations) '(:native :inline :lifted)))))

(defun make-target (ancestor printed)
  (let ((unused 41) (shadow 11))
    (declare (ignorable unused))
    (flet ((inherited-function () (+ ancestor shadow)))
      (let ((shadow 22))
        (lambda ()
          (let ((*package* (find-package :lispm-lexical-environment-test))
                (current 7))
            (flet ((reader () current))
              (unwind-protect
                   (progn
                     (break "Owned lexical-environment test.")
                     (assert (= (+ ancestor (reader)) 42))
                     (assert (= shadow 22))
                     (assert (= (inherited-function) 46))
                     (assert (typep printed 'print-probe))
                     (values 42 43))
                (incf *cleanup-count*)))))))))

(defun empty-target ()
  (break "Owned empty lexical-environment test.")
  (values 42 43))

(defun check-parser ()
  (let* ((listener (mezzano.command-processor:make-listener))
         (source ":Show Lexical Environment")
         (plan (mezzano.command-processor:assistance
                listener source (length source) :parse :context :debugger)))
    (assert (and (getf plan :complete-p) (not (getf plan :error))))
    (assert (equal (getf plan :operation) "lexical-environment"))
    (assert (null (getf plan :argument)))
    (dolist (suffix '(" 1" " :All"))
      (let ((input (concatenate 'string source suffix)))
        (assert (getf (mezzano.command-processor:assistance
                      listener input (length input) :parse :context :debugger) :error))))
    (let* ((prefix ":Show Lexical Envi")
           (reply (mezzano.command-processor:assistance
                   listener prefix (length prefix) :space :context :debugger)))
      (assert (equal (getf reply :text) (concatenate 'string source " "))))))

(defun check-empty-and-legacy (handle lease controller)
  (declare (ignore controller))
  (assert (equal (test::command handle lease :lexical-environment)
                 "This frame was not lexically called."))
  (let* ((info (i::function-debug-info #'empty-target))
         (saved (nth 10 info)))
    (unwind-protect
         (progn
           (setf (nth 10 info)
                 (loop for (offset . scope) in saved
                       collect (cons offset
                                     (if (listp scope)
                                         (let ((copy (copy-list scope)))
                                           (remf copy :lexical-environment)
                                           copy)
                                         scope))))
           (assert (equal (test::command handle lease :lexical-environment)
                          "Lexical ancestry unavailable.")))
      (setf (nth 10 info) saved))
    (assert (equal (test::command handle lease :lexical-environment)
                   "This frame was not lexically called."))))

(defun check-output (handle lease controller)
  (frame::evaluate-source handle lease "(values 17 18)" '("17" "18"))
  (let* ((stop (d::service-handle-stop handle))
         (history (copy-list (d::service-stop-evaluation-history stop)))
         (selected (d::service-stop-current-frame stop))
         (id (getf (debugger-stop-information handle) :next-command-id)))
    (test::expect-error :unexpected-argument
                        (lambda () (submit-debugger-command lease id :lexical-environment t)))
    (assert (= id (getf (debugger-stop-information handle) :next-command-id)))
    (let ((text (test::command handle lease :lexical-environment)))
      (dolist (row '("Lexically inherited variables:" "  ANCESTOR: 35"
                     "  SHADOW: 22" "  SHADOW: 11" "  UNUSED: [unavailable]" "  PRINTED: LEXICAL-PROBE"
                     "  (FUNCTION INHERITED-FUNCTION): #<"))
        (assert (search row text) () "~S missing ~S." text row))
      (assert (not (search "  CURRENT:" text)) () "~S" text)
      (assert (not (search "(FUNCTION READER)" text)) () "~S" text)
      (mezzano.extensions:gc :full t)
      (let ((after (test::command handle lease :lexical-environment)))
        (dolist (row '("  ANCESTOR: 35" "  SHADOW: 22" "  SHADOW: 11"
                       "  UNUSED: [unavailable]" "  PRINTED: LEXICAL-PROBE"
                       "  (FUNCTION INHERITED-FUNCTION): #<"))
          (assert (search row after) () "~S missing ~S." after row))
        (assert (not (search "  CURRENT:" after)))
        (assert (not (search "(FUNCTION READER)" after))))
      (submit-debugger-command lease id :lexical-environment)
      (assert (equal text (getf (test::completed-command handle id) :result))))
    (assert (equal history (d::service-stop-evaluation-history stop)))
    (assert (= selected (d::service-stop-current-frame stop))))
  (frame::evaluate-source handle lease "(progn (setf *fail-print* t) 0)" '("0"))
  (let* ((stop (d::service-handle-stop handle))
         (history (copy-list (d::service-stop-evaluation-history stop)))
         (selected (d::service-stop-current-frame stop))
         (id (getf (debugger-stop-information handle) :next-command-id))
         (child nil))
    (unwind-protect
         (progn
           (submit-debugger-command lease id :lexical-environment)
           (setf child (test::await (lambda () (getf (debugger-stop-information handle) :child))))
           (assert (typep (d::service-stop-condition (d::service-handle-stop child))
                          'lexical-print-error)))
      (when child (frame::release-test-stop child controller)))
    (assert (eq (getf (test::completed-command handle id) :state) :unwound))
    (submit-debugger-command lease id :lexical-environment)
    (assert (= *print-count* 1))
    (assert (= selected (d::service-stop-current-frame stop)))
    (assert (equal history (d::service-stop-evaluation-history stop))))
  (frame::evaluate-source handle lease "(progn (setf *fail-print* nil) 0)" '("0"))
  (assert (search "  PRINTED: LEXICAL-PROBE" (test::command handle lease :lexical-environment))))

(defun run ()
  (check-metadata)
  (check-legacy-environment)
  (mezzano.extensions:gc :full t)
  (check-legacy-environment)
  (check-source-owners)
  (dolist (debug '(0 3))
    (dolist (compilation-speed '(1 3))
      (let ((c::*optimize-policy* (list 'debug debug 'safety 3 'speed 1
                                       'compilation-speed compilation-speed)))
        (multiple-value-bind (target warnings failure)
            (compile nil '(lambda (own) (source-probe-body)))
          (assert (and target (not warnings) (not failure)))
          (check-source-owners target debug)))))
  (check-parser)
  (catch-test::run-target "(lispm-lexical-environment-test::empty-target)"
                          #'empty-target #'check-empty-and-legacy)
  (setf *cleanup-count* 0 *fail-print* nil *print-count* 0
        *target* (make-target 35 (make-instance 'print-probe)))
  (unwind-protect
       (catch-test::run-target "(funcall lispm-lexical-environment-test::*target*)"
                               (i::%closure-function *target*) #'check-output)
    (setf *target* nil *fail-print* nil))
  (assert (= *cleanup-count* 1))
  (format t "PASS lexical ancestry ownership, shadowing, copying, inlining, native scope/storage identities, no-argument parsing, empty/legacy metadata, unavailable values, replay, history, selection, printer child Abort/repair, full GC, continuation, cleanup, and release.~%")
  t)

(defvar *restore-thread* nil)
(defvar *restore-handle* nil)
(defvar *restore-view* nil)
(defvar *restore-result* nil)

(defun prepare-restore-test ()
  (assert (and (null *restore-thread*) (null *target*)))
  (setf *cleanup-count* 0 *print-count* 0 *fail-print* nil
        *restore-result* nil
        *target* (make-target 35 (make-instance 'print-probe))
        *restore-thread*
        (mezzano.supervisor:make-thread
         (lambda ()
           (call-with-debugger-service
            (lambda ()
              (with-simple-restart (abort "Abort the owned lexical restoration test.")
                (setf *restore-result* (multiple-value-list (funcall *target*)))))))
         :name "Lexical ancestry restoration test")
        *restore-handle*
        (test::await (lambda () (test::stop-for-thread "Lexical ancestry restoration test"))))
  (let* ((controller (make-debugger-controller))
         (lease (attach-debugger-stop *restore-handle* controller)))
    (unwind-protect
         (progn
           (frame::select-function *restore-handle* lease (i::%closure-function *target*))
           (frame::evaluate-source *restore-handle* lease "(values 17 18)" '("17" "18"))
           (let ((id (getf (debugger-stop-information *restore-handle*) :next-command-id))
                 (stop (d::service-handle-stop *restore-handle*)))
             (setf *restore-view*
                   (list :command id
                         :text (test::command *restore-handle* lease :lexical-environment)
                         :index (d::service-stop-current-frame stop)
                         :history (copy-list (d::service-stop-evaluation-history stop))))))
      (close-debugger-controller controller)))
  (format t "Prepared inherited bindings, selection, history, and retained text for restoration.~%")
  t)

(defun finish-restore-test ()
  (test::expect-error :expired-stop (lambda () (debugger-stop-information *restore-handle*)))
  (let* ((controller (make-debugger-controller))
         (handle (test::stop-for-thread "Lexical ancestry restoration test"))
         (lease (attach-debugger-stop handle controller)))
    (unwind-protect
         (progn
           (assert (= (getf (debugger-stop-information handle) :id)
                      (d::service-stop-id (d::service-handle-stop *restore-handle*))))
           (let* ((stop (d::service-handle-stop handle))
                  (id (getf *restore-view* :command))
                  (old (debugger-command-result handle id)))
             (assert (eq (getf old :state) :returned))
             (assert (not (getf old :current-boot-p)))
             (assert (equal (getf old :result) (getf *restore-view* :text)))
             (assert (= (d::service-stop-current-frame stop) (getf *restore-view* :index)))
             (assert (equal (d::service-stop-evaluation-history stop) (getf *restore-view* :history)))
             (test::expect-error :request-conflict
                                 (lambda () (submit-debugger-command lease id :lexical-environment))))
           (check-output handle lease controller)
           (let ((id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id :proceed)
             (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
           (test::await (lambda () (nth-value 1 (mezzano.supervisor:thread-join *restore-thread* nil))))
           (assert (equal *restore-result* '(42 43)))
           (assert (= *cleanup-count* 1))
           (release-debugger-stop lease)
           (setf handle nil *target* nil *restore-thread* nil *restore-handle* nil
                 *restore-view* nil *restore-result* nil *fail-print* nil)
           (format t "PASS restored lexical ancestry, selection/history, retained text, old-handle expiry, prior-boot replay rejection, fresh values, GC, printer child Abort/repair, continuation, cleanup, and release.~%")
           t)
      (when handle (frame::release-test-stop handle controller))
      (close-debugger-controller controller))))
