(ql:quickload '(:nibbles :cl-ppcre :iterate :alexandria :closer-mop :trivial-gray-streams))
(push *default-pathname-defaults* asdf:*central-registry*)
(asdf:load-system :lispos)
(cold-generator:set-up-cross-compiler :architecture :x86-64)
(cold-generator::make-image "../../mezzano-live"
                            :image-size (* 5 1024 1024 1024)
                            :header-path "tools/disk-header.bin")
(format t "Build successful!~%")
