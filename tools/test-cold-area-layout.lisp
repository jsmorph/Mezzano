(ql:quickload '(:nibbles :cl-ppcre :iterate :alexandria :closer-mop :trivial-gray-streams) :silent t)
(push *default-pathname-defaults* asdf:*central-registry*)
(asdf:load-system :lispos)

(dolist (case '((8192 3000 4096) (4096 4096 4096) (32 18 4096) (4096 0 0)))
  (destructuring-bind (capacity used padded) case
    (let* ((area (make-instance 'mezzano.cold-generator.serialize::area
                               :name :padding-test :base 0))
           (data (make-array capacity :element-type '(unsigned-byte 8)
                                      :initial-element #xAA :adjustable t :fill-pointer used)))
      (setf (slot-value area 'mezzano.cold-generator.serialize::%data) data)
      (dotimes (index used) (setf (aref data index) (mod index 256)))
      (mezzano.cold-generator.serialize::pad-area-data area padded)
      (assert (eq data (mezzano.cold-generator.serialize::area-data area)))
      (assert (= (length data) padded))
      (assert (= (array-dimension data 0) (max capacity padded)))
      (dotimes (index used) (assert (= (aref data index) (mod index 256))))
      (loop for index from used below padded do (assert (zerop (aref data index)))))))
(format t "PASS cold-area capacity reuse, growth, prefix preservation, and zero padding.~%")

(let* ((areas
         (loop for pages in '(1 2 3 1 2 1)
               for byte from #x11 by #x11
               for base from 0 by #x20000000
               collect
               (let ((area (make-instance 'mezzano.cold-generator.serialize::area
                                          :name byte :base base)))
                 (setf (slot-value area 'mezzano.cold-generator.serialize::%data)
                       (make-array (* pages 4096) :element-type '(unsigned-byte 8)
                                   :initial-element byte :adjustable t :fill-pointer t))
                 area)))
       (image (make-instance 'mezzano.cold-generator.serialize::image
                            :wired-area (first areas) :pinned-area (second areas)
                            :general-area (third areas) :cons-area (fourth areas)
                            :wired-function-area (fifth areas) :function-area (sixth areas)))
       (expected (reduce #'+ areas :key #'mezzano.cold-generator.serialize::area-size))
       (pathname (make-pathname :name (symbol-name (gensym "mezzano-cold-areas-"))
                                :type "bin" :defaults #P"/tmp/"))
       (created-p nil))
  (unwind-protect
       (with-open-file (stream pathname :direction :io :element-type '(unsigned-byte 8)
                                       :if-exists :error :if-does-not-exist :create)
         (setf created-p t)
         (let ((mezzano.cold-generator.write::*store-bump* 0)
               (map (make-array 512 :initial-element nil)))
           (mezzano.cold-generator.write::write-areas image stream 0 map)
           (assert (= mezzano.cold-generator.write::*store-bump* expected)
                   () "Area cursor ~D, expected ~D."
                   mezzano.cold-generator.write::*store-bump* expected)
           (loop with block = 0
                 for area in areas
                 for index from 0
                 for flags = (logior mezzano.internals::+block-map-present+
                                     mezzano.internals::+block-map-writable+
                                     (case index
                                       ((0 4) mezzano.internals::+block-map-wired+)
                                       ((2 3) mezzano.internals::+block-map-track-dirty+)
                                       (t 0)))
                 do (loop for offset from 0 below (mezzano.cold-generator.serialize::area-size area) by 4096
                          for address = (+ (mezzano.cold-generator.serialize::area-base area) offset)
                          for entry = (reduce (lambda (table shift)
                                                (aref table (ldb (byte 9 shift) address)))
                                              '(39 30 21 12) :initial-value map)
                          do (assert (= entry (logior flags
                                                       (ash block mezzano.internals::+block-map-id-shift+))))
                             (incf block))))
         (finish-output stream)
         (assert (= (file-length stream) expected))
         (file-position stream 0)
         (loop for area in areas
               for byte from #x11 by #x11
               do (dotimes (index (mezzano.cold-generator.serialize::area-size area))
                    (assert (= (read-byte stream) byte)))))
    (when (and created-p (probe-file pathname)) (delete-file pathname))))
(format t "PASS unequal cold-area lengths, complete bytes, file cursor, and page mappings.~%")
