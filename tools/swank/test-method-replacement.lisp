(defpackage #:lispm-method-replacement-test
  (:use #:cl)
  (:export #:run))
(in-package #:lispm-method-replacement-test)
(declaim (optimize (safety 3) (debug 3) (speed 1)))

(defun await (predicate)
  (let ((deadline (+ (get-internal-real-time)
                     (* 5 internal-time-units-per-second))))
    (loop for result = (funcall predicate)
          when result return result
          do (assert (< (get-internal-real-time) deadline) ()
                     "Method replacement synchronization did not complete.")
             (sleep 0.001))))

(defclass observer ()
  ((gate :initarg :gate :reader gate)
   (done :initarg :done :reader done)
   (reader :initarg :reader :reader reader)
   (old :initarg :old :reader old-method)
   (new :initarg :new :reader new-method)
   (notifications :initform nil :accessor notifications)
   (blocked-p :initform nil :accessor blocked-p)))

(defmethod mezzano.clos:update-dependent ((gf standard-generic-function)
                                         (observer observer) &rest arguments)
  (push arguments (notifications observer))
  (when (eq (first arguments) 'remove-method)
    (assert (eq (second arguments) (old-method observer)))
    (assert (null (mezzano.clos:method-generic-function (old-method observer))))
    (assert (null (mezzano.clos:method-generic-function (new-method observer))))
    (mezzano.clos::with-generic-function-lock (gf)
      (assert (not (member (old-method observer) (mezzano.clos:generic-function-methods gf)))))
    (setf (mezzano.supervisor:event-state (gate observer)) t)
    (await (lambda ()
             (or (mezzano.supervisor:event-state (done observer))
                 (eq (mezzano.supervisor:thread-wait-item (reader observer))
                     (mezzano.clos::generic-function-lock gf)))))
    (setf (blocked-p observer)
          (eq (mezzano.supervisor:thread-wait-item (reader observer))
              (mezzano.clos::generic-function-lock gf)))))

(defun method-returning (gf lambda-list specializers value)
  (make-instance 'standard-method
                 :qualifiers nil :lambda-list lambda-list
                 :specializers specializers
                 :function (lambda (arguments next-methods)
                             (declare (ignore arguments next-methods))
                             (assert (not (mezzano.supervisor:mutex-held-p
                                           (mezzano.clos::generic-function-lock gf))))
                             value)))

(defun check-replacement (gf old new arguments expected)
  (let* ((gate (mezzano.supervisor:make-event))
         (done (mezzano.supervisor:make-event))
         (result nil)
         (failure nil)
         (reader (mezzano.supervisor:make-thread
                  (lambda ()
                    (unwind-protect
                         (progn
                           (mezzano.supervisor:event-wait gate)
                           (setf result
                                 (handler-case (list :value (apply gf arguments))
                                   (error (condition) (list :error condition)))))
                      (setf (mezzano.supervisor:event-state done) t)))
                  :name "Method replacement test reader"))
         (observer (make-instance 'observer :gate gate :done done :reader reader
                                  :old old :new new)))
    (mezzano.clos:add-dependent gf observer)
    (unwind-protect
         (handler-case (add-method gf new)
           (error (condition) (setf failure condition)))
      (mezzano.clos:remove-dependent gf observer)
      (setf (mezzano.supervisor:event-state gate) t))
    (await (lambda () (mezzano.supervisor:event-state done)))
    (mezzano.supervisor:thread-join reader)
    (when failure (error failure))
    (assert (blocked-p observer))
    (assert (equal result (list :value expected)) () "Reader result: ~S" result)
    (assert (equal (reverse (notifications observer))
                   (list (list 'remove-method old) (list 'add-method new))))
    (assert (null (mezzano.clos:method-generic-function old)))
    (assert (eq (mezzano.clos:method-generic-function new) gf))
    (assert (not (member old (mezzano.clos:generic-function-methods gf))))
    (assert (member new (mezzano.clos:generic-function-methods gf)))
    (dolist (specializer (mezzano.clos:method-specializers new))
      (assert (not (member old (mezzano.clos:specializer-direct-methods specializer))))
      (assert (member new (mezzano.clos:specializer-direct-methods specializer))))
    (dotimes (i 10) (assert (eql (apply gf arguments) expected)))
    (assert (not (mezzano.supervisor:mutex-held-p
                  (mezzano.clos::generic-function-lock gf))))))

(defun check-standard (lambda-list specializers arguments)
  (let* ((gf (make-instance 'standard-generic-function :lambda-list lambda-list))
         (old (method-returning gf lambda-list specializers :old))
         (new (method-returning gf lambda-list specializers :new)))
    (add-method gf old)
    (assert (eq (apply gf arguments) :old))
    (check-replacement gf old new arguments :new)
    (let ((bad (method-returning gf '(a b c) (make-list 3 :initial-element (find-class 't)) :bad)))
      (assert (handler-case (progn (add-method gf bad) nil) (error () t)))
      (assert (not (mezzano.supervisor:mutex-held-p (mezzano.clos::generic-function-lock gf))))
      (assert (eq (apply gf arguments) :new)))
    (remove-method gf new)
    (assert (null (mezzano.clos:generic-function-methods gf)))
    (assert (null (mezzano.clos:method-generic-function new)))
    (assert (handler-case (progn (apply gf arguments) nil) (error () t)))
    (assert (not (mezzano.supervisor:mutex-held-p (mezzano.clos::generic-function-lock gf))))))

(defclass cell ()
  ((value :initform 7 :accessor cell-value)))

(defun copy-accessor-method (method)
  (make-instance (class-of method)
                 :qualifiers (mezzano.clos:method-qualifiers method)
                 :lambda-list (mezzano.clos:method-lambda-list method)
                 :specializers (mezzano.clos:method-specializers method)
                 :slot-definition (mezzano.clos:accessor-method-slot-definition method)
                 :fast-function (slot-value method 'mezzano.clos::fast-function)))

(defun check-accessors ()
  (let ((object (make-instance 'cell)))
    (assert (= (cell-value object) 7))
    (let* ((gf #'cell-value)
           (old (find-method gf nil (list (find-class 'cell)))))
      (check-replacement gf old (copy-accessor-method old) (list object) 7))
    (assert (= (setf (cell-value object) 9) 9))
    (let* ((gf (fdefinition '(setf cell-value)))
           (old (find-method gf nil (list (find-class 't) (find-class 'cell)))))
      (check-replacement gf old (copy-accessor-method old) (list 11 object) 11))
    (assert (= (cell-value object) 11))))

(defun check-application-unlocked ()
  (let* ((gf (make-instance 'standard-generic-function :lambda-list '(value)))
         (gate (mezzano.supervisor:make-event))
         (done (mezzano.supervisor:make-event))
         (new (method-returning gf '(value) (list (find-class 'integer)) :new))
         (failure nil)
         (result nil))
    (add-method gf (make-instance
                    'standard-method :qualifiers nil :lambda-list '(value)
                    :specializers (list (find-class 'integer))
                    :function (lambda (arguments next-methods)
                                (declare (ignore arguments next-methods))
                                (setf (mezzano.supervisor:event-state gate) t)
                                (await (lambda () (mezzano.supervisor:event-state done)))
                                :old)))
    (let ((writer (mezzano.supervisor:make-thread
                   (lambda ()
                     (unwind-protect
                          (handler-case
                              (progn (mezzano.supervisor:event-wait gate)
                                     (add-method gf new))
                            (error (condition) (setf failure condition)))
                       (setf (mezzano.supervisor:event-state done) t)))
                   :name "Method replacement test writer")))
      (setf result (handler-case (list :value (funcall gf 1))
                     (error (condition) (list :error condition))))
      (await (lambda () (mezzano.supervisor:event-state done)))
      (mezzano.supervisor:thread-join writer))
    (when failure (error failure))
    (assert (equal result '(:value :old)) () "~S" result)
    (assert (eq (funcall gf 1) :new))
    (remove-method gf new)))


(defun remove-fixture-methods (gf)
  (dolist (method (copy-list (mezzano.clos:generic-function-methods gf)))
    (remove-method gf method)))

(defun check-stale-reader-replacement ()
  (let* ((gf (make-instance 'standard-generic-function :lambda-list '(object)))
         (class (find-class 'cell))
         (object (make-instance class))
         (old (method-returning gf '(object) (list class) :old)))
    (unwind-protect
         (progn
           (add-method gf old)
           (assert (eq (funcall gf object) :old))
           (let ((stale (mezzano.clos::compute-1-effective-discriminator
                         gf (mezzano.clos::classes-to-emf-table gf) 0))
                 (new (copy-accessor-method (find-method #'cell-value nil (list class)))))
             (add-method gf new)
             (assert (= (funcall gf object) 7))
             (assert (= (funcall stale object) 7))
             (assert (= (funcall gf object) 7))))
      (remove-fixture-methods gf))))

(defun check-heterogeneous-reader ()
  (let* ((gf (make-instance 'standard-generic-function :lambda-list '(object)))
         (class (find-class 'cell))
         (object (make-instance class))
         (reader (copy-accessor-method (find-method #'cell-value nil (list class))))
         (ordinary (method-returning gf '(object) (list (find-class 'integer)) 17)))
    (unwind-protect
         (progn
           (add-method gf reader)
           (add-method gf ordinary)
           (assert (= (funcall gf object) 7))
           (let ((stale (mezzano.clos::compute-reader-discriminator
                         gf (mezzano.clos::classes-to-emf-table gf) 0
                         (mezzano.clos:accessor-method-slot-definition reader))))
             (assert (= (funcall gf 1) 17))
             (assert (= (funcall gf object) 7))
             (assert (= (funcall stale object) 7))
             (dotimes (i 10)
               (assert (= (funcall gf i) 17))
               (assert (= (funcall gf object) 7)))))
      (remove-fixture-methods gf))))

(defun check-dispatch-transitions ()
  (let* ((gf (make-instance 'standard-generic-function :lambda-list '(a b)))
         (old (method-returning gf '(a b)
                                (list (find-class 'integer) (find-class 't)) :old))
         (new (method-returning gf '(a b)
                                (list (find-class 't) (find-class 'integer)) :new)))
    (unwind-protect
         (progn
           (add-method gf old)
           (assert (eq (funcall gf 1 :x) :old))
           (let ((stale (mezzano.clos::compute-1-effective-discriminator
                         gf (mezzano.clos::classes-to-emf-table gf) 0)))
             (add-method gf new)
             (assert (eq (funcall gf :x 1) :new))
             (assert (eq (funcall stale :x 1) :new)))
           (let ((stale (mezzano.clos::compute-n-effective-discriminator
                         gf (mezzano.clos::classes-to-emf-table gf) 2)))
             (remove-method gf new)
             (assert (eq (funcall gf 1 :x) :old))
             (assert (eq (funcall stale 1 :x) :old)))
           (assert (eq (mezzano.clos::slow-single-dispatch-method-lookup
                        gf '(1 :x) (find-class 'integer)) :old)))
      (remove-fixture-methods gf))))

(defclass lookup-generic-function (standard-generic-function)
  ((gate :initform nil)
   (done :initform nil)
   (writer :initform nil)
   (armed-p :initform nil)
   (blocked-p :initform nil))
  (:metaclass mezzano.clos:funcallable-standard-class))

(defmethod mezzano.clos::compute-effective-method-function :around
    ((gf lookup-generic-function) methods)
  (when (slot-value gf 'armed-p)
    (setf (slot-value gf 'armed-p) nil
          (mezzano.supervisor:event-state (slot-value gf 'gate)) t)
    (await (lambda ()
             (or (mezzano.supervisor:event-state (slot-value gf 'done))
                 (eq (mezzano.supervisor:thread-wait-item (slot-value gf 'writer))
                     (mezzano.clos::generic-function-lock gf)))))
    (setf (slot-value gf 'blocked-p)
          (eq (mezzano.supervisor:thread-wait-item (slot-value gf 'writer))
              (mezzano.clos::generic-function-lock gf))))
  (call-next-method))

(defun check-lookup-publication ()
  (let* ((gf (make-instance 'lookup-generic-function :lambda-list '(a b)))
         (specializers (list (find-class 'integer) (find-class 'integer)))
         (old (method-returning gf '(a b) specializers :old))
         (new (method-returning gf '(a b) specializers :new))
         (gate (mezzano.supervisor:make-event))
         (done (mezzano.supervisor:make-event))
         (failure nil)
         (result nil))
    (unwind-protect
         (progn
           (add-method gf old)
           (setf (slot-value gf 'gate) gate
                 (slot-value gf 'done) done
                 (slot-value gf 'armed-p) t
                 (slot-value gf 'writer)
                 (mezzano.supervisor:make-thread
                  (lambda ()
                    (unwind-protect
                         (handler-case
                             (progn (mezzano.supervisor:event-wait gate)
                                    (add-method gf new))
                           (error (condition) (setf failure condition)))
                      (setf (mezzano.supervisor:event-state done) t)))
                  :name "Method lookup publication test writer"))
           (setf result (handler-case (list :value (funcall gf 1 2))
                          (error (condition) (list :error condition))))
           (setf (mezzano.supervisor:event-state gate) t)
           (await (lambda () (mezzano.supervisor:event-state done)))
           (mezzano.supervisor:thread-join (slot-value gf 'writer))
           (when failure (error failure))
           (assert (slot-value gf 'blocked-p))
           (assert (equal result '(:value :old)) () "~S" result)
           (assert (eq (funcall gf 1 2) :new))
           (let ((lock (mezzano.clos::generic-function-lock gf)))
             (mezzano.extensions:gc :full t)
             (assert (eq lock (mezzano.clos::generic-function-lock gf)))))
      (remove-fixture-methods gf))))

(defclass recursive-replacement-generic-function (standard-generic-function)
  ((replacement :initform nil)
   (arguments :initarg :arguments)
   (stage :initarg :stage))
  (:metaclass mezzano.clos:funcallable-standard-class))

(defun replace-during-lookup (gf stage)
  (when (eq (slot-value gf 'stage) stage)
    (let ((method (slot-value gf 'replacement)))
      (when method
        (setf (slot-value gf 'replacement) nil)
        (add-method gf method)
        (assert (eq (apply gf (slot-value gf 'arguments)) :new))))))

(defmethod mezzano.clos:compute-applicable-methods-using-classes :around
    ((gf recursive-replacement-generic-function) classes)
  (multiple-value-prog1 (call-next-method)
    (replace-during-lookup gf :applicability)))

(defmethod mezzano.clos::compute-effective-method-function :around
    ((gf recursive-replacement-generic-function) methods)
  (replace-during-lookup gf :effective-function)
  (call-next-method))

(define-method-combination recursive-replacement-combination ()
  ((primary () :required t))
  (:generic-function gf)
  (replace-during-lookup gf :combination)
  (list 'call-method (first primary)))

(defun check-recursive-replacement (lambda-list specializers arguments stage)
  (let ((gf (make-instance
             'recursive-replacement-generic-function
             :lambda-list lambda-list :arguments arguments :stage stage
             :method-combination
             (when (eq stage :combination)
               (mezzano.clos:find-method-combination
                #'cell-value 'recursive-replacement-combination nil)))))
    (flet ((make-method (value)
             (make-instance
              'standard-method :qualifiers nil :lambda-list lambda-list
              :specializers specializers
              :function (lambda (arguments next-methods)
                          (declare (ignore arguments next-methods))
                          value))))
      (let ((old (make-method :old))
            (new (make-method :new)))
        (unwind-protect
             (progn
               (add-method gf old)
               (setf (slot-value gf 'replacement) new)
               (assert (member (apply gf arguments) '(:old :new)))
               (assert (null (slot-value gf 'replacement)))
               (assert (null (mezzano.clos:method-generic-function old)))
               (assert (eq (mezzano.clos:method-generic-function new) gf))
               (dotimes (i 3)
                 (assert (eq (apply gf arguments) :new) ()
                         "Recursive replacement at ~S retained the old method for ~S."
                         stage specializers))
               (assert (not (mezzano.supervisor:mutex-held-p
                             (mezzano.clos::generic-function-lock gf)))))
          (remove-fixture-methods gf))))))

(defun check-recursive-replacements ()
  (dolist (stage '(:applicability :effective-function :combination))
    (check-recursive-replacement
     '(a b) (list (find-class 'integer) (find-class 'integer)) '(1 2) stage))
  (dolist (stage '(:applicability :combination))
    (check-recursive-replacement '(value) (list (find-class 'integer)) '(1) stage))
  (check-recursive-replacement '(value) (list (find-class 't)) '(1) :combination)
  (check-recursive-replacement
   '(value) (list (mezzano.clos:intern-eql-specializer 1)) '(1) :combination))

(defun run ()
  (check-standard '(value) (list (find-class 'integer)) '(1))
  (check-standard '(value) (list (find-class 't)) '(1))
  (check-standard '(a b) (list (find-class 'integer) (find-class 'integer)) '(1 2))
  (check-standard '(value) (list (mezzano.clos:intern-eql-specializer 1)) '(1))
  (check-accessors)
  (check-application-unlocked)
  (check-stale-reader-replacement)
  (check-heterogeneous-reader)
  (check-dispatch-transitions)
  (check-lookup-publication)
  (check-recursive-replacements)
  (format t "PASS concurrent method replacement, MOP ordering and backpointers, dispatch variants and transitions, cache publication, recursive replacement, GC, errors, removal, and unlocked application methods.~%")
  (values))
