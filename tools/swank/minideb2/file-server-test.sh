#!/bin/sh
set -eu
cd /home/somebody/src/mezzano-boot/Mezzano/file-server
exec sbcl --non-interactive --load ../../quicklisp/setup.lisp --load ../../run-file-server.lisp
