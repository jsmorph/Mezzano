# Installation and operation

This guide builds the remote-development image and runs it under x86-64 QEMU with KVM on Linux.  The guest receives two virtual CPUs and 2 GiB of memory.  QEMU hides its display, while the guest still initializes its desktop.  Remote access uses SWANK and the optional Web interface.

## Requirements

The host needs Git, Make, a 64-bit SBCL with Unicode support, QEMU's x86 system emulator, and access to `/dev/kvm`.  Building requires a host Quicklisp installation.  The image builder loads Nibbles, CL-PPCRE, Iterate, Alexandria, Closer-MOP, and trivial-gray-streams.  The file server also loads CL-FAD and SBCL's socket library.

The Web server requires Python 3.13 or later.  Its uv launch command and access settings appear in the [Web guide](../tools/swank/web/README.md).  The Lisp clients require SBCL.

## Source checkout

Choose an absolute build directory.  This example creates `mezzano-build` beneath the current directory.  MBuild supplies Mezzano and the guest dependencies as submodules.  Select the remote-development Mezzano and Slime branches after initializing those submodules:

```sh
build_root="$PWD/mezzano-build"
git clone https://github.com/froggey/MBuild.git "$build_root"
cd "$build_root"
git checkout a13448825506c716fb60427f78aafeb6265477b2
git submodule update --init
git -C Mezzano fetch https://github.com/jsmorph/Mezzano.git debugging
git -C Mezzano checkout -b debugging FETCH_HEAD
git -C home/slime fetch https://github.com/jsmorph/slime.git debugging
git -C home/slime checkout -b debugging FETCH_HEAD
```

These branch selections provide the retained debugger protocol and Web tools described by these manuals.  Running `git submodule update` again restores MBuild's recorded Mezzano and Slime revisions.  Updating an existing installation therefore requires selecting the intended revisions again.

