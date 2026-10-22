(defpackage #:lispm-retained-source-test
  (:use #:cl)
  (:local-nicknames (#:i #:mezzano.internals)
                    (#:c #:mezzano.compiler)
                    (#:s #:mezzano.supervisor))
  (:export #:run))
(in-package #:lispm-retained-source-test)
(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defvar *read-count* 0)

(defun source (function)
  (i::debug-info-source-form (i::function-debug-info function)))

(defun capture-test ()
  (let* ((*package* (find-package '#:lispm-retained-source-test))
         (*read-count* 0)
         (*read-eval* t)
         (i::*top-level-form-number* 0)
         (text (format nil "11~%; λ~%#.(incf *read-count*)~%22~%; tail"))
         (stream (make-instance 'i::source-recording-stream
                                :stream (make-string-input-stream text)
                                :namestring "capture.lisp"))
         (eof (list :eof))
         (records nil)
         (values nil))
    (loop
      (multiple-value-bind (form record) (i::read-source-form stream eof)
        (when (eq form eof) (return))
        (push form values)
        (push record records)
        (incf i::*top-level-form-number*)))
    (setf records (nreverse records))
    (assert (equal (nreverse values) '(11 1 22)))
    (assert (= *read-count* 1))
    (assert (equalp (subseq (first records) 0 5)
                    #(:source-text "capture.lisp" 0 1 0)))
    (assert (= (aref (second records) 3) 2))
    (assert (zerop (aref (second records) 4)))
    (assert (equal text
                   (apply #'concatenate 'string
                          (append (mapcar (lambda (record) (aref record 5)) records)
                                  (list (copy-seq (i::source-recording-stream-characters stream))))))))
  t)

(defun copy-test ()
  (let* ((c::*source-form* (vector :source-text "copy.lisp" 0 1 0 "(lambda (x) x)"))
         (original (c::pass1-lambda '(lambda (x) x) nil))
         (copy (c::copy-form original)))
    (assert (eq c::*source-form*
                (getf (c::lambda-information-plist copy) 'c::source-form)))
    (assert (eq c::*source-form* (source (c::codegen-lambda (c::compile-lambda-2 copy))))))
  t)

(defun fixture-names (prefix)
  (loop for suffix in '("FIRST" "SECOND" "COMPILE-TIME" "LATER" "LAP")
        collect (intern (concatenate 'string prefix "-" suffix)
                        '#:lispm-retained-source-test)))

(defun fixture-text (debug marker names)
  (let ((*package* (find-package '#:lispm-retained-source-test)))
    (format nil
            "(in-package #:lispm-retained-source-test)~%~
             (declaim (optimize (debug ~D) (safety 3) (speed 1)))~%~
             ; λ preserved source~%~
             (progn~%~
               (defun ~S (x) (list ~S (+ x 1)))~%~
               (defun ~S (x) (lambda () (list ~S (+ x 2)))))~%~
             (eval-when (:compile-toplevel :load-toplevel :execute)~%~
               (defun ~S () ~S))~%~
             (defun ~S (x) (+ x 4))~%~
             (i::define-lap-function ~S (())~%~
               (:gc :no-frame :layout #*0)~%~
               (mezzano.lap.x86:nop)~%~
               (mezzano.lap.x86:ret))~%"
            debug (first names) marker (second names) marker
            (third names) marker (fourth names) (fifth names))))

(defun write-fixture (pathname text)
  (with-open-file (stream pathname :direction :output :if-exists :supersede
                                  :if-does-not-exist :create)
    (write-string text stream)))

(defun compile-fixture (input output parallel)
  (multiple-value-bind (file warnings failure)
      (compile-file input :output-file output :parallel parallel :verbose nil :print nil)
    (assert (and file (not warnings) (not failure)))
    file))

(defun check-fixture (names debug marker input)
  (assert (equal (funcall (fdefinition (first names)) 41) (list marker 42)))
  (let* ((closure (funcall (fdefinition (second names)) 40))
         (records (mapcar (lambda (name) (source (fdefinition name))) names)))
    (assert (equal (funcall closure) (list marker 42)))
    (assert (eq (funcall (fdefinition (third names))) marker))
    (assert (= (funcall (fdefinition (fourth names)) 38) 42))
    (if (zerop debug)
        (progn (assert (every #'null records)) (assert (null (source closure))))
        (progn
          (assert (every #'identity records))
          (assert (eq (first records) (second records)))
          (assert (eq (second records) (source closure)))
          (assert (equal (mapcar (lambda (record) (aref record 2)) records) '(2 2 3 4 5)))
          (dolist (record records)
            (assert (equal (aref record 1) (namestring input)))
            (assert (plusp (length (aref record 5)))))
          (assert (search "; λ preserved source" (aref (first records) 5)))
          (assert (search "(progn" (aref (first records) 5)))
          (assert (search "eval-when" (aref (third records) 5)))
          (assert (search "define-lap-function" (aref (fifth records) 5)))))
    records))

(defun file-case (root debug parallel)
  (let* ((stem (format nil "retained-~D-~A" debug (if parallel "parallel" "serial")))
         (input (merge-pathnames (make-pathname :name stem :type "lisp") root))
         (output (merge-pathnames (make-pathname :name stem :type "llf") root))
         (names (fixture-names (string-upcase stem)))
         (text (fixture-text debug :old names))
         (first-function nil)
         (records nil))
    (assert (notany #'fboundp names))
    (assert (not (probe-file input)))
    (assert (not (probe-file output)))
    (unwind-protect
         (progn
           (write-fixture input text)
           (load (compile-fixture input output parallel) :verbose nil :print nil)
           (setf records (check-fixture names debug :old input)
                 first-function (fdefinition (first names)))
           (let ((saved-text (when (first records) (copy-seq (aref (first records) 5)))))
             (write-fixture input (fixture-text debug :new names))
             (load (compile-fixture input output parallel) :verbose nil :print nil)
             (check-fixture names debug :new input)
             (assert (equal (funcall first-function 41) '(:old 42)))
             (when saved-text
               (assert (eq (source first-function) (first records)))
               (assert (equal (aref (source first-function) 5) saved-text))
               (assert (not (eq (source first-function) (source (fdefinition (first names))))))))
           (format t "PASS retained source DEBUG ~D ~A: ~D distinct records, ~D text characters.~%"
                   debug (if parallel :parallel :serial)
                   (length (remove-duplicates (remove nil records) :test #'eq))
                   (loop for record in (remove-duplicates (remove nil records) :test #'eq)
                         sum (length (aref record 5)))))
      (dolist (name names) (when (fboundp name) (fmakunbound name)))
      (dolist (file (list input output)) (when (probe-file file) (delete-file file)))))
  t)

(defun concurrent-case (root)
  (let ((entries nil)
        (threads nil))
    (unwind-protect
         (progn
           (dolist (suffix '("A" "B"))
             (let* ((stem (concatenate 'string "retained-concurrent-" suffix))
                    (input (merge-pathnames (make-pathname :name stem :type "lisp") root))
                    (output (merge-pathnames (make-pathname :name stem :type "llf") root))
                    (names (fixture-names (string-upcase stem)))
                    (marker (intern suffix :keyword)))
               (assert (notany #'fboundp names))
               (assert (not (probe-file input)))
               (assert (not (probe-file output)))
               (write-fixture input (fixture-text 3 marker names))
               (push (list input output names marker) entries)))
           (dolist (entry entries)
             (let ((entry entry))
               (push (s:make-thread (lambda () (compile-fixture (first entry) (second entry) :force))
                                    :name "Owned retained-source compilation")
                     threads)))
           (dolist (thread threads)
             (assert (first (s:thread-join thread))))
           (dolist (entry entries)
             (load (second entry) :verbose nil :print nil)
             (check-fixture (third entry) 3 (fourth entry) (first entry)))
           (let* ((functions (mapcar (lambda (entry) (fdefinition (first (third entry)))) entries))
                  (before (mapcar #'source functions)))
             (assert (not (eq (first before) (second before))))
             (i::gc :full t)
             (assert (every #'eq before (mapcar #'source functions))))
           (format t "PASS independent concurrent file compilations and retained source through full GC.~%"))
      (dolist (thread threads)
        (unless (nth-value 1 (s:thread-join thread nil))
          (s:terminate-thread thread)
          (s:thread-join thread)))
      (dolist (entry entries)
        (dolist (name (third entry)) (when (fboundp name) (fmakunbound name)))
        (dolist (file (subseq entry 0 2)) (when (probe-file file) (delete-file file))))))
  t)

(defun run (root)
  (capture-test)
  (copy-test)
  (dolist (parallel '(nil :force))
    (dolist (debug '(0 1 3))
      (file-case root debug parallel)))
  (concurrent-case root)
  (assert (null c::*source-form*))
  t)
