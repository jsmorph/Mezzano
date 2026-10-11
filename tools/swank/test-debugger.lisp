(load (merge-pathnames "client.lisp" *load-truename*))

(defpackage #:lispm-debugger-client-test (:use #:cl #:lispm-swank-client))
(in-package #:lispm-debugger-client-test)

(defvar *stop* nil)
(defvar *debug-returned* nil)

(defun request (stream id form &optional (thread t))
  (send-packet stream
               (format nil "(:emacs-rex ~A ~S ~S ~D)"
                       form "CL-USER" thread id)))

(defun event (stream)
  (loop for message = (receive-message stream)
        do (case (first message)
             (:ping
              (send-packet stream
                           (format nil "(:emacs-pong ~D ~S)"
                                   (second message) (third message))))
             (:write-string (write-string (second message)))
             ((:new-package :new-features :indentation-update :debug-activate))
             (:debug-return
              (setf *debug-returned* t *stop* nil))
             (otherwise (return message)))))

(defun result (stream id &optional abandoned-id)
  (loop for message = (event stream)
        do (assert (eq (first message) :return) () "Unexpected event: ~S" message)
           (cond ((eql (third message) id)
                  (assert (eq (first (second message)) :ok)
                          () "Request failed: ~S" message)
                  (return (second (second message))))
                 (t
                  (assert (eql (third message) abandoned-id)
                          () "Unexpected reply: ~S" message)))))

(defun evaluate (stream id source &optional (thread t))
  (request stream id (format nil "(swank:eval-and-grab-output ~S)" source) thread)
  (result stream id))

(defun run-test (stream)
  (loop for form in '("(swank:swank-require :swank-repl)"
                     "(swank-repl:create-repl nil)")
        for id from 1
        do (request stream id form)
           (result stream id))
  (evaluate stream 3
            "(load (compile-file \"SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-FIXTURE.LISP\"))")
  (request stream 10
           "(swank:eval-and-grab-output \"(lispm-debugger-test::call-missing 111 222)\")")
  (let ((message (event stream)))
    (assert (eq (first message) :debug) () "Expected debugger entry: ~S" message)
    (setf *stop* message)
    (assert (search "MISSING" (first (fourth message))))
    (let* ((thread (second message))
           (level (third message))
           (restart (position "CONTINUE" (fifth message)
                              :key #'first :test #'string=)))
      (assert restart)
      (request stream 11 "(swank:backtrace 0 nil)" thread)
      (let* ((frames (result stream 11))
             (frame (find-if (lambda (frame)
                               (search "CALL-MISSING" (second frame)))
                             frames)))
        (assert frame () "Missing application frame: ~S" frames)
        (request stream 12
                 (format nil "(swank:frame-locals-and-catch-tags ~D)" (first frame))
                 thread)
        (let* ((locals (first (result stream 12)))
               (ids (mapcar (lambda (local) (getf local :id)) locals)))
          (assert (= (length ids) (length (remove-duplicates ids))))
          (dolist (expected '(("LISPM-DEBUGGER-TEST::A" "111")
                              ("LISPM-DEBUGGER-TEST::B" "222")))
            (let ((local (find (first expected) locals
                               :key (lambda (local) (getf local :name))
                               :test #'string=)))
              (assert local () "Missing local ~S: ~S" expected locals)
              (assert (string= (getf local :value) (second expected)))))))
      (assert (equal (evaluate stream 13
                               "(list lispm-debugger-test::*cleanup-count* lispm-debugger-test::*continued*)")
                     '("" "(0 NIL)")))
      (evaluate stream 14
                "(setf (symbol-function 'lispm-debugger-test::missing)
                       (compile nil '(lambda (a b) (values (+ a b) :resumed))))"
                thread)
      (request stream 15
               (format nil "(swank:invoke-nth-restart-for-emacs ~D ~D)" level restart)
               thread)
      (assert (equal (result stream 10 15) (list "" (format nil "333~%:RESUMED"))))
      (assert *debug-returned*)
      (assert (equal (evaluate stream 16
                               "(list lispm-debugger-test::*cleanup-count* lispm-debugger-test::*continued*)")
                     '("" "(1 T)")))
      (format t "PASS remote stop, locals, function repair, restart, multiple values, and cleanup~%"))))

(sb-ext:exit
 :code
 (handler-case
     (progn
       (call-with-connection
        "127.0.0.1" 4005 60
        (lambda (stream)
          (unwind-protect (run-test stream)
            (when *stop*
              (sb-ext:with-timeout 5
                (request stream 99 "(swank:throw-to-toplevel)" (second *stop*))
                (loop for message = (event stream)
                      until (and (eq (first message) :return)
                                 (eql (third message) 10))))))))
       0)
   (error (condition)
     (format *error-output* "Debugger test failed: ~A~%" condition)
     1)))
