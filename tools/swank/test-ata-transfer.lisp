(defpackage #:lispm-ata-transfer-test
  (:use #:cl)
  (:local-nicknames (#:a #:mezzano.supervisor.ata)
                    (#:s #:mezzano.supervisor)
                    (#:i #:mezzano.internals))
  (:export #:run))
(in-package #:lispm-ata-transfer-test)

(declaim (optimize (debug 3) (safety 3) (speed 1)))

(defun run ()
  (let* ((frame (s::allocate-physical-pages 16 :32-bit-only t
                                           :mandatory-p "ATA transfer test"))
         (physical (* frame s::+4k-page-size+))
         (bounce (s::convert-to-pmap-address physical))
         (controller (a::make-ata-controller :bounce-buffer frame))
         (device (a::make-ata-device :controller controller :block-size 512
                                    :sector-count 1000 :lba48-capable t))
         (buffer (make-array s::+4k-page-size+ :element-type '(unsigned-byte 8)
                             :area :wired :initial-element #x22))
         (address (mezzano.runtime::%object-slot-address buffer 0)))
    (unwind-protect
         (flet ((unexpected (&rest arguments)
                  (error "Unexpected transfer: ~S." arguments))
                (failure (&rest arguments)
                  (declare (ignore arguments))
                  (values nil :injected-failure))
                (success (&rest arguments)
                  (declare (ignore arguments))
                  (values t :injected-success)))
           (dolist (direction '(:read :write))
             (assert (equal
                      (multiple-value-list
                       (a::ata-read-write device 17 8 bounce direction
                                          #'failure))
                      '(nil :injected-failure)))
             (assert (equal
                      (multiple-value-list
                       (a::ata-read-write device 17 8 bounce direction
                                          #'success))
                      '(t :injected-success)))
             (assert (equal
                      (multiple-value-list
                       (a::ata-read-write device 17 1 address direction
                                          #'failure))
                      '(nil :injected-failure)))
             (assert (equal
                      (multiple-value-list
                       (a::ata-read-write device 17 1 address direction
                                          #'success))
                      '(t :injected-success))))
           (dotimes (i s::+4k-page-size+)
             (setf (i::memref-unsigned-byte-8 bounce i) #x99))
           (fill buffer #x22)
           (assert (equal
                    (multiple-value-list
                     (a::ata-read-write device 17 8 address :read
                                        #'failure))
                    '(nil :injected-failure)))
           (assert (every (lambda (byte) (= byte #x22)) buffer))
           (assert (equal
                    (multiple-value-list
                     (a::ata-read-write device 17 8 address :read
                                        #'success))
                    '(t :injected-success)))
           (assert (every (lambda (byte) (= byte #x99)) buffer))
           (fill buffer #x44)
           (assert (equal
                    (multiple-value-list
                     (a::ata-read-write
                      device 17 8 address :write
                      (lambda (actual-controller actual-device lba count actual-physical)
                        (assert (eq actual-controller controller))
                        (assert (eq actual-device device))
                        (assert (= lba 17))
                        (assert (= count 8))
                        (assert (= actual-physical physical))
                        (dotimes (i s::+4k-page-size+)
                          (assert (= (i::memref-unsigned-byte-8 bounce i) #x44)))
                        (values nil :injected-write-failure))))
                    '(nil :injected-write-failure)))
           (assert (a::ata-read-write device 17 0 address :read
                                     #'unexpected)))
      (s::release-physical-pages frame 16)))
  (format t "PASS ATA transfer outcomes, direct DMA and bounce selection, and bounce-buffer data on failed reads and writes.~%")
  t)
