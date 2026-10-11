# Mezzano on minideb2

These scripts record the tested build and QEMU setup on `minideb2`: Debian 13, SBCL 2.5.2, QEMU 10.0.13, KVM, two guest CPUs, and 2 GiB guest RAM.  They use `/home/somebody/src/mezzano-boot` as the MBuild working directory and run the services as `somebody`.

## Build directory

The scripts expect the Mezzano checkout in `Mezzano/`, MBuild's dependencies in `home/`, and the host Quicklisp installation in `quicklisp/`.  The [MBuild instructions](https://github.com/froggey/MBuild/blob/a13448825506c716fb60427f78aafeb6265477b2/README.md) specify the host Lisp dependencies.  The tested MBuild revision is `a13448825506c716fb60427f78aafeb6265477b2`.

The branch's `config.lisp` sets the source and home paths for this directory, uses QEMU's host address `10.0.2.2`, and enables parallel guest compilation.  The host file server binds `127.0.0.1:2599`.

Install the scripts from this checkout into the MBuild working directory:

```sh
cd /home/somebody/src/mezzano-boot
cp Mezzano/tools/swank/minideb2/*.sh .
cp Mezzano/tools/swank/minideb2/build-live.lisp .
cp Mezzano/tools/swank/lispm-eval .
```

## Build and run

```sh
./build-live.sh > build-live.log 2>&1
```

This builds `mezzano-live.image`.  The VM must be stopped before rebuilding its image.  First boot compiles and loads the guest system and applications, then saves a startup snapshot.

From a machine with Tailscale SSH access:

```sh
tailscale ssh root@minideb2 /home/somebody/src/mezzano-boot/start-live.sh
tailscale ssh root@minideb2 systemctl status mezzano-vm.service mezzano-files.service
tailscale ssh root@minideb2 systemctl restart mezzano-vm.service
```

`start-live.sh` creates transient systemd services for the file server and VM.  Active services keep running.  The services survive SSH logout.  Running the script after a host reboot recreates them.  `run-live.sh` forwards `127.0.0.1:4005` to guest port 4005.  `serial-live.log`, `qemu-live.log`, and `file-server-live.log` record execution.

## Boot test

`build-test.sh` builds the separate CI image, `mezzano.image`.  `boot-test.sh` starts it, waits for desktop initialization, and checks QEMU exit status 3 and `CI build completed successfully!`.  The file server must be running.  `file-server-test.sh` starts it in the foreground when the service is inactive.

```sh
./build-test.sh > build.log 2>&1
./boot-test.sh
```

The boot test exits the guest after successful initialization.  Its serial output is in `serial.log`.
