#!/bin/sh
set -eu
root=/home/somebody/src/mezzano-boot
if ! systemctl is-active --quiet mezzano-files.service; then
  systemd-run --unit=mezzano-files --collect --uid=somebody \
    --property="WorkingDirectory=$root" \
    --property="StandardOutput=append:$root/file-server-live.log" \
    --property=StandardError=inherit "$root/file-server-test.sh"
fi
if ! systemctl is-active --quiet mezzano-vm.service; then
  systemd-run --unit=mezzano-vm --collect --uid=somebody \
    --property="WorkingDirectory=$root" \
    --property=Requires=mezzano-files.service \
    --property=After=mezzano-files.service \
    --property="StandardOutput=append:$root/qemu-live.log" \
    --property=StandardError=inherit "$root/run-live.sh"
fi
