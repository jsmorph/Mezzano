(in-package :mezzano.internals)

;; Sound driver.
(sys.int::cal "sys:source;drivers;sound.lisp")
#+x86-64
(sys.int::cal "sys:source;drivers;intel-hda.lisp")
(sys.int::cal "sys:source;drivers;virtio-sound.lisp")

;; A bunch of GUI related systems.
(require :zpb-ttf)
(require :cl-vectors)
(require :cl-paths-ttf)
;; TCE is required for Chipz's decompressor.
(let ((mezzano.compiler::*perform-tce* t)
      ;; Prevent extremely excessive inlining.
      (mezzano.compiler::*constprop-lambda-copy-limit* -1)
      ;; This inhibits TCE when enabled.
      (mezzano.compiler::*verify-special-stack* nil))
  (require :chipz))
(require :png-read)
(require :cl-jpeg)
(require :skippy)
(require :cl-video)
(require :cl-video-avi)
(require :cl-video-gif)
(require :cl-video-wav)
(require :cl-wav)
;; And the GUI.
(sys.int::cal "sys:source;gui;package.lisp")
(sys.int::cal "sys:source;gui;colour.lisp")
(sys.int::cal "sys:source;gui;surface.lisp")
(sys.int::cal "sys:source;gui;blit.lisp")
#+x86-64
(sys.int::cal "sys:source;gui;blit-x86-64-simd.lisp")
#+arm64
(sys.int::cal "sys:source;gui;blit-generic.lisp")
#+arm64
(sys.int::cal "sys:source;gui;blit-arm64-simd.lisp")
(sys.int::cal "sys:source;gui;keymaps.lisp")
(sys.int::cal "sys:source;gui;theme.lisp")
(sys.int::cal "sys:source;gui;compositor.lisp")
#+x86-64
(sys.int::cal "sys:source;gui;input-drivers.lisp")
#+arm64
(sys.int::cal "sys:source;gui;input-drivers-virtio.lisp")
#+x86-64
(sys.int::cal "sys:source;gui;virtualbox-guest-helper.lisp")
(sys.int::cal "sys:source;system;unifont.lisp")
(sys.int::cal "sys:source;gui;basic-repl.lisp")
(eval (read-from-string "(mezzano.gui.basic-repl:spawn)"))
(sys.int::cal "sys:source;gui;font.lisp")
(sys.int::cal "sys:source;gui;image.lisp")

;; Fonts. Loaded from the home directory.
(ensure-directories-exist "LOCAL:>Fonts>")
(dolist (f (directory (merge-pathnames
                       (make-pathname :directory '(:relative "Fonts" :wild-inferiors) :name :wild :type "ttf")
                       (user-homedir-pathname))))
  (sys.int::copy-file f
             (merge-pathnames "LOCAL:>Fonts>" f)
             '(unsigned-byte 8)))
(sys.int::copy-file (merge-pathnames
                     (make-pathname :directory '(:relative "Fonts") :name "LICENSE")
                     (user-homedir-pathname))
                    "LOCAL:>Fonts>LICENSE"
                    'character)

;; Icons. Loaded from the source tree.
(ensure-directories-exist "LOCAL:>Icons>")
(dolist (f (directory "sys:source;gui;*.png"))
  (sys.int::copy-file f
                      (merge-pathnames "LOCAL:>Icons>" f)
                      '(unsigned-byte 8)))

;: Mouse cursors.
(flet ((load-cursor (path name &optional (hot-x 0) (hot-y 0))
         (let ((surf (funcall (read-from-string "mezzano.gui.image:load-image")
                              (merge-pathnames path "LOCAL:>Icons>"))))
           (funcall (read-from-string "mezzano.gui.compositor:register-mouse-cursor")
            (funcall (read-from-string "mezzano.gui.compositor:make-mouse-cursor")
                     surf :hot-x hot-x :hot-y hot-y)
            name))))
  (load-cursor "cursor-upleft.png"    :arrow-up-left     0   0)
  (load-cursor "cursor-upright.png"   :arrow-up-right    15  0)
  (load-cursor "cursor-downright.png" :arrow-down-right  15 15)
  (load-cursor "cursor-downleft.png"  :arrow-down-left   0  15)
  (load-cursor "cursor-up.png"        :arrow-up          8   0)
  (load-cursor "cursor-right.png"     :arrow-right       15  8)
  (load-cursor "cursor-down.png"      :arrow-down        8  15)
  (load-cursor "cursor-left.png"      :arrow-left        0   8))

;; Remaining GUI files.
(sys.int::cal "sys:source;gui;widgets.lisp")
(sys.int::cal "sys:source;line-edit-mixin.lisp")
(sys.int::cal "sys:source;gui;popup-io-stream.lisp")
;;(eval (read-from-string "(setf (sys.int::symbol-global-value '*terminal-io*) (make-instance 'mezzano.gui.popup-io-stream:lazy-popup-io-stream))"))
(sys.int::cal "sys:source;gui;xterm.lisp")
(sys.int::cal "sys:source;applications;telnet.lisp")
(sys.int::cal "sys:source;applications;mandelbrot.lisp")
(sys.int::cal "sys:source;applications;irc.lisp")
(require :med)
(sys.int::cal "sys:source;applications;peek.lisp")
(sys.int::cal "sys:source;applications;spy.lisp")
(sys.int::cal "sys:source;applications;settings.lisp")
(sys.int::cal "sys:source;applications;fancy-repl.lisp")
(sys.int::cal "sys:source;gui;desktop.lisp")
(sys.int::cal "sys:source;gui;image-viewer.lisp")
(sys.int::cal "sys:source;gui;trentino.lisp")
(sys.int::cal "sys:source;gui;music-player.lisp")
(sys.int::cal "sys:source;applications;filer.lisp")
(sys.int::cal "sys:source;applications;memory-monitor.lisp")
(sys.int::cal "sys:source;gui;starfield.lisp")
;;(eval (read-from-string "(setf mezzano.gui.compositor:*screensaver-spawn-function* 'mezzano.gui.starfield:spawn)"))

;; USB Driver
#-arm64 ; Missing PCI functions.
(progn
  (require :mezzano-usb)
  (require :mezzano-usb/class-drivers)
  (require :mezzano-usb/ohci)
  (require :mezzano-usb/ehci))

#+x86-64
(sys.int::cal "sys:source;drivers;intel-gma.lisp")

;; Load the desktop image and start the desktop.
(sys.int::copy-file (merge-pathnames "common-raven-in-snow--canadian-rockies.jpg" (user-homedir-pathname))
                    "LOCAL:>Desktop.jpeg"
                    '(unsigned-byte 8))
(defvar sys.int::*desktop* (eval (read-from-string "(mezzano.gui.desktop:spawn :image \"LOCAL:>Desktop.jpeg\")")))

