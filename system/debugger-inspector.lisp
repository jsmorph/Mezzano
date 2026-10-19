(in-package :mezzano.debug)

(defun check-service-inspection-reference (reference stop kind)
  (unless (and (service-inspection-reference-p reference)
               (eq (service-inspection-reference-kind reference) kind)
               (eq (check-service-handle (service-inspection-reference-handle reference)) stop)
               (eql (service-inspection-reference-generation reference)
                    (service-stop-generation stop))
               (eq (service-stop-state stop) :stopped))
    (service-error :expired-inspection-reference))
  (let ((entry (gethash (service-inspection-reference-id reference)
                        (service-stop-inspection-values stop))))
    (unless entry (service-error :released-inspection-reference))
    (unless (eq (service-inspection-reference-kind (cdr entry)) kind)
      (service-error :expired-inspection-reference))
    entry))

(defun service-inspection-reference-value (reference kind)
  (with-service-lock
    (unless (service-inspection-reference-p reference)
      (service-error :expired-inspection-reference))
    (let* ((stop (check-service-handle (service-inspection-reference-handle reference)))
           (entry (check-service-inspection-reference reference stop kind)))
      (unless (eq (mezzano.supervisor:current-thread) (service-stop-thread stop))
        (service-error :foreign-inspection-thread))
      (car entry))))

(defun retain-service-inspection-value (stop value kind)
  (with-service-lock
    (unless (eq (service-stop-state stop) :stopped) (service-error :stop-closed))
    (unless (eq (mezzano.supervisor:current-thread) (service-stop-thread stop))
      (service-error :foreign-inspection-thread))
    (let* ((id (when (eq kind :object)
                 (gethash value (service-stop-inspection-identities stop))))
           (entry (when id (gethash id (service-stop-inspection-values stop)))))
      (unless entry
        (setf id (service-stop-next-inspection-id stop)
              entry (cons value nil))
        (incf (service-stop-next-inspection-id stop))
        (setf (gethash id (service-stop-inspection-values stop)) entry)
        (when (eq kind :object)
          (setf (gethash value (service-stop-inspection-identities stop)) id)))
      (unless (and (cdr entry)
                   (eq (service-handle-boot
                        (service-inspection-reference-handle (cdr entry)))
                       (mezzano.supervisor:current-boot-id)))
        (setf (cdr entry)
              (%make-service-inspection-reference
               (service-handle stop) (service-stop-generation stop) kind id)))
      (cdr entry))))

(defun clear-service-inspection (stop)
  (with-service-lock
    (unless (eq (service-stop-state stop) :stopped) (service-error :stop-closed))
    (unless (eq (mezzano.supervisor:current-thread) (service-stop-thread stop))
      (service-error :foreign-inspection-thread))
    (clrhash (service-stop-inspection-values stop))
    (clrhash (service-stop-inspection-identities stop)))
  nil)

(defstruct (service-inspection-part
             (:constructor make-service-inspection-part (object kind key &optional class slot)))
  object kind key class slot)

