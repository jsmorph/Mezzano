(defpackage :mezzano.driver.virtio-entropy
  (:use :cl)
  (:local-nicknames (:sup :mezzano.supervisor)
                    (:virtio :mezzano.supervisor.virtio)
                    (:sync :mezzano.sync)
                    (:sys.int :mezzano.internals))
  (:export #:random-data #:entropy-unavailable))

(in-package :mezzano.driver.virtio-entropy)

(define-condition entropy-unavailable (simple-error) ())

(defstruct entropy-request
  data
  (complete (sup:make-event :name "Entropy request")))

(defstruct entropy-device
  device
  irq
  buffer
  descriptor
  (requests (sync:make-mailbox :name "Entropy requests"))
  (failed (sup:make-event :name "Entropy driver failure"))
  failure
  worker)

(defvar *device* nil)

(defun boot-id (driver)
  (virtio:virtio-device-boot-id (entropy-device-device driver)))

(defmacro with-entropy-device ((driver) &body body)
  `(sup:with-device-access ((boot-id ,driver)
                             (error 'entropy-unavailable
                                    :format-control "Entropy device belongs to an earlier boot."))
     ,@body))

(defun acknowledge-interrupt (driver)
  (let ((device (entropy-device-device driver)))
    (virtio:virtio-ack-irq device (virtio:virtio-isr-status device))
    (sup:simple-irq-unmask (entropy-device-irq driver))))

(defun completion-length (driver queue requested)
  (let* ((seen (virtio:virtqueue-last-seen-used queue))
         (used (virtio:virtio-ring-used-idx queue))
         (delta (ldb (byte 16 0) (- used seen))))
    (when (zerop delta)
      (return-from completion-length nil))
    (sys.int::dma-read-barrier)
    (let* ((entry (rem seen (virtio:virtqueue-size queue)))
           (id (virtio:virtio-ring-used-elem-id queue entry))
           (length (virtio:virtio-ring-used-elem-len queue entry)))
      (unless (and (= delta 1)
                   (eql id (entropy-device-descriptor driver))
                   (<= 1 length requested))
        (error 'entropy-unavailable
               :format-control "Invalid entropy completion: count ~D, descriptor ~D, length ~D for ~D bytes."
               :format-arguments (list delta id length requested)))
      (setf (virtio:virtqueue-last-seen-used queue)
            (ldb (byte 16 0) (1+ seen)))
      length)))

(defun fill-request (driver request)
  (let* ((device (entropy-device-device driver))
         (queue (virtio:virtio-virtqueue device 0))
         (buffer (entropy-device-buffer driver))
         (data (entropy-request-data request))
         (offset 0))
    (loop while (< offset (length data))
          for requested = (min (- (length data) offset) (sup:dma-buffer-length buffer))
          do (sup:with-device-access ((boot-id driver) (return-from fill-request nil))
               (setf (virtio:virtio-ring-desc-length queue (entropy-device-descriptor driver))
                     requested)
               (virtio:virtio-ring-add-to-avail-ring queue (entropy-device-descriptor driver))
               (virtio:virtio-kick device 0))
             (loop
               (sup:with-device-access ((boot-id driver) (return-from fill-request nil))
                 (acknowledge-interrupt driver)
                 (let ((length (completion-length driver queue requested)))
                   (when length
                     (dotimes (i length)
                       (setf (aref data (+ offset i))
                             (sys.int::memref-unsigned-byte-8
                              (sup:dma-buffer-virtual-address buffer) i)
                             (sys.int::memref-unsigned-byte-8
                              (sup:dma-buffer-virtual-address buffer) i) 0))
                     (incf offset length)
                     (return))))
               (sync:wait-for-objects (entropy-device-irq driver) (boot-id driver))))
    (sup:with-device-access ((boot-id driver) (return-from fill-request nil))
      (setf (sup:event-state (entropy-request-complete request)) t))))

(defun release-device (driver)
  (sup:with-device-access ((boot-id driver) nil)
    (let ((device (entropy-device-device driver)))
      (setf (virtio:virtio-device-status device) virtio:+virtio-status-reset+)
      (unless (zerop (virtio:virtio-device-status device))
        (error 'entropy-unavailable :format-control "Entropy device did not reset."))
      (when (entropy-device-irq driver)
        (sup:simple-irq-mask (entropy-device-irq driver)))
      (virtio:virtio-driver-detached device)))
  (when (entropy-device-buffer driver)
    (sup:release-dma-buffer (entropy-device-buffer driver))))

(defun entropy-worker (driver)
  (handler-bind ((error (lambda (condition)
                         (setf (entropy-device-failure driver) condition
                               (sup:event-state (entropy-device-failed driver)) t))))
    (unwind-protect
         (loop
           (sync:wait-for-objects (entropy-device-requests driver)
                                  (entropy-device-irq driver)
                                  (boot-id driver))
           (unless (eql (boot-id driver) (sup:current-boot-id))
             (return))
           (sup:with-device-access ((boot-id driver) (return))
             (acknowledge-interrupt driver))
           (let ((request (sync:mailbox-receive (entropy-device-requests driver) :wait-p nil)))
             (when request (fill-request driver request))))
      (unless (entropy-device-failure driver)
        (setf (entropy-device-failure driver)
              (make-condition 'entropy-unavailable :format-control "Entropy worker stopped.")))
      (setf (sup:event-state (entropy-device-failed driver)) t)
      (release-device driver))))

(defun register-device (device)
  (let ((driver (make-entropy-device :device device))
        (started nil))
    (unwind-protect
         (with-entropy-device (driver)
           (setf (virtio:virtio-device-status device)
                 (logior virtio:+virtio-status-acknowledge+ virtio:+virtio-status-driver+))
           (unless (virtio:virtio-configure-virtqueues device 1)
             (error 'entropy-unavailable :format-control "Cannot allocate entropy queue."))
           (let* ((queue (virtio:virtio-virtqueue device 0))
                  (buffer (sup:make-dma-buffer 4096 :name "Entropy buffer" :contiguous t))
                  (descriptor (virtio:virtio-ring-alloc-descriptor queue)))
             (setf (entropy-device-buffer driver) buffer
                   (entropy-device-descriptor driver) descriptor)
             (unless descriptor
               (error 'entropy-unavailable :format-control "Cannot allocate entropy descriptor."))
             (setf (virtio:virtio-ring-desc-address queue descriptor)
                   (sup:dma-buffer-physical-address buffer)
                   (virtio:virtio-ring-desc-length queue descriptor) 4096
                   (virtio:virtio-ring-desc-flags queue descriptor)
                   (ash 1 virtio:+virtio-ring-desc-f-write+)))
           (setf (entropy-device-irq driver) (sup:make-simple-irq (virtio:virtio-device-irq device)))
           (sup:simple-irq-unmask (entropy-device-irq driver))
           (setf (virtio:virtio-device-status device)
                 (logior virtio:+virtio-status-acknowledge+
                         virtio:+virtio-status-driver+ virtio:+virtio-status-ok+))
           (setf (entropy-device-worker driver)
                 (sup:make-thread (lambda () (entropy-worker driver)) :name "VirtIO entropy"))
           (setf started t
                 *device* driver)
           t)
      (unless started (release-device driver)))))

(defun random-data (count)
  "Return COUNT fresh octets from the VirtIO entropy device."
  (check-type count (integer 0))
  (when (zerop count)
    (return-from random-data (make-array 0 :element-type '(unsigned-byte 8))))
  (let ((driver *device*))
    (unless driver
      (error 'entropy-unavailable :format-control "No VirtIO entropy device is available."))
    (with-entropy-device (driver)
      (when (entropy-device-failure driver)
        (error (entropy-device-failure driver))))
    (let ((request (make-entropy-request
                    :data (make-array count :element-type '(unsigned-byte 8)))))
      (sync:mailbox-send request (entropy-device-requests driver))
      (sync:wait-for-objects (entropy-request-complete request)
                             (entropy-device-failed driver) (boot-id driver))
      (with-entropy-device (driver)
        (when (entropy-device-failure driver)
          (error (entropy-device-failure driver)))
        (assert (sup:event-state (entropy-request-complete request)))
        (entropy-request-data request)))))

(virtio:define-virtio-driver virtio-entropy register-device virtio:+virtio-dev-id-entropy-src+)
