#-mezzano
(error "This loader requires Mezzano.")

(require :asdf)
(asdf:load-asd (merge-pathnames "mezzano-web.asd" *load-truename*))
(asdf:load-system :mezzano-web)
