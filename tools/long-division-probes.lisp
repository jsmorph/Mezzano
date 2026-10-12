(defpackage :mezzano-long-division-probes
  (:use :cl))
(in-package :mezzano-long-division-probes)

(declaim (optimize (speed 3) (safety 3) (debug 1)))

(defun read-index (v i)
  (declare (type (simple-array (unsigned-byte 32) (*)) v)
           (type fixnum i))
  (aref v i))

(defun read-sum (v i j)
  (declare (type (simple-array (unsigned-byte 32) (*)) v)
           (type fixnum i j))
  (aref v (+ i j)))

(defun read-checked-sum (v i j)
  (declare (type (simple-array (unsigned-byte 32) (*)) v)
           (type fixnum i j))
  (aref v (the fixnum (+ i j))))
