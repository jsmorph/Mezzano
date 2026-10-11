# Swank evaluation client

`lispm-eval` sends Common Lisp source to Mezzano's Swank server.  It runs on host SBCL and uses its bundled socket library.  Mezzano starts Swank during initial program loading.

## Usage

From the Mezzano repository root:

```sh
tools/swank/lispm-eval '(+ 20 22)'
printf '%s\n' '(format t "hello~%")' '(values 42 :done)' | tools/swank/lispm-eval
tools/swank/lispm-eval --host 127.0.0.1 --port 4005 --package CL-USER '(lisp-implementation-type)'
```

The client accepts one source argument or reads standard input when the argument is absent or `-`.  It prints program output followed by each value returned by the last form.  Definitions persist across connections to the running guest.  Saving definitions across VM restarts requires a Mezzano snapshot.

Defaults are host `127.0.0.1`, port `4005`, package `CL-USER`, and a 60-second timeout.  Exit status is 0 for success, 1 for a remote Lisp condition, 2 for a client or transport error, and 124 for a timeout.  `--timeout` sets the deadline in seconds.  A timeout closes the connection.  Remote computation may continue.  Standard input inside an evaluation is an empty stream.

Swank permits arbitrary Lisp evaluation in the guest.  The tested QEMU setup forwards guest port 4005 to host loopback.  SSH provides remote access:

```sh
printf '%s\n' '(+ 20 22)' |
  tailscale ssh minideb2 /home/somebody/src/mezzano-boot/lispm-eval
```

[Build and VM instructions](minideb2/README.md) describe the setup on `minideb2`.

## Tests

With the guest running and port 4005 forwarded:

```sh
python3 tools/swank/test-lispm-eval.py
tools/swank/lispm-eval '(load "SYS:SOURCE;TOOLS;SWANK;TEST-STRUCTURE-LAYOUTS.LISP") (values)'
```

The Python test uses the standard library.  It checks arithmetic, guest identity, UTF-8, output, multiple values, retained definitions, conditions with unwind cleanup, malformed input, Swank flow control, large replies, and timeouts followed by another evaluation.  It creates and removes a temporary guest package.  `--port` selects a forwarded port.

The Lisp test checks inherited type predicates and slot access, unrelated types, and fresh instances after leaf redefinition.  Both test sets passed after a cold boot and after restarting the saved image.  [Development notes](devnotes.md) record the structure-layout defect and its repair.