Install [Quicklisp](https://www.quicklisp.org/beta/#installation) at `quicklisp/` beneath the build directory.  The commands below load its `setup.lisp` explicitly.

## JSON libraries

Jzon requires additional source checkouts beneath the guest home directory.  Run these commands from the build directory before the image's first boot:

```sh
git clone https://github.com/jsmorph/jzon.git home/jzon
git -C home/jzon checkout --detach 8f8099ae762d54de9cbe2a084fc52ae3de96ee7d
git clone https://github.com/Shinmera/float-features.git home/float-features
git -C home/float-features checkout --detach cd5dab00d2f4a562d65f46b3fc1cecec308e2443
git clone https://github.com/Shinmera/documentation-utils.git home/documentation-utils
git -C home/documentation-utils checkout --detach fcbd927dee7f311915a27ee557e3db1d4510403c
git clone https://github.com/Shinmera/trivial-indent.git home/trivial-indent
git -C home/trivial-indent checkout --detach 87b35ff9202b107230e35790e93c471cc7880900
```

These pins select Jzon 1.1.4 with a [numeric-range correction](https://github.com/jsmorph/jzon/compare/99b19fb18ab3555c04564a51a990db06ed1d8a23...8f8099ae762d54de9cbe2a084fc52ae3de96ee7d) and its additional dependencies.  The correction rejects provable floating-point overflow and underflow before constructing large powers of ten.  MBuild supplies Closer-MOP, Flexi Streams, trivial-gray-streams, trivial-features, and ASDF/UIOP.  The guest's ASDF registry discovers sources beneath `home/`.  The [JSON reference](json.md) describes loading and using Jzon in an existing image.

## Image configuration

The guest reads source and dependency files through the host file server.  Edit `Mezzano/config.lisp` so the two REMOTE directories contain the absolute paths to your checkout.  Preserve their trailing slashes.  For a build directory `/srv/mezzano-build`, the configuration is:

```lisp
(in-package :mezzano.internals)
(defparameter *file-server-host-ip* "10.0.2.2")
(defparameter *home-directory-path* "REMOTE:/srv/mezzano-build/home/")
(defparameter *mezzano-source-path* "REMOTE:/srv/mezzano-build/Mezzano/")
(setf *compile-parallel* t)
```

`10.0.2.2` is the host address visible through QEMU's default user network.  The REMOTE directories refer to host files.  They must match the paths the file server can read.

## Build an image

Run these commands from the build directory.  Use an output name belonging to a stopped VM.  Builds share the generated target cache and must run sequentially.

```sh
build_root="$PWD"
make -C home/asdf
cd Mezzano
rm -rf -- build-x86-64
env -u CI sbcl --dynamic-space-size 3072 \
  --load ../quicklisp/setup.lisp --script tools/build-image.lisp \
  "$build_root/mezzano" > "$build_root/build.log" 2>&1
```

Removing `build-x86-64` discards generated compiler output and forces a full build.  The host builder uses a 3 GiB dynamic-space limit to hold compiler state, target data, and temporary buffer growth during serialization.  The builder writes `mezzano.image`, a five-GiB image, beneath the build directory.  Bootstrap compilation uses `(safety 3 debug 1 speed 1)`.  CLOS discriminator constructors declare DEBUG 3 to retain their owning generic function for debugger inspection.  The running compiler defaults to `(safety 3 debug 3 speed 1)`.  The [compiler guarantees](debugger.md#compiler-guarantees) describe their effect on local inspection.

The host serializer tests check cold function headers, area-buffer padding, and disk layout with unequal area sizes:

```sh
sbcl --dynamic-space-size 2048 --load ../quicklisp/setup.lisp \
  --script tools/test-cold-function-metadata.lisp
sbcl --dynamic-space-size 2048 --load ../quicklisp/setup.lisp \
  --script tools/test-cold-area-layout.lisp
```

These commands run from the Mezzano checkout.  The debugger tests in the [remote client guide](../tools/swank/README.md#debugger-frame-tests) execute in the guest.

## Start the file server and VM

In one terminal, start the file server from the build directory:

```sh
cd Mezzano/file-server
sbcl --non-interactive --load ../../quicklisp/setup.lisp \
  --load ../../run-file-server.lisp
```

Under SBCL, the file server listens on `127.0.0.1:2599`.  It serves host files without a per-checkout access restriction.  Keep it available during startup compilation and later guest file access.  A REMOTE connection waits for an IPv4 route within the TCP connection deadline, which defaults to ten seconds.  If no route arrives, it signals MEZZANO.NETWORK:NETWORK-TIMEOUT.  This permits file access during DHCP startup and image restoration.

The SBCL server handles each connection in a separate Lisp thread, with its own file table.  Multiple guests can keep connections open concurrently.  Server shutdown closes its client sockets and joins their threads.  The non-SBCL backend still serves one connected client at a time.  The [host file-server tests](../file-server/TESTING.md) cover concurrent connections and shutdown.

In another terminal, start QEMU from the build directory:

```sh
qemu-system-x86_64 -enable-kvm -smp 2 -m 2G \
  -drive file=mezzano.image,format=raw,if=ide \
  -vga std -display none -monitor none -serial file:serial.log \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:4005-:4005 \
  -device virtio-net,netdev=net0 -no-reboot
```

The guest uses DHCP on the virtual network.  Host loopback port 4005 forwards to guest SWANK port 4005.  Change the host forwarding port when running another guest.  `serial.log` records boot output.  First boot compiles and loads the remaining system and applications and saves startup state.  With empty library caches, this can take tens of minutes.  SWANK starts before desktop initialization finishes.

A SWANK query from the Mezzano checkout checks that remote evaluation is ready:

```sh
sbcl --script tools/swank/lispm-eval --host 127.0.0.1 --port 4005 \
  --timeout 30 '(lisp-implementation-version)'
```

The included clients and Web server connect directly to SWANK without a shared-secret handshake.  Their endpoint must accept that protocol.  SWANK access grants Lisp evaluation in the guest.  The QEMU example exposes it only on host loopback.

## Web access

Start the Web server from the Mezzano checkout with the SWANK port chosen above:

```sh
uv run --no-python-downloads --python python3 tools/swank/web/server.py \
  --listen 0.0.0.0 --port 8765 --allow-host lispm.example.net \
  --swank-host 127.0.0.1 --swank-port 4005
```

Replace `lispm.example.net` with the hostname clients use to reach the host.  Open `http://lispm.example.net:8765/`.  The [Web guide](../tools/swank/web/README.md#access-restrictions) specifies host checks, browser-origin checks, and access restrictions.  The HTTP service grants guest evaluation and debugger control and provides no account authentication or TLS.

### Pinned Web deployment

The server reads static files from its script directory on each request.  A persistent service can use a revision-named deployment directory so development edits do not change the served client.  This example runs from the Mezzano checkout and creates the deployment beside it:

```sh
web_revision="$(git rev-parse HEAD)"
web_release="$PWD/../web-releases/$web_revision"
mkdir -p "$web_release"
git archive --format=zip --output="$web_release.zip" \
  "$web_revision" tools/swank/web
python3 -m zipfile -e "$web_release.zip" "$web_release"
```

A systemd service selects this directory through `WorkingDirectory` and retains the relative `tools/swank/web/server.py` command and its access and SWANK options.  Backend updates precede a client revision that depends on new guest operations or result fields.  Activating another Web revision changes the working directory and restarts the HTTP service.  Accepted jobs and debugger commands remain in the guest.  Tabs resume their guest sessions after the transport reconnects.

## Snapshots and restarts

A snapshot saves guest memory and execution state in the running image.  From the Mezzano checkout:

```sh
sbcl --script tools/swank/lispm-eval --host 127.0.0.1 --port 4005 \
  --timeout 180 \
  '(mezzano.supervisor:snapshot) (mezzano.supervisor:wait-for-snapshot-completion) (values)'
```

After completion, stop QEMU and restart it with the same image.  The guest restores the saved state.  Changes after that snapshot disappear.  Host source files and external effects retain their own persistence.

A restored image has a new boot identity.  Old debugger sessions, handles, leases, and frame references expire.  Retained command IDs and results remain queryable through a fresh session, and earlier-boot commands reject resubmission.  The Web interface can open a new session and discover surviving jobs and stops.  [Disconnect and restore](debugger.md#disconnect-and-restore) defines the limits of replay across image restoration.
