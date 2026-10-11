#!/bin/sh
set -eu
cd /home/somebody/src/mezzano-boot
make -C home/asdf
cd Mezzano
exec env -u CI sbcl --dynamic-space-size 2048 --non-interactive --load ../quicklisp/setup.lisp --load ../build-live.lisp
