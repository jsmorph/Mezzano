# Swank client and runtime repair

## Sources and setup

The work used Mezzano revision `7f899408666ca3fb676e87d933148f26edf81e4e`, MBuild revision `a13448825506c716fb60427f78aafeb6265477b2`, and the recorded MBuild dependency revisions.  Builds and tests ran on `minideb2` using Debian 13, SBCL 2.5.2, QEMU 10.0.13, and KVM.

- [MBuild instructions](https://github.com/froggey/MBuild/blob/a13448825506c716fb60427f78aafeb6265477b2/README.md)
- [Mezzano CI procedure](https://github.com/froggey/Mezzano/blob/7f899408666ca3fb676e87d933148f26edf81e4e/.github/workflows/ci.yml)
- [Swank packet protocol](https://github.com/froggey/slime/blob/f81ab630423d9deb01d62464682ee0a21aab6624/swank/rpc.lisp)
- [Swank request handling](https://github.com/froggey/slime/blob/f81ab630423d9deb01d62464682ee0a21aab6624/swank.lisp)
- [SBCL sockets and deadlines](https://www.sbcl.org/manual/)

The CI image reached desktop initialization and exited QEMU with status 3.  A separate normal image provides the running Swank endpoint.  QEMU forwards loopback port 4005 to the guest.  The host file server binds loopback port 2599, which the guest reaches at `10.0.2.2`.

## Client

The client uses six-byte hexadecimal packet lengths and UTF-8 payloads.  It loads `swank-repl`, creates the connection's streams, evaluates source forms, prints output and multiple values, and answers Swank ping messages.  On a remote condition it reports the condition and invokes the request's abort restart, allowing unwind cleanup to run.  Local timeout handling closes the connection.  Swank may leave the evaluation worker running.

A test attempt using the recorded Swank revision on host SBCL failed during Swank compilation because it references the removed internal symbol `SB-KERNEL:%SIMPLE-FUN-NEXT`.  The completed integration tests ran against Mezzano's Swank server.

## Structure layouts

Repeated connections exposed a failure in `SWANK-REPL::UPDATE-REDIRECTION-AFTER-CLOSE`.  `SWANK::MULTITHREADED-CONNECTION` includes `SWANK::CONNECTION`, but the compiled parent type check returned false.  The resulting debugger attempted serial input and panicked because that input operation is unimplemented.

On a live connection, runtime `TYPEP` returned true while compiled `TYPEP` and `CONNECTION-P` returned false.  Its layout compatibility vector had length zero.  Runtime structure class construction and redefinition left that vector empty, while the cold-image builder filled it from class precedence.  Compiled inherited type checks consult this vector.

`make-structure-class-layout` now builds a wired vector containing the new layout and each ancestor layout.  Initial class construction and redefinition share that constructor.  Redefinition compares ancestor layout identities as well as storage shape when deciding whether to replace a layout.

After rebuilding, the Swank connection passed runtime `TYPEP`, compiled `TYPEP`, and `CONNECTION-P`.  Its compatibility vector contained the concrete connection layout, its parent connection layout, and the `STRUCTURE-OBJECT` layout.

## Tests

- [x] Build the CI image and complete its boot test.
- [x] Build and boot the normal image with the runtime repair.
- [x] Test inherited predicates, slot access, unrelated types, and fresh instances after leaf redefinition.
- [x] Test client values, output, UTF-8, retained definitions, condition handling, flow control, large replies, and timeouts.
- [x] Restart from the saved image and rerun both test sets.
- [x] Send source through Tailscale SSH and receive its result.

The first structure test used the inherited `MIDDLE-VALUE` accessor where it intended `MIDDLE-MIDDLE-VALUE`.  Correcting the test produced a passing run.  The runtime tests cover fresh instances after redefinition.

Logs and images remain in `/home/somebody/src/mezzano-boot` on `minideb2`.  `client-tests.log` and `structure-tests.log` contain successful runs after restart.  The previous image and failure logs were retained for comparison.

## Branch preparation

The `swank` branch records the runtime repair, client and tests, and the tested host setup.  The client, tests, and host scripts were copied into `tools/swank` without code changes.  Both test sets passed from their repository paths.  The guest loaded the structure test through `SYS:SOURCE;TOOLS;SWANK;TEST-STRUCTURE-LAYOUTS.LISP`.
