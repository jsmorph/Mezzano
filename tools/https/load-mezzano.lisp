#-mezzano
(error "This loader requires Mezzano.")

(require :asdf)
(asdf:initialize-source-registry
 `(:source-registry
   (:tree ,(merge-pathnames "https-sources/" (user-homedir-pathname)))
   (:tree ,(user-homedir-pathname))
   :ignore-inherited-configuration))
(asdf:load-system :pure-tls/cl+ssl-compat)
(asdf:register-immutable-system "cl+ssl")
(asdf:load-system :drakma)
(asdf:load-system :com.inuoe.jzon)
(load (merge-pathnames "openai.lisp" *load-truename*))
