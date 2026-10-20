(in-package :mezzano.supervisor)
(declaim (optimize (debug 1) (safety 3) (speed 1)))

(defmacro without-footholds (&body body)
  (let ((thread (gensym)) (counter (gensym)) (allow (gensym)))
    `(let* ((,thread (current-thread))
            (,counter (thread-inhibit-footholds ,thread))
            (,allow (thread-allow-with-footholds ,thread)))
       (declare (ignorable ,allow))
       (call-with-foothold-binding
        (dx-lambda ()
          (macrolet ((allow-with-footholds (&body forms)
                       `(call-with-foothold-binding
                         (dx-lambda () (locally ,@forms))
                         (thread-inhibit-footholds ,',thread)
                         ,',allow))
                     (with-local-footholds (&body forms)
                       `(allow-with-footholds (with-footholds ,@forms))))
            ,@body))
        (1+ ,counter) nil))))

(defmacro with-footholds (&body body)
  (let ((thread (gensym)) (allow (gensym)))
    `(let* ((,thread (current-thread))
            (,allow (thread-allow-with-footholds ,thread)))
       (call-with-foothold-binding
        (dx-lambda () (locally ,@body))
        (if ,allow 0 (thread-inhibit-footholds ,thread))
        ,allow))))
