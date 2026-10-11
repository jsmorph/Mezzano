# Mezzano on minideb2

The recorded environment is Debian 13, SBCL 2.5.2, QEMU 10.0.13, and KVM.  Each VM uses two CPUs and 2 GiB RAM.  Commands use `/home/somebody/src/mezzano-boot` as the MBuild directory and run guest services as `somebody`.

The [debugger design](../../../doc/debugger.md) owns capability status and test scope.  The [user guide](../README.md) explains evaluation and retained debugging.  The [journal](../devnotes.md) records build and test results.

## Sources and dependencies

| Component | Recorded revision or version |
|---|---|
| MBuild | `a13448825506c716fb60427f78aafeb6265477b2` |
| Mezzano, including evaluation and restore tests | `bf07d9cbe5f59b6890dbac7cb9b611a3a5acf4c6` |
| Slime implementation | `04d5ef6b725310f2656dd8d7745a42416bfc22ec` |
| Other guest dependencies | Submodule revisions recorded by the MBuild revision above. |
| Host Quicklisp distribution | `2026-01-01`, recorded in `quicklisp/dists/quicklisp/distinfo.txt`. |

The host needs Git, Make, SBCL, QEMU's x86 system emulator, and ripgrep.  The service user needs access to `/dev/kvm`.  A host Quicklisp installation is expected at `quicklisp/` inside the MBuild directory.  The [MBuild prerequisite instructions](https://github.com/froggey/MBuild/blob/a13448825506c716fb60427f78aafeb6265477b2/README.md) describe its installation.  Host Lisp dependencies include Nibbles, CL-PPCRE, Iterate, Alexandria, Closer-MOP, trivial-gray-streams, and CL-FAD for the file server.  SBCL provides the socket library.

For a fresh checkout:

```sh
git clone https://github.com/froggey/MBuild.git /home/somebody/src/mezzano-boot
cd /home/somebody/src/mezzano-boot
git checkout a13448825506c716fb60427f78aafeb6265477b2
git submodule update --init
git -C Mezzano fetch https://github.com/jsmorph/Mezzano.git debugging
git -C Mezzano checkout --detach bf07d9cbe5f59b6890dbac7cb9b611a3a5acf4c6
git -C home/slime fetch https://github.com/jsmorph/slime.git debugging
git -C home/slime checkout --detach 04d5ef6b725310f2656dd8d7745a42416bfc22ec
```

Existing development checkouts use their `debugging` branches.  Another `git submodule update` selects MBuild's older Mezzano and Slime revisions, so explicit revision selection follows submodule initialization.

The branch's `config.lisp` supplies the source and home paths, QEMU host address `10.0.2.2`, and parallel guest compilation.  With SBCL, the host file server binds `127.0.0.1:2599`.

After installing Quicklisp in this build directory, select the recorded host distribution:

```sh
cd /home/somebody/src/mezzano-boot
sbcl --load quicklisp/setup.lisp --eval \
  '(ql-dist:install-dist "http://beta.quicklisp.org/dist/quicklisp/2026-01-01/distinfo.txt" :replace t :prompt nil)' \
  --quit
```

Install the host scripts:

```sh
cd /home/somebody/src/mezzano-boot
cp Mezzano/tools/swank/minideb2/*.sh .
cp Mezzano/tools/swank/minideb2/build-image.lisp .
cp Mezzano/tools/swank/lispm-eval Mezzano/tools/swank/client.lisp .
```

MBuild supplies `run-file-server.lisp`.  The commands below create the development launcher.

## Images and services

| Purpose | Image | Host endpoint | Service |
|---|---|---|---|
| Original live VM | `mezzano-live.image` | `127.0.0.1:4005` | `mezzano-vm.service` |
| Debugger development | `mezzano-debugging.image` | `127.0.0.1:4006` | `mezzano-debugging-vm.service` |
| CI boot test | `mezzano.image` | Serial log | Foreground `boot-test.sh`. |
| Shared guest file access | Host source/dependency trees | `127.0.0.1:2599` | `mezzano-files.service` |

Both live launchers provide standard VGA and hide the host display.  The guest still initializes the desktop.  GUI-free startup remains implementation work.

### Build an image

A VM must be stopped before rebuilding its image.  Run builds sequentially because they share the generated target cache.

The original live image uses:

