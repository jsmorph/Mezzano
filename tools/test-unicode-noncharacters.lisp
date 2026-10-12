(defpackage :mezzano-unicode-test
  (:use :cl)
  (:export :run))
(in-package :mezzano-unicode-test)

(defun run ()
  (let ((codes (append (loop for code from #xfdd0 to #xfdef collect code)
                       (loop for plane from 0 to 16
                             append (list (+ (ash plane 16) #xfffe)
                                          (+ (ash plane 16) #xffff))))))
    (assert (= (length codes) 66))
    (dolist (code codes)
      (let* ((character (code-char code))
             (text (string character))
             (octets (mezzano.internals::string-to-octets text)))
        (assert (= (char-code character) code))
        (assert (mezzano.internals::unicode-scalar-value-p code))
        (assert (string= text (mezzano.internals::octets-to-string octets)))
        (let ((format (mezzano.internals::make-external-format 'character :utf-8))
              (position 0))
          (assert
           (char= character
                  (mezzano.internals::external-format-read-internal-code-point
                   format octets
                   (lambda (source)
                     (if (< position (length source))
                         (prog1 (aref source position) (incf position))
                         :eof)))))))))
  (loop for code from #xd800 to #xdfff
        do (assert (null (code-char code)))
           (assert (not (mezzano.internals::unicode-scalar-value-p code))))
  (dolist (code '(-1 #x110000))
    (assert (not (mezzano.internals::unicode-scalar-value-p code)))
    (assert (handler-case (progn (code-char code) nil) (type-error () t))))
  (format t "PASS 66 Unicode noncharacters, UTF-8 decoding, surrogates, and range checks.~%")
  t)
(in-package :cl-user)
