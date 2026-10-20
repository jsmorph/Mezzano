(defpackage #:lispm-foothold-binding-test
  (:use #:cl)
  (:local-nicknames (#:s #:mezzano.supervisor)
                    (#:i #:mezzano.internals)
                    (#:dc #:mezzano.delimited-continuations))
  (:export #:run))
(in-package #:lispm-foothold-binding-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))
(defvar *case* nil)
(defvar *cases* nil)

(defun await (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 10 internal-time-units-per-second))))
    (loop until (funcall predicate)
          do (assert (< (get-internal-real-time) deadline))
             (s:thread-yield))))

(defun state ()
  (list (s::thread-inhibit-footholds (s:current-thread))
        (s::thread-allow-with-footholds (s:current-thread))))

(defun basic ()
  (let ((head (i::%%special-stack-pointer)) (old (state))
        (condition (make-condition 'simple-error :format-control "Owned binding error.")))
    (assert (equal '(1 2 3 4 5 6 7 8)
             (multiple-value-list
               (s::call-with-foothold-binding
                (lambda ()
                  (assert (equal (state) '(1 nil)))
                  (s::call-with-foothold-binding
                   (lambda ()
                     (assert (equal (state) '(0 t)))
                     (i::gc :full t)
                     (values 1 2 3 4 5 6 7 8))
                   0 t))
                1 nil))))
    (assert (equal (catch 'binding-exit
                     (s::call-with-foothold-binding
                      (lambda () (throw 'binding-exit '(7 8))) 1 nil))
                   '(7 8)))
    (assert (eq (handler-case
                    (s::call-with-foothold-binding
                     (lambda () (error condition)) 1 nil)
                  (error (caught) caught))
                condition))
    (assert (equal old (state)))
    (assert (eq head (i::%%special-stack-pointer)))
    (format t "PASS foothold binding normal/exceptional exits, nesting, eight values, condition identity, and moving GC.~%")))

(defun target ()
  (s:event-wait (getf *case* :start))
  (s::call-with-foothold-binding
   (lambda ()
     (unwind-protect
          (s::call-with-foothold-binding
           (lambda ()
             (setf (s:event-state (getf *case* :ready)) t)
             (s:event-wait (getf *case* :body)))
           0 t)
       (setf (getf *case* :cleanup-state) (state))))
   1 nil))

(defun interrupted-restoration (stage mode)
  (setf *case* (list :start (s:make-event) :ready (s:make-event)
                    :body (s:make-event) :entered (s:make-event)
                    :resume (s:make-event)))
  (let ((thread (s:make-thread #'target :name "Owned foothold binding target")))
    (setf (getf *case* :thread) thread
          s::*foothold-binding-probe-target* thread
          s::*foothold-binding-probe-stage* stage
          s::*foothold-binding-probe-entered* (getf *case* :entered)
          s::*foothold-binding-probe-resume* (getf *case* :resume))
    (unwind-protect
         (progn
           (setf (s:event-state (getf *case* :start)) t)
           (await (lambda () (s:event-state (getf *case* :ready))))
           (ecase mode
             (:return (setf (s:event-state (getf *case* :body)) t))
             (:terminate (s:terminate-thread thread)))
           (await (lambda () (s:event-state (getf *case* :entered))))
           (s:terminate-thread thread)
           (setf (s:event-state (getf *case* :resume)) t)
           (await (lambda () (eq (s::sample-thread-state thread) :dead)))
           (assert (equal (getf *case* :cleanup-state) '(1 nil)))
           (push (list :stage stage :mode mode :state *case*) *cases*)
           (format t "PASS restoration ~S entry ~S: enclosing cleanup inhibited.~%" stage mode))
      (setf (s:event-state (getf *case* :start)) t
            (s:event-state (getf *case* :body)) t
            (s:event-state (getf *case* :resume)) t
            s::*foothold-binding-probe-target* nil
            s::*foothold-binding-probe-stage* nil
            s::*foothold-binding-probe-entered* nil
            s::*foothold-binding-probe-resume* nil))))

(defun continuation-observation (parent child)
  (let ((tag (dc:make-prompt-tag "Owned foothold binding continuation"))
        (saved nil) (rows nil))
    (s::call-with-foothold-binding
     (lambda ()
       (dc:call-with-prompt tag
        (lambda ()
          (s::call-with-foothold-binding
           (lambda ()
             (push (list :before-suspend (state)) rows)
             (dc:abort-to-prompt tag (values :yielded))
             (push (list :after-resume (state)) rows)
             :returned)
           child t))
        (lambda (continuation marker)
          (setf saved continuation)
          (push (list :handler marker (state)) rows))))
     parent t)
    (s::call-with-foothold-binding
     (lambda ()
       (dc:call-with-prompt tag saved
        (lambda (&rest values)
          (push (list :unexpected-handler values) rows)))
       (push (list :resumer (state)) rows))
     parent t)
    (nreverse rows)))

(defun run ()
  (basic)
  (dolist (mode '(:return :terminate))
    (dolist (stage '(:before-inhibit :before-allow :before-counter :before-pop :after-pop))
      (interrupted-restoration stage mode)))
  (format t "PASS ten forced restoration interleavings.~%")
  :foothold-binding-basic-tested)