```sh
cd /home/somebody/src/mezzano-boot
./build-live.sh > build-live.log 2>&1
```

The development image uses the same compiler recipe with another output name:

```sh
cd /home/somebody/src/mezzano-boot
make -C home/asdf
cd Mezzano
rm -rf -- build-x86-64
env -u CI sbcl --dynamic-space-size 2048 \
  --load ../quicklisp/setup.lisp --script ../build-image.lisp \
  ../../mezzano-debugging > ../build-debugging.log 2>&1
```

The relative image base is resolved beneath the generator's build directory, producing the image in the MBuild directory.  The build removes the target cache so every target file is recompiled.  Bootstrap compilation uses `(safety 3 debug 1 speed 1)`.  The running compiler defaults to `(safety 3 debug 3 speed 1)`.

First boot compiles and loads the remaining guest system and applications, then saves a startup snapshot.  The file server must remain available for that work and for later source loading.

### Start the services

The original VM and shared file server use the checked-in startup script, invoked from the SSH client machine:

```sh
tailscale ssh root@minideb2 /home/somebody/src/mezzano-boot/start-live.sh
```

For the development VM, create this launcher in the MBuild directory.  Its contents match the running development setup:

```sh
cat > /home/somebody/src/mezzano-boot/run-debugging.sh <<'SH'
#!/bin/sh
set -eu
cd /home/somebody/src/mezzano-boot
exec qemu-system-x86_64 \
  -enable-kvm -smp 2 -m 2G \
  -drive file=mezzano-debugging.image,format=raw,if=ide \
  -vga std -display none -monitor none -serial file:serial-debugging.log \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:4006-:4005 \
  -device virtio-net,netdev=net0 -no-reboot
SH
chmod +x /home/somebody/src/mezzano-boot/run-debugging.sh
```

In a root SSH session on `minideb2`, start the file server if needed, then the development VM:

```sh
vm_root=/home/somebody/src/mezzano-boot
if ! systemctl is-active --quiet mezzano-files.service; then
  systemd-run --unit=mezzano-files --collect --uid=somebody \
    --property="WorkingDirectory=$vm_root" \
    --property="StandardOutput=append:$vm_root/file-server-live.log" \
    --property=StandardError=inherit "$vm_root/file-server-test.sh"
fi
if ! systemctl is-active --quiet mezzano-debugging-vm.service; then
  systemd-run --unit=mezzano-debugging-vm --collect --uid=somebody \
    --property="WorkingDirectory=$vm_root" \
    --property=Requires=mezzano-files.service \
    --property=After=mezzano-files.service \
    --property="StandardOutput=append:$vm_root/qemu-debugging.log" \
    --property=StandardError=inherit "$vm_root/run-debugging.sh"
fi
```

These transient services survive SSH logout.  Recreate them after a host reboot.  Logs are `serial-live.log`, `qemu-live.log`, `serial-debugging.log`, `qemu-debugging.log`, and `file-server-live.log`.

A successful guest query establishes SWANK access:

```sh
cd /home/somebody/src/mezzano-boot/Mezzano
tools/swank/lispm-eval --port 4006 --timeout 30 \
  '(list (lisp-implementation-version) (mezzano.debug:debugger-stops))'
```

### Snapshot and restore

Save the development guest from its Mezzano checkout:

```sh
tools/swank/lispm-eval --port 4006 --timeout 180 \
  '(mezzano.supervisor:snapshot) (mezzano.supervisor:wait-for-snapshot-completion) (values)'
```

After completion, restart from the SSH client machine:

```sh
tailscale ssh root@minideb2 systemctl restart mezzano-debugging-vm.service
```

