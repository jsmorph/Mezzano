(defpackage #:lispm-arglist-test
  (:use #:cl #:mezzano.debug)
  (:local-nicknames (#:d #:mezzano.debug) (#:i #:mezzano.internals)
                    (#:test #:lispm-service-test) (#:frame #:lispm-frame-evaluation-test))
  (:export #:run))
(in-package #:lispm-arglist-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun target (required &optional (optional 11 optional-p) &rest rest
                       &key (key 13 key-p) &allow-other-keys &aux (aux 15))
  (break "Owned argument-list test.")
  (list required optional optional-p rest key key-p aux))

(defun zero-target ()
  (break "Owned empty argument-list test.")
  42)

(defun unavailable-target ()
  (break "Owned missing-metadata test.")
  42)

(defun run-case (name source expected signature &optional replace-p)
  (let* ((function (fdefinition name))
         (controller (make-debugger-controller))
         (job (start-evaluation-job
               (string-downcase (format nil "~32,'0X~32,'0X" (get-universal-time)
                                        (random most-positive-fixnum)))
               source :package "LISPM-ARGLIST-TEST"))
         (handle nil) (lease nil))
    (unwind-protect
         (progn
           (setf handle (test::await (lambda () (first (getf (evaluation-job-information job) :stops))))
                 lease (attach-debugger-stop handle controller))
           (frame::select-function handle lease function)
           (when (i::function-debug-info function)
             (frame::evaluate-source handle lease "37" '("37")))
           (let* ((stop (d::service-handle-stop handle))
                  (history (copy-list (d::service-stop-evaluation-history stop)))
                  (index (getf (debugger-stop-information handle) :current-frame))
                  (id (getf (debugger-stop-information handle) :next-command-id)))
             (test::expect-error :unexpected-argument
                                 (lambda () (submit-debugger-command lease id :arglist 0)))
             (assert (= id (getf (debugger-stop-information handle) :next-command-id)))
             (let ((result (test::command handle lease :arglist)))
               (assert (search signature result) () "~S" result)
               (when replace-p
                 (setf (fdefinition name) (compile nil '(lambda (replacement) replacement)))
                 (assert (not (eq function (fdefinition name)))))
               (mezzano.extensions:gc :full t)
               (assert (equal result (test::command handle lease :arglist)))
               (submit-debugger-command lease id :arglist)
               (assert (equal result (getf (test::completed-command handle id) :result))))
             (assert (equal history (d::service-stop-evaluation-history stop)))
             (assert (= index (getf (debugger-stop-information handle) :current-frame))))
           (let ((id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id :proceed)
             (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
           (let ((info (test::await
                        (lambda ()
                          (let ((info (evaluation-job-information job)))
                            (unless (eq (getf info :state) :running) info))))))
             (assert (eq (getf info :state) :returned))
             (assert (equal (getf info :values) expected) () "~S" info))
           (release-debugger-stop lease)
           (setf handle nil)
           (release-evaluation-job job)
           (setf job nil))
      (setf (fdefinition name) function)
      (when handle (frame::release-test-stop handle controller))
      (when job
        (test::await (lambda () (not (eq (getf (evaluation-job-information job) :state) :running))))
        (release-evaluation-job job))
      (close-debugger-controller controller)))
  t)

(defun run ()
  (let* ((listener (mezzano.command-processor:make-listener))
         (source ":Show Arglist")
         (plan (mezzano.command-processor:assistance
                listener source (length source) :parse :context :debugger)))
    (assert (and (getf plan :complete-p) (not (getf plan :error))))
    (assert (equal (getf plan :operation) "arglist"))
    (assert (null (getf plan :argument)))
    (let* ((source ":Show Argl")
           (reply (mezzano.command-processor:assistance
                   listener source (length source) :space :context :debugger)))
      (assert (equal (getf reply :text) ":Show Arglist "))))
  (run-case 'target "(target 1 2 :key 3)" '("(1 2 T (:KEY 3) 3 T 15)")
            "(REQUIRED &OPTIONAL (OPTIONAL 11 OPTIONAL-P) &REST REST &KEY (KEY 13 KEY-P) &ALLOW-OTHER-KEYS &AUX (AUX 15))"
            t)
  (run-case 'zero-target "(zero-target)" '("42") " is NIL.")
  (let* ((function #'unavailable-target) (info (i::function-debug-info function)))
    (unwind-protect
         (progn
           (setf (i::function-pool-object function 1) nil)
           (run-case 'unavailable-target "(unavailable-target)" '("42")
                     "Argument list unavailable"))
      (setf (i::function-pool-object function 1) info)))
  (format t "PASS selected-frame argument lists, redefinition, missing metadata, GC, history, replay, continuation, and cleanup.~%")
  t)
