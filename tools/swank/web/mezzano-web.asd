(asdf:defsystem #:mezzano-web
  :description "Mezzano Web Listener and Debugger"
  :depends-on (#:com.inuoe.jzon #:babel)
  :serial t
  :components ((:file "../../../net/http-server")
               (:file "http-api")))
