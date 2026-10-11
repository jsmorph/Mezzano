#!/bin/sh
set -eu
cd /home/somebody/src/mezzano-boot
exec qemu-system-x86_64 \
  -enable-kvm -smp 2 -m 2G \
  -drive file=mezzano-live.image,format=raw,if=ide \
  -vga std -display none -monitor none -serial file:serial-live.log \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:4005-:4005 \
  -device virtio-net,netdev=net0 -no-reboot
