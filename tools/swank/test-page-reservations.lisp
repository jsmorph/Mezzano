(defpackage #:lispm-page-reservation-test
  (:use #:cl)
  (:export #:check #:transient-mapping #:run))

(in-package #:lispm-page-reservation-test)

(declaim (optimize (safety 3) (debug 1) (speed 1)))

(defun check ()
  (multiple-value-bind (pages counter free)
      (mezzano.supervisor::block-reservation-statistics)
    (assert (= counter (+ pages 256)) ()
            "Reservation counter ~D differs from ~D pages plus 256." counter pages)
    (format t "PASS page reservations: ~D pages, ~D reserved blocks, ~D free blocks.~%"
            pages counter free)
    (values pages counter free)))

(defun reservation-allowance ()
  (multiple-value-bind (pages counter)
      (mezzano.supervisor::block-reservation-statistics)
    (- counter pages)))

(defun transient-mapping ()
  (let ((allowance (reservation-allowance))
        (buffer nil))
    (unwind-protect
         (progn
           (setf buffer (mezzano.supervisor:make-dma-buffer
                         4096 :name "Reservation count test"))
           (assert (= allowance (reservation-allowance))))
      (when buffer (mezzano.supervisor:release-dma-buffer buffer)))
    (assert (= allowance (reservation-allowance))))
  (format t "PASS transient mapping preserves page reservations.~%")
  (values))

(defun request-snapshot-with-retry ()
  (mezzano.supervisor:with-snapshot-inhibited ()
    (mezzano.supervisor:snapshot)
    (let ((deadline (+ (get-internal-real-time)
                       (* 2 internal-time-units-per-second))))
      (loop until (eq (mezzano.supervisor:thread-wait-item
                       mezzano.internals::*snapshot-thread*)
                      (mezzano.supervisor::timer-event
                       mezzano.supervisor::*snapshot-retry-timer*))
            do (assert (< (get-internal-real-time) deadline) ()
                       "Snapshot worker did not wait on its retry timer.")
               (sleep 0.001))))
  (format t "PASS snapshot retry after full collection.~%")
  (values))

(defun call-with-reservation-reader (function description)
  (let ((done nil) (failure nil) (samples 0) (thread nil))
    (unwind-protect
         (progn
           (setf thread
                 (mezzano.supervisor:make-thread
                  (lambda ()
                    (handler-case
                        (loop until done
                              do (assert (= (reservation-allowance) 256))
                                 (incf samples)
                                 (sleep 0.01))
                      (error (condition) (setf failure condition))))
                  :name "Snapshot reservation reader"))
           (let ((deadline (+ (get-internal-real-time)
                              (* 2 internal-time-units-per-second))))
             (loop until (or (plusp samples) failure)
                   do (assert (< (get-internal-real-time) deadline))
                      (sleep 0.001)))
           (when failure (error failure))
           (funcall function))
      (setf done t)
      (when thread (mezzano.supervisor:thread-join thread)))
    (when failure (error failure))
    (assert (plusp samples))
    (format t "PASS ~D reservation samples during ~A.~%" samples description))
  (values))

(defun run (&key snapshot (collections 3))
  (transient-mapping)
  (mezzano.extensions:gc :full t)
  (check)
  (when (plusp collections)
    (call-with-reservation-reader
     (lambda () (dotimes (i collections) (mezzano.extensions:gc :full t)))
     "full collections")
    (check))
  (when snapshot
    (call-with-reservation-reader
     (lambda ()
       (request-snapshot-with-retry)
       (mezzano.supervisor:wait-for-snapshot-completion))
     "snapshot")
    (check))
  (values))
