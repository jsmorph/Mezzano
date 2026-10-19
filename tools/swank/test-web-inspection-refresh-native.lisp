(in-package #:cl-user)

(dolist (mode '(:gate :fail))
  (let* ((name (format nil "NATIVE-INSPECTION-~A-~D-~D"
                       mode (get-universal-time) (random most-positive-fixnum)))
         (controller (mezzano.debug:make-debugger-controller))
         (stop-id (lispm-web-inspection-refresh-test:prepare name))
         (handle (find stop-id (mezzano.debug:debugger-stops)
                       :key (lambda (handle)
                              (getf (mezzano.debug:debugger-stop-information handle) :id))))
         (lease (mezzano.debug:attach-debugger-stop handle controller)))
    (unwind-protect
         (progn
           (lispm-web-inspection-refresh-test:arm name mode)
           (let ((id (getf (mezzano.debug:debugger-stop-information handle) :next-command-id)))
             (mezzano.debug:submit-debugger-command lease id :condition)
             (ecase mode
               (:gate
                (lispm-web-inspection-refresh-test:check-gate name)
                (assert (eq (getf (mezzano.debug:debugger-command-result handle id) :state) :running))
                (lispm-service-test::expect-error
                 :stop-busy
                 (lambda () (mezzano.debug:submit-debugger-command lease (1+ id) :help)))
                (assert (= (1+ id) (getf (mezzano.debug:debugger-stop-information handle) :next-command-id)))
                (lispm-web-inspection-refresh-test:release-gate name)
                (let ((result (lispm-service-test::completed-command handle id)))
                  (assert (eq (getf result :state) :returned))
                  (assert (search name (getf result :result)))))
               (:fail
                (let* ((child (lispm-service-test::await
                               (lambda () (getf (mezzano.debug:debugger-stop-information handle) :child))))
                       (child-lease (mezzano.debug:attach-debugger-stop child controller)))
                  (assert (search "Owned automatic condition printer failure."
                                  (lispm-service-test::command child child-lease :condition)))
                  (let ((abort-id (getf (mezzano.debug:debugger-stop-information child) :next-command-id)))
                    (mezzano.debug:submit-debugger-command child-lease abort-id :abort)
                    (assert (eq (getf (lispm-service-test::completed-command child abort-id) :state) :unwound)))
                  (assert (eq (getf (lispm-service-test::completed-command handle id) :state) :unwound))
                  (mezzano.debug:release-debugger-stop child-lease)
                  (assert (search name (lispm-service-test::command handle lease :condition)))))))
           (lispm-web-inspection-refresh-test:check-recovered name)
           (let ((id (getf (mezzano.debug:debugger-stop-information handle) :next-command-id)))
             (mezzano.debug:submit-debugger-command lease id :proceed)
             (assert (eq (getf (lispm-service-test::completed-command handle id) :state) :unwound)))
           (mezzano.debug:release-debugger-stop lease)
           (assert (lispm-web-inspection-refresh-test:finish name)))
      (mezzano.debug:close-debugger-controller controller))))

:WEB-INSPECTION-REFRESH-NATIVE-CHECKS-PASSED