(defun service-inspection-components (object start count)
  (let ((rows nil) (total 0))
    (labels ((wanted-p () (<= start total (+ start count -1)))
             (add (label value bound-p &optional kind key class slot)
               (push (list label value bound-p
                           (when kind
                             (make-service-inspection-part object kind key class slot)))
                     rows))
             (item (label value bound-p &optional kind key)
               (when (wanted-p) (add label value bound-p kind key))
               (incf total)))
      (typecase object
        (cons
         (item "CAR" (car object) t :car)
         (item "CDR" (cdr object) t :cdr))
        (array
         (setf total (array-total-size object))
         (loop for index from (min start total) below (min total (+ start count))
               do (add (format nil "[~D]" index) (row-major-aref object index) t
                       :array index)))
        (symbol
         (item "Name" (symbol-name object) t)
         (item "Package" (symbol-package object) t)
         (item "Value" (when (boundp object) (symbol-value object)) (boundp object)
               (unless (constantp object) :symbol-value))
         (cond ((special-operator-p object)
                (item "Special operator" object t))
               ((macro-function object)
                (item "Macro function" (macro-function object) t))
               (t (item "Function" (when (fboundp object) (symbol-function object))
                        (fboundp object) :symbol-function)))
         (item "Plist" (symbol-plist object) t :symbol-plist))
        (hash-table
         (mezzano.internals::with-hash-table-lock (object)
           (maphash (lambda (key value)
                      (let ((index (floor total 2)))
                        (when (wanted-p) (add (format nil "Key[~D]" index) key t)))
                      (incf total)
                      (when (wanted-p)
                        (add (format nil "Value[~D]" (floor total 2)) value t :hash key))
                      (incf total))
                    object)))
        (function)
        (service-frame-variable
         (multiple-value-bind (value available unbound-p) (service-frame-variable-observation object)
           (unless (or available unbound-p) (service-error :unavailable-binding))
           (item "Value" value available :frame-variable)))
        ((or standard-object structure-object)
         (let ((class (class-of object)))
           (dolist (slot (mezzano.clos:class-slots class))
             (let* ((name (mezzano.clos:slot-definition-name slot))
                    (structure-p (typep object 'structure-object))
                    (size (when structure-p
                            (mezzano.clos::structure-slot-definition-fixed-vector slot)))
                    (writable-p
                      (not (and structure-p
                                (mezzano.clos::structure-slot-definition-read-only slot)))))
               (if size
                   (progn
                     (loop for index from (max 0 (- start total))
                           below (min size (- (+ start count) total))
                           do (add (format nil "~A[~D]" (service-print name) index)
                                   (mezzano.internals::%struct-vector-slot object class slot index)
                                   t (when writable-p :structure-vector) index class slot))
                     (incf total size))
                   (progn
                     (when (wanted-p)
                       (let ((bound-p (slot-boundp object name)))
                         (add (service-print name) (when bound-p (slot-value object name))
                              bound-p (when writable-p :slot) name class slot)))
                     (incf total)))))))))
    (values (nreverse rows) total)))

(defun write-service-inspection-part (part value)
  (let ((object (service-inspection-part-object part))
        (key (service-inspection-part-key part))
        (class (service-inspection-part-class part))
        (slot (service-inspection-part-slot part)))
    (when slot
      (unless (and (eq class (class-of object))
                   (eq slot (find (mezzano.clos:slot-definition-name slot)
                                  (mezzano.clos:class-slots class)
                                  :key #'mezzano.clos:slot-definition-name :test #'eq)))
        (service-error :expired-inspection-part))
      (when (and (typep object 'structure-object)
                 (mezzano.clos::structure-slot-definition-read-only slot))
        (service-error :read-only-inspection-part)))
    (ecase (service-inspection-part-kind part)
      (:car (setf (car object) value))
      (:cdr (setf (cdr object) value))
      (:array
       (unless (< key (array-total-size object)) (service-error :expired-inspection-part))
       (setf (row-major-aref object key) value))
      (:symbol-value (setf (symbol-value object) value))
      (:symbol-function
       (when (or (special-operator-p object) (macro-function object))
         (service-error :read-only-inspection-part))
       (setf (symbol-function object) value))
      (:symbol-plist (setf (symbol-plist object) value))
      (:hash
       (unless (nth-value 1 (gethash key object)) (service-error :expired-inspection-part))
       (setf (gethash key object) value))
      (:slot (setf (slot-value object key) value))
      (:frame-variable (setf (mezzano.debugger:location-value object) value))
      (:structure-vector
       (unless (< key (mezzano.clos::structure-slot-definition-fixed-vector slot))
         (service-error :expired-inspection-part))
       (setf (mezzano.internals::%struct-vector-slot object class slot key) value))))
  value)

(defun service-inspection-page (stop object start count)
  (let ((reference (retain-service-inspection-value stop object :object))
        (title (service-print object))
        (type (service-print (type-of object))))
    (multiple-value-bind (rows total) (service-inspection-components object start count)
      (let ((start (min start total)))
        (list :object reference :title title :type type
              :start start :end (+ start (length rows)) :total total :count count
              :parts
              (loop for (label value bound-p part) in rows
                    collect (list :label label :bound-p bound-p
                                  :value (when bound-p (service-print value))
                                  :object (when bound-p
                                            (retain-service-inspection-value stop value :object))
                                  :part (when part
                                          (retain-service-inspection-value stop part :part)))))))))

(defun check-service-inspection-argument (stop operation argument)
  (case operation
    (:describe-object
     (when argument (check-service-inspection-reference argument stop :object)))
    (otherwise
     (unless (and (eq operation :inspect) (null argument))
       (unless (typep argument '(cons t (cons (integer 0 *) (cons (integer 1 64) null))))
         (service-error :invalid-inspection-range))
       (check-service-inspection-reference (first argument) stop
                                           (if (eq operation :modify) :part :object))))))

(defun service-inspection-object (stop reference)
  (if reference
      (service-inspection-reference-value reference :object)
      (fourth (service-stop-evaluation-history stop))))

(defun service-inspect (stop argument)
  (service-inspection-page stop (service-inspection-object stop (first argument))
                           (if argument (second argument) 0)
                           (if argument (third argument) 32)))

(defun service-modify-inspection (stop argument)
  (let ((part (service-inspection-reference-value (first argument) :part)))
    (write-string "New value (Lisp expression in the selected frame): " *query-io*)
    (finish-output *query-io*)
    (let ((value (first (service-evaluate-input stop #'read-service-expression))))
      (write-service-inspection-part
       (service-inspection-reference-value (first argument) :part) value))
    (service-inspection-page stop (service-inspection-part-object part)
                             (second argument) (third argument))))

(defun service-describe-inspection (stop reference)
  (let ((*print-readably* nil) (*print-circle* t) (*print-level* 5) (*print-length* 20))
    (with-output-to-string (stream)
      (describe (service-inspection-object stop reference) stream))))
