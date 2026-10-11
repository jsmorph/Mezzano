#!/bin/sh
set -eu
cd /home/somebody/src/mezzano-boot
set +e
qemu-system-x86_64 \
  -enable-kvm -smp 2 -m 2G \
  -drive file=mezzano.image,format=raw,if=ide \
  -vga std -display none -monitor none -serial stdio \
  -netdev user,id=net0 -device virtio-net,netdev=net0 \
  -device isa-debug-exit,iobase=0xf4,iosize=0x04 \
  -no-reboot < /dev/null >serial.log 2>&1
status=$?
set -e
printf '%s\n' "$status" >qemu.exit
printf 'QEMU exit status: %s\n' "$status"
if [ "$status" -ne 3 ]; then
  exit 1
fi
rg --color never -F 'CI build completed successfully!' serial.log