Restart loads the latest saved image.  Unsaved guest changes disappear.  Host source files and test logs have their own persistence.  Restored debugger references follow the [boot and restore rules](../../../doc/debugger.md#disconnect-and-restore).

## Tests

The [test catalog](../../../doc/debugger.md#test-scope-and-provenance) describes what each test establishes.  Run guest tests sequentially on port 4006.  Restore fixtures share counters and require separate runs.  A failed test can leave a stopped fixture available for inspection.

### Full build and CI boot

The file server must be running:

```sh
cd /home/somebody/src/mezzano-boot
./build-test.sh > build.log 2>&1
./boot-test.sh > boot.log 2>&1
```

The test uses its separate image, initializes the desktop, and expects QEMU status 3 and `CI build completed successfully!`.  Serial output is in `serial.log`.  The build removes the generated target cache.

### Evaluation, compiler, and debugger tests

From the Mezzano checkout:

```sh
python3 tools/swank/test-lispm-eval.py --port 4006
sbcl --script tools/swank/test-debugger.lisp 4006
sbcl --script tools/swank/test-debugger-reconnect.lisp 4006
sbcl --script tools/swank/test-evaluation-reconnect.lisp 4006
```

Run guest Lisp tests with the updated compiler and backend loaded:

```sh
for test_name in TEST-FOOTHOLD-GC TEST-INTERRUPT-RETURN-GC \
  TEST-STRUCTURE-LAYOUTS TEST-FRAME-LOCALS \
  TEST-DEBUG-BINDINGS TEST-DEBUG-BINDING-WRITES TEST-DEBUG-CLOSURE-WRITES \
  TEST-DEBUG-POLICY TEST-KEYWORD-LOWERING TEST-JUMP-TABLE-BINDINGS \
  TEST-DEBUGGER-SERVICE TEST-EVALUATION-SERVICE TEST-EVALUATION-INTERRUPT
do
  tools/swank/lispm-eval --port 4006 --timeout 180 \
    "(load (compile-file \"SYS:SOURCE;TOOLS;SWANK;$test_name.LISP\")) (values)" ||
    exit "$?"
done
```

### Guest stop restore

Load the helpers and prepare a parked stop with a completed frame-list command:

```sh
tools/swank/lispm-eval --port 4006 --timeout 180 <<'LISP'
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE.LISP"))
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE-RESTORE.LISP"))
(lispm-service-test::prepare-restore-test)
(mezzano.supervisor:snapshot)
(mezzano.supervisor:wait-for-snapshot-completion)
(values)
LISP
```

Restart the development VM using the command above, then run:

```sh
tools/swank/lispm-eval --port 4006 --timeout 120 \
  '(lispm-service-test::finish-restore-test) (values)'
```

For a running command blocked on a Lisp event, use `prepare-running-restore-test` and `finish-running-restore-test` in place of the parked-stop functions.  To test rollback from a completed original execution to the saved running state, issue this separate evaluation after snapshot completion and before VM restart:

```sh
tools/swank/lispm-eval --port 4006 --timeout 120 <<'LISP'
(setf (mezzano.supervisor:event-state lispm-service-test::*probe-gate*) t)
(lispm-service-test::completed-command
 lispm-service-test::*running-restore-handle*
 lispm-service-test::*running-restore-command-id*)
LISP
```

The completion phase checks the restored state before releasing the event and recovering the application.

For queued-command expiration, use `prepare-queued-restore-test` and `finish-queued-restore-test` in place of the parked-stop functions.  Preparation stops the target thread with the supervisor's thread controls, then queues a restart command.  After restore, completion resumes the thread and checks that the old command expires without invoking the restart.  It then submits a fresh restart command and recovers the application.

### Remote session restore

The host state file must survive the VM restart:

```sh
sbcl --script tools/swank/test-debugger-remote-restore.lisp \
  prepare 4006 ../debugger-client-state.sexp
```

Restart the development VM, then run:

```sh
sbcl --script tools/swank/test-debugger-remote-restore.lisp \
  finish 4006 ../debugger-client-state.sexp
```

### Evaluation job restore

The evaluation test uses a host state file for one completed job and one condition-stopped job with partially consumed batch input:

```sh
sbcl --script tools/swank/test-evaluation-reconnect.lisp \
  4006 prepare ../evaluation-restore-state.sexp
```

Restart the development VM, then run:

```sh
sbcl --script tools/swank/test-evaluation-reconnect.lisp \
  4006 finish ../evaluation-restore-state.sexp
```

For an interactive job waiting within a partially read line, use `prepare-input` and `finish-input` in place of `prepare` and `finish`, with a separate host state file.

For queued and running evaluation interruptions, use `prepare-interrupt` and `finish-interrupt` with a separate host state file.  The queued request must expire after restore.  The running interrupt stop must continue through a fresh session with one body entry and one cleanup.

After a successful restore test, save the completed guest state using the snapshot command.  That replaces the saved test stop with the completed state.
