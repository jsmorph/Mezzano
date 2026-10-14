(defpackage #:lispm-catch-display-test
  (:use #:cl #:mezzano.debug)
  (:local-nicknames (#:d #:mezzano.debug) (#:i #:mezzano.internals)
                    (#:r #:mezzano.runtime) (#:c #:lispm-control-records-test)
                    (#:test #:lispm-service-test) (#:frame #:lispm-frame-evaluation-test))
  (:export #:run))
(in-package #:lispm-catch-display-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun legacy-target ()
  (declare (optimize (debug 0)))
  (block i::%catch
    (flet ((exit (values) (return-from i::%catch (values-list values))))
      (let ((r::*active-catch-handlers* (vector 'legacy-tag #'exit)))
        (break "Owned legacy catch metadata test.")
        (throw 'legacy-tag (values 42 43))))))

(defun printing-target ()
  (let ((tag (make-instance 'c::printable-handler)))
    (catch tag
      (break "Owned catch-tag printer test.")
      (throw tag (values 42 43)))))

(defvar *same-name-count* 0)

(defun same-name-target (inspect)
  (block i::%catch
    (let ((outer (lambda () (return-from i::%catch (values 42 43)))))
      (multiple-value-bind (a b)
          (block i::%catch
            (funcall inspect outer
                     (lambda () (return-from i::%catch (values 41 43))))
            (error "No captured block transfer."))
        (incf *same-name-count*)
        (values (+ a 1) b)))))

(defun check-same-name-destinations ()
  (dolist (inner-p '(nil t))
    (setf *same-name-count* 0)
    (assert
     (equal
      (multiple-value-list
       (same-name-target
        (lambda (outer inner)
          (let ((outer-destination (multiple-value-list (d::service-catch-destination outer)))
                (inner-destination (multiple-value-list (d::service-catch-destination inner))))
            (assert (third outer-destination))
            (assert (third inner-destination))
            (assert (eq (first outer-destination) #'same-name-target))
            (assert (eq (first inner-destination) #'same-name-target))
            (assert (/= (second outer-destination) (second inner-destination)))
            (mezzano.extensions:gc :full t)
            (assert (equal outer-destination
                           (multiple-value-list (d::service-catch-destination outer))))
            (assert (equal inner-destination
                           (multiple-value-list (d::service-catch-destination inner))))
            (funcall (if inner-p inner outer))))))
      '(42 43)))
    (assert (= *same-name-count* (if inner-p 1 0)))))

(defun count-text (needle text)
  (loop for start = 0 then (+ position (length needle))
        for position = (search needle text :start2 start)
        while position count t))

(defun check-parser ()
  (let ((listener (mezzano.command-processor:make-listener)))
    (dolist (case '((":Show Catch Blocks" nil)
                    (":Show Catch Blocks :All" t)
                    (":Show Catch Blocks :All No" nil)
                    (":Show Catch Blocks :All Yes" t)))
      (let* ((source (first case))
             (reply (mezzano.command-processor:assistance
                     listener source (length source) :parse :context :debugger)))
        (assert (and (getf reply :complete-p) (not (getf reply :error))))
        (assert (equal (getf reply :operation) "catches"))
        (assert (eql (getf reply :argument) (second case)))))
    (let* ((source ":Show Cat")
           (reply (mezzano.command-processor:assistance
                   listener source (length source) :space :context :debugger)))
      (assert (equal (getf reply :text) ":Show Catch ")))))

(defun check-live-display (handle lease mode)
  (frame::evaluate-source handle lease "37" '("37"))
  (let* ((stop (d::service-handle-stop handle))
         (history (copy-list (d::service-stop-evaluation-history stop)))
         (index (getf (debugger-stop-information handle) :current-frame))
         (id (getf (debugger-stop-information handle) :next-command-id)))
    (dolist (argument '(0 :all "Yes" (t)))
      (test::expect-error :invalid-catch-options
                          (lambda () (submit-debugger-command lease id :catches argument))))
    (assert (= id (getf (debugger-stop-information handle) :next-command-id)))
    (assert (search "No catch blocks." (test::command handle lease :catches)))
    (let ((all (test::command handle lease :catches t)))
      (assert (= (count-text "Throwing to tag INNER-TAG" all)
                 (if (eq mode :duplicate) 2 1)))
      (unless (eq mode :duplicate)
        (assert (= (count-text "Throwing to tag OUTER-TAG" all) 1)))
      (assert (search "%CATCH at byte offset #x" all))
      (assert (search "with the values supplied to THROW." all))
      (assert (not (search "Destination unavailable." all)))
      (format t "~S catches: ~A" mode all)
      (mezzano.extensions:gc :full t)
      (assert (equal all (test::command handle lease :catches t)))
      (let ((id (getf (debugger-stop-information handle) :next-command-id)))
        (submit-debugger-command lease id :catches t)
        (let ((result (getf (test::completed-command handle id) :result)))
          (submit-debugger-command lease id :catches t)
          (assert (equal result (getf (test::completed-command handle id) :result))))))
    (assert (equal history (d::service-stop-evaluation-history stop)))
    (assert (= index (getf (debugger-stop-information handle) :current-frame)))
    (let ((owner (position #'i::%catch (d::service-stop-frames stop)
                           :key (lambda (frame) (nth-value 1 (frame-function frame))))))
      (assert owner)
      (test::command handle lease :select-frame owner)
      (let ((selected (test::command handle lease :catches)))
        (assert (= (count-text "Throwing to tag INNER-TAG" selected) 1))
        (assert (= (count-text "Throwing to tag " selected) 1)))
      (assert (= owner (getf (debugger-stop-information handle) :current-frame))))))

(defun check-legacy-display (handle lease controller)
  (declare (ignore controller))
  (let ((selected (test::command handle lease :catches)))
    (assert (search "LEGACY-TAG: Destination unavailable." selected))
    (assert (not (search "at byte offset" selected)))
    (mezzano.extensions:gc :full t)
    (assert (search "LEGACY-TAG: Destination unavailable."
                    (test::command handle lease :catches)))))

(defun check-printer-display (handle lease controller)
  (frame::evaluate-source
   handle lease
   "(progn (setf (slot-value lispm-catch-display-test::tag 'fail-p) t
                (slot-value lispm-catch-display-test::tag 'print-count) 0) 0)" '("0"))
  (let ((id (getf (debugger-stop-information handle) :next-command-id))
        (child nil))
    (unwind-protect
         (progn
           (submit-debugger-command lease id :catches t)
           (setf child (test::await (lambda () (getf (debugger-stop-information handle) :child))))
           (assert (typep (d::service-stop-condition (d::service-handle-stop child))
                          'c::handler-print-error))
           (test::command child (attach-debugger-stop child controller) :condition))
      (when child (frame::release-test-stop child controller)))
    (assert (eq (getf (test::completed-command handle id) :state) :unwound))
    (submit-debugger-command lease id :catches t))
  (frame::evaluate-source handle lease
                          "(slot-value lispm-catch-display-test::tag 'print-count)" '("1"))
  (frame::evaluate-source handle lease
                          "(setf (slot-value lispm-catch-display-test::tag 'fail-p) nil)" '("NIL"))
  (assert (search "Throwing to tag #<Printable-handler> returns to"
                  (test::command handle lease :catches t))))

(defun run-target (source function inspect &optional after)
  (let* ((controller (make-debugger-controller))
         (job (start-evaluation-job
               (string-downcase (format nil "~32,'0X~32,'0X" (get-universal-time)
                                        (random most-positive-fixnum)))
               source :package "LISPM-CONTROL-RECORDS-TEST"))
         (handle nil) (lease nil))
    (unwind-protect
         (progn
           (setf handle (test::await (lambda () (first (getf (evaluation-job-information job) :stops))))
                 lease (attach-debugger-stop handle controller))
           (frame::select-function handle lease function)
           (funcall inspect handle lease controller)
           (let ((id (getf (debugger-stop-information handle) :next-command-id)))
             (submit-debugger-command lease id :proceed)
             (assert (eq (getf (test::completed-command handle id) :state) :unwound)))
           (let ((info (test::await
                        (lambda ()
                          (let ((info (evaluation-job-information job)))
                            (unless (eq (getf info :state) :running) info))))))
             (assert (eq (getf info :state) :returned))
             (assert (equal (getf info :values) '("42" "43"))))
           (when after (funcall after))
           (release-debugger-stop lease)
           (setf handle nil)
           (release-evaluation-job job)
           (setf job nil))
      (when handle (frame::release-test-stop handle controller))
      (when job
        (test::await (lambda () (not (eq (getf (evaluation-job-information job) :state) :running))))
        (release-evaluation-job job))
      (close-debugger-controller controller))))

(defun run ()
  (check-same-name-destinations)
  (check-parser)
  (dolist (mode '(:body :duplicate))
    (setf c::*outer-handler-count* 0 c::*second-handler-count* 0 c::*cleanup-count* 0
          c::*after-body-count* 0 c::*after-inner-count* 0)
    (run-target (format nil "(application ~S)" mode) #'c::body-target
                (lambda (handle lease controller)
                  (declare (ignore controller))
                  (check-live-display handle lease mode))
                (lambda ()
                  (assert (= c::*cleanup-count* c::*after-inner-count* 1))
                  (assert (= c::*after-body-count* (if (eq mode :duplicate) 0 1))))))
  (run-target "(lispm-catch-display-test::legacy-target)" #'legacy-target #'check-legacy-display)
  (run-target "(lispm-catch-display-test::printing-target)" #'printing-target #'check-printer-display)
  (format t "PASS catch display defaults, owners, destinations, repeated tags, unavailable metadata, replay, history, selection, GC, printer Abort, multiple values, cleanup, and release.~%")
  t)
