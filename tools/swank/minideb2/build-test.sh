#!/bin/sh
set -eu
cd /home/somebody/src/mezzano-boot
make -C home/asdf
cd Mezzano
rm -rf -- build-x86-64
CI=true sbcl --dynamic-space-size 3072 --load ../quicklisp/setup.lisp --script ../build-image.lisp ../../mezzano
