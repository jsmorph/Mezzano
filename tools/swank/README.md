# Swank evaluation client

`lispm-eval` sends Common Lisp source to Mezzano's Swank server.  It runs on host SBCL and uses its bundled socket library.  The accompanying `client.lisp` provides the shared connection and packet code and must remain beside the executable.  Mezzano starts Swank during initial program loading.

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

## Debugger tests

These tests require [Slime commit d2c70f2e](https://github.com/jsmorph/slime/commit/d2c70f2ea5916d8da2fe0a41ff302b2002715f61), which fixes Mezzano's repeated frame-local IDs.  The build instructions record how to select that revision.

With that backend loaded in the guest:

```sh
tools/swank/lispm-eval '(load "SYS:SOURCE;TOOLS;SWANK;TEST-FRAME-LOCALS.LISP") (values)'
sbcl --script tools/swank/test-debugger.lisp
tools/swank/lispm-eval '(load "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-BINDINGS.LISP") (values)'
tools/swank/lispm-eval '(load "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-BINDING-WRITES.LISP") (values)'
tools/swank/lispm-eval '(load "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-CLOSURE-WRITES.LISP") (values)'
tools/swank/lispm-eval '(load "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-POLICY.LISP") (values)'
tools/swank/lispm-eval '(load "SYS:SOURCE;TOOLS;SWANK;TEST-KEYWORD-LOWERING.LISP") (values)'
tools/swank/lispm-eval '(load "SYS:SOURCE;TOOLS;SWANK;TEST-JUMP-TABLE-BINDINGS.LISP") (values)'
```

The first test checks that each local has a distinct ID and that selecting it returns the listed value.  The second connects to `127.0.0.1:4005` by default, loads a compiled fixture, and enters the debugger on an undefined-function call.  It inspects the caller's locals, defines the missing function, invokes its retry restart, and checks multiple values and unwind cleanup.  It also checks that another evaluation can run while the original request remains stopped.  An optional command-line port, such as `sbcl --script tools/swank/test-debugger.lisp 4006`, selects another VM.  Its connection stays open through recovery.  The test attempts to abort its suspended request if an assertion fails.

The fixture uses the guest package `LISPM-DEBUGGER-TEST` and resets that package's test definitions and counters on each run.  Neither test saves a guest image.

The compiler binding test requires the updated compiler in the guest.  It checks copied, constant, unused, and shadowed bindings at function-level `(debug 3)`, and propagation at `(debug 1)`.  The binding-write test checks independent copies, constants, multiple-value bindings, loop updates, and a full GC after mutation.  It uses the runtime's internal frame writer in a callback while the target activation is live.  A public mutation API with lifetime and declared-type checks remains future work.

The closure-write test checks that the defining function, its closures, and frame inspection share one captured binding.  It covers required, optional, supplied-p, rest, and keyword parameters, `LET`, and multiple-value bindings.  Escaped closures retain the changed value after a full GC.

The policy test checks local `(debug 3)` declarations inside functions at debug levels 0, 1, and 2.  It checks independent and captured binding writes, unused heap values, and GC during inspection.  A binding retains the policy under which it was introduced when its body enters a lower-debug region.

The keyword test checks argument validation, defaults, duplicate keys, and zero heap allocation for a valid call at debug levels 1 and 3.

The jump-table test checks binding cleanup for `ECASE` inside another expression, including each branch and invalid selectors, at debug levels 1 and 3.

## Guest debugger stop service

`mezzano.debug:call-with-debugger-service` calls a function with a retained debugger for that thread's dynamic extent.  A condition stop keeps the failing activation and restarts alive.  The stopped thread executes inspection and restart commands.  The `swank-mezzano-debugger` contrib provides remote access to these stops.  Entry uses this dynamic wrapper.  Ordinary SWANK evaluation continues to use SLDB.

The guest Lisp API uses opaque objects for stop handles, controllers, control leases, and frame references.  These objects refer to Mezzano's current boot event.  Numeric stop IDs describe records.  They cannot replace the opaque handles in API calls.

| Function | Result or effect |
|---|---|
| `debugger-stops &key include-closed` | Lists stop handles. |
| `debugger-stop-information handle` | Returns state, thread name, parent ID, retained parent and child handles, frame generation, and the next command ID. |
| `make-debugger-controller` | Creates a controller for this boot. |
| `attach-debugger-stop handle controller` | Acquires exclusive control and returns a lease. |
| `close-debugger-controller controller` | Releases its leases.  Accepted commands remain with their stops. |
| `submit-debugger-command lease id operation &optional argument` | Accepts a command or recognizes an identical submission already recorded under that ID. |
| `debugger-command-result handle id` | Returns command state, operation, whether it belongs to this boot, and its result. |
| `release-debugger-stop lease` | Releases a closed stop and its command records. |

All functions are exported from `MEZZANO.DEBUG`.  A new command uses the stop's next command ID.  Reusing an ID with different arguments signals `debugger-service-error`.  A busy stop rejects new commands until the current command and any nested stop finish.  Closing a controller invalidates its leases and permits another controller to attach.

Operations are `:condition`, `:restarts`, `:frames`, `:locals` with a returned frame reference, and `:invoke-restart` with a restart index.  Restart invocation currently supplies zero arguments.  Inspected values and normally returned restart values are printed on the stopped thread.  A printer failure enters a child stop.  Raw frame pointers and local objects remain within the service.

Command states are `:pending`, `:running`, `:returned`, `:unwound`, `:cancelled`, and `:expired`.  `:unwound` records that control left command execution.  Application completion must be checked separately.  The service retains results until explicit stop release.  Frames expire when execution leaves the stop, and boot changes expire handles and controllers.

The guest service test runs through the existing evaluation client:

```sh
tools/swank/lispm-eval --port 4006 --timeout 120 '(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE.LISP")) (values)'
```

It checks a background failure, locals after full GC, exclusive control, lease expiration, duplicate restart submissions during and after execution, conflicting requests, a nested printer failure, foreign frame rejection, function repair, returned application values, and unwind cleanup.  These tests exercise controller closure through the Lisp API.  The remote tests below exercise network disconnect and reconnection.

The restore test uses two explicit phases after the service test has defined its helpers:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE-RESTORE.LISP"))
(lispm-service-test::prepare-restore-test)
(mezzano.supervisor:snapshot)
(mezzano.supervisor:wait-for-snapshot-completion)
```

After restarting the VM, `(lispm-service-test::finish-restore-test)` checks rejection of the old handles, attachment through a new controller, the retained command record, locals after GC, restart recovery, and cleanup.  This test covers a parked stop and a completed command at snapshot time.

## Remote retained debugger

The host `debugger-client.lisp` uses SBCL and the shared `client.lisp` transport.  It requires [Slime commit 19b017fe](https://github.com/jsmorph/slime/commit/19b017fe5a53bfe71b095c12c88ffe9ccc002f94), selected by the build instructions.  Its [RPC documentation](https://github.com/jsmorph/slime/blob/19b017fe5a53bfe71b095c12c88ffe9ccc002f94/contrib/swank-mezzano-debugger.md) describes sessions, token formats, and operations.  The client loads the contrib on connection.

```lisp
(load "tools/swank/debugger-client.lisp")
(defparameter *debug-session* (lispm-debugger-client:make-session))
(lispm-debugger-client:call-with-session
 *debug-session*
 (lambda () (lispm-debugger-client:request :stops))
 :port 4006)
```

Calling `call-with-session` again with the same session reconnects.  Its keyword arguments are `:host`, `:port`, and `:seconds`, defaulting to `"127.0.0.1"`, 4005, and 60.  The timeout covers the connection and callback.  Within the callback, `request` performs one synchronous RPC.  `send-request` and `receive-reply` separate transmission from reception.  The client expects one outstanding RPC per connection.

`session-name` returns the name needed to reconnect from another host Lisp process.  `(make-session :resume saved-name)` resumes that existing session.  New sessions obtain 256 random bits from the host's `/dev/urandom`.  The server validates the saved session's boot-event identity.  A failed resume signals an error and preserves the distinction between an expired session and a new one.

The first request sequence for a selected stop is `(:attach stop-token)`, `(:information stop-token)`, and `(:submit lease-token next-command-id :frames)`.  `(:result stop-token command-id)` queries completion.  A frame token from that result supports `:locals`.  After a lost reply, the client can query the recorded command and repeat an identical submission under a new lease within the same boot.  A new request at the same ID with different arguments is rejected.

The target thread must enter `call-with-debugger-service`.  The adapter operates through separate requests, so its connection can close while the target remains stopped.  Existing SLDB evaluation requests retain their current connection-dependent behavior.  Default debugger installation, retained top-level evaluations and their I/O, public binding mutation, lexical evaluation, frame return/restart, breakpoints, and stepping remain unfinished.

```sh
sbcl --script tools/swank/test-debugger-reconnect.lisp 4006
sbcl --script tools/swank/test-debugger-remote-restore.lisp prepare 4006 ../debugger-client-state.sexp
# Restart the debugging VM after the preparation command completes.
sbcl --script tools/swank/test-debugger-remote-restore.lisp finish 4006 ../debugger-client-state.sexp
```

The reconnect test drops connections before any command and after sending accepted restart commands whose replies it leaves unread.  It checks command outcomes, duplicate submissions, exclusive control, stale leases, foreign-session handles, returned application values, and cleanup.  The restore test saves a stopped thread and one remote session, then creates another session after the snapshot.  After VM restart, both old sessions fail to resume.  A fresh session rejects their tokens and old frame references, inspects the restored stop, and resumes it through an existing restart.
