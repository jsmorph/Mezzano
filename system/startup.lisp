(in-package :mezzano.internals)

(defvar *startup-status* nil)

(defun startup-status ()
  (copy-list *startup-status*))

(defun call-with-startup-sequence (kind function &key (inhibit-snapshot t))
  (check-type kind (member :initialization :restore))
  (let ((status (list :kind kind :boot-id (mezzano.supervisor:current-boot-id)
                      :thread (mezzano.supervisor:current-thread) :state :running))
        (completed nil))
    (when inhibit-snapshot
      (%atomic-fixnum-add-symbol 'mezzano.supervisor::*snapshot-inhibit* 1))
    (setf *startup-status* status)
    (unwind-protect
         (restart-case
             (progn
               (mezzano.debug:call-with-debugger-service function)
               (setf completed t))
           (abort ()
             :report "Abort this startup sequence."
             nil))
      (setf (getf status :state) (if completed :complete :incomplete))
      (when (and completed inhibit-snapshot)
        (%atomic-fixnum-add-symbol 'mezzano.supervisor::*snapshot-inhibit* -1)))
    completed))
