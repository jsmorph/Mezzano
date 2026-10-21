;;;; Initial Program Load.
;;;;
;;;; This file loads loads and configures the rest of the system,
;;;; once the core Lisp environment is operational.

(in-package :mezzano.internals)

(defvar *desktop-enabled* t)

;; Take over the debugger for the duration, this so that early errors
;; can be caught and made to produce a sensible error instead of
;; "serial read char not implemented"
;; This is undone at the end of the file.
(defun ipl-debugger (condition)
  (format t "----- ERROR -----~%")
  (format t "Error during warm initialization:~%")
  (format t "~A~%" condition)
  (mezzano.supervisor:panic (format nil "~A" condition)))
(setf mezzano.debug:*global-debugger* 'ipl-debugger)

;; Fast eval mode.
(setf sys.int::*eval-hook* 'mezzano.fast-eval:eval-in-lexenv)

;;; mezzano.file-system::*filesystem-alist* is a mapping from
;;; partition UUIDs to file system host names. These mappings should
;;; be set up for the local system configuration. For example:
;;;
;;; (setf mezzano.file-system::*filesystems-alist*
;;;       '(("8F51-4F7E" MNT)
;;;         ("a3a2162c-6272-401b-b621-a97b65c3f871" HOME)))
;;;
;;; For FAT file systems, the 32-bit BS_VolID (Volume serial number)
;;; is used as the "UUID" - for example the MNT entry in the example
;;; above.

;; register supervisor disks as block devices
(mezzano.disk:register-supervisor-disks)

;; Host where the initial system is kept.
;; Change the IP to the host computer's local IP.
(mezzano.file-system.remote:add-remote-file-host :remote sys.int::*file-server-host-ip*)
;; Use PATHNAME instead of #p because the cross-compiler doesn't support #p.
;; Point *DEFAULT-PATHNAME-DEFAULTS* at the full path to the source tree.
(setf *default-pathname-defaults* (pathname *mezzano-source-path*))
;; Point MEZZANO.FILE-SYSTEM::*HOME-DIRECTORY* at the home directory containing the libraries.
(setf mezzano.file-system::*home-directory* (pathname *home-directory-path*))

(push (list "SOURCE;**;*.*.*" (merge-pathnames (make-pathname :directory '(:relative :wild-inferiors))
                                               *default-pathname-defaults*))
      (logical-pathname-translations "SYS"))

(push (list "HOME;**;*.*.*" (merge-pathnames  (make-pathname :directory '(:relative :wild-inferiors))
                                              (user-homedir-pathname)))
      (logical-pathname-translations "SYS"))

(defun sys.int::check-connectivity ()
  ;; Make sure that there's one network card, excluding the loopback adapter.
  (flet ((known-interfaces ()
           (remove-if (lambda (x) (typep (first x) 'mezzano.network::loopback-interface))
                      mezzano.network.ip::*ipv4-interfaces*)))
    (loop
       with timeout = 30.0
       do
         (when (known-interfaces)
           (return))
         (when (minusp timeout)
           (format t "No network cards detected!~%~
Make sure there is a virtio-net NIC attached.~%")
           (return-from sys.int::check-connectivity))
         (sleep 0.1)
         (decf timeout 0.1))
    (when (not (null (rest (known-interfaces))))
      (format t "Multiple network cards detected! Not supported, but trying anyway.~%"))
    (format t "Using network card ~S.~%" (first (first (known-interfaces)))))
  ;; Check connectivity to the file-server.
  (let ((fs-address (mezzano.network.ip:make-ipv4-address sys.int::*file-server-host-ip*)))
    (format t "File server has address ~A, port ~D.~%" fs-address mezzano.file-system.remote::*default-remote-file-port*)
    (when (mezzano.network.ip:address-equal
           (mezzano.network.ip:address-network fs-address 24)
           (mezzano.network.ip:make-ipv4-address "10.0.2.0"))
      (format t "Warning! This is on a 10/8 network and is not supported.~%"))
    (when (mezzano.network.ip:address-equal
           fs-address
           (mezzano.network.ip:make-ipv4-address "127.0.0.1"))
      (format t "Warning! This is the local loopback address, and is probably not what you want.~%"))
    (format t "Pinging file server host... ")
    (finish-output)
    (cond ((mezzano.network.ip:ping-host sys.int::*file-server-host-ip* :quiet t)
           (format t "OK!~%"))
          (t
           (format t "Failed! No responses received! This may not be reliable.~%"))))
  ;; Try basic access to the file server. Just enough to talk to it.
  (format t "Testing access to file server... ")
  (finish-output)
  (mezzano.file-system.remote:test-host-connectivity
   (mezzano.file-system:find-host :remote))
  (format t "OK!~%")
  ;; Check connectivity to the internet.
  (format t "Testing internet connectivity.~%")
  (format t "Attempting to resolve google.com... ")
  (finish-output)
  (let ((goog (mezzano.network::resolve-address "google.com" nil)))
    (cond (goog
           (format t "OK!~%")
           (format t "Has address ~A.~%" goog))
          (t
           (format t "Failed! Unable to resolve! This may not be reliable.~%")))))

(sys.int::check-connectivity)

;; Local FS. Loaded from the source tree, not the home directory.
(sys.int::cal "sys:source;file;local.lisp")
(eval (read-from-string "(mezzano.file-system.local:add-local-file-host :local)"))

;; ASDF.
(sys.int::cal "sys:home;asdf;build;asdf.lisp")

(defun home-source-registry ()
  `(:source-registry
    (:tree ,(user-homedir-pathname))
    :inherit-configuration))
(eval (read-from-string "(push 'home-source-registry asdf:*default-source-registries*)"))

(defun driver-source-registry ()
  `(:SOURCE-REGISTRY
    (:TREE ,(pathname "SYS:SOURCE;DRIVERS;"))
    (:TREE ,(pathname "SYS:SOURCE;GUI;VIRGL;"))
    :INHERIT-CONFIGURATION))
(eval (read-from-string "(push 'driver-source-registry asdf:*default-source-registries*)"))

;; Split-sequence
(require :split-sequence)
(require :com.inuoe.jzon)

(defvar sys.int::*init-file-path* "SYS:HOME;INIT.LISP")

(defun sys.int::load-init-file ()
  (when (and (boundp 'sys.int::*init-file-path*)
             sys.int::*init-file-path*)
    (load sys.int::*init-file-path*)))

(defun finish-initialization ()
  (sys.int::cal "sys:source;file;ext4.lisp")
  (sys.int::cal "sys:source;file;http.lisp")
  (sys.int::cal "sys:source;net;http-demo.lisp")
  (sys.int::cal "sys:source;system;disassemble.lisp")
  (sys.int::cal "sys:source;system;disassemble-x86-64.lisp")
  (sys.int::cal "sys:source;system;disassemble-arm64.lisp")
  (sys.int::cal "sys:source;system;lldb.lisp")

  (when *desktop-enabled*
    (sys.int::cal "sys:source;ipl-desktop.lisp"))

  (mezzano.supervisor:add-boot-hook 'sys.int::load-init-file :late)
  (sys.int::load-init-file))

;; Swank doesn't really support logical pathname shenanigans.

(load (merge-pathnames (make-pathname :directory '(:relative "slime") :name "swank-loader" :type "lisp")
                       (user-homedir-pathname)))
(eval (read-from-string "(swank-loader::init)"))
(eval (read-from-string "(swank:create-server :style :spawn :dont-close t :interface \"0.0.0.0\")"))

(setf mezzano.debug:*global-debugger* nil)

(when (and (call-with-startup-sequence :initialization #'finish-initialization)
           (mezzano.supervisor:running-in-ci-p))
  (mezzano.supervisor:debug-print-line "****")
  (mezzano.supervisor:debug-print-line "CI build completed successfully!")
  (mezzano.supervisor:ci-exit))

;; Done.
