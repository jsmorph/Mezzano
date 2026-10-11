#!/bin/sh
set -eu
cd /home/somebody/src/mezzano-boot
make -C home/asdf
cd Mezzano
rm -rf -- build-x86-64
CI=true sbcl --dynamic-space-size 2048 --non-interactive --load ../quicklisp/setup.lisp --load ../build-cold-image.lisp
