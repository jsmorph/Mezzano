(require :sb-bsd-sockets)

(defpackage #:lispm-swank-client
  (:use #:cl)
  (:export #:call-with-connection #:send-packet #:receive-message))
(in-package #:lispm-swank-client)

(defun send-packet (stream text)
  (let* ((bytes (sb-ext:string-to-octets text :external-format :utf-8))
         (size (length bytes)))
    (unless (< size #x1000000) (error "Swank request exceeds its 24-bit length field."))
    (write-sequence (sb-ext:string-to-octets (format nil "~6,'0X" size)
                                           :external-format :ascii) stream)
    (write-sequence bytes stream)
    (finish-output stream)))

(defun read-bytes (stream count)
  (let* ((bytes (make-array count :element-type '(unsigned-byte 8)))
         (received (read-sequence bytes stream)))
    (unless (= received count)
      (error "Swank closed the connection after ~D of ~D bytes." received count))
    bytes))

(defun receive-message (stream)
  (let* ((header (sb-ext:octets-to-string (read-bytes stream 6)
                                        :external-format :ascii))
         (text (sb-ext:octets-to-string (read-bytes stream (parse-integer header :radix 16))
                                       :external-format :utf-8)))
    (let ((*read-eval* nil))
      (read-from-string text))))

(defun call-with-connection (host port seconds function)
  (let ((socket (make-instance 'sb-bsd-sockets:inet-socket
                               :type :stream :protocol :tcp)))
    (unwind-protect
         (sb-ext:with-timeout seconds
           (sb-bsd-sockets:socket-connect
            socket
            (sb-bsd-sockets:host-ent-address
             (sb-bsd-sockets:get-host-by-name host))
            port)
           (funcall function
                    (sb-bsd-sockets:socket-make-stream
                     socket :input t :output t
                     :element-type '(unsigned-byte 8) :buffering :full)))
      (sb-bsd-sockets:socket-close socket))))
