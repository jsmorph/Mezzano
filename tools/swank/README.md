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

`mezzano.debug:call-with-debugger-service` calls a function with a retained debugger for that thread's dynamic extent.  A condition stop keeps the failing activation and restarts alive.  The stopped thread executes inspection and restart commands.  The system's default debugger and SWANK connection handling have not yet been integrated with this service.

The guest Lisp API uses opaque objects for stop handles, controllers, control leases, and frame references.  These objects refer to Mezzano's current boot event.  Numeric stop IDs describe records.  They cannot replace the opaque handles in API calls.

| Function | Result or effect |
|---|---|
| `debugger-stops &key include-closed` | Lists stop handles. |
| `debugger-stop-information handle` | Returns state, thread name, parent and child handles, frame generation, and the next command ID. |
| `make-debugger-controller` | Creates a controller for this boot. |
| `attach-debugger-stop handle controller` | Acquires exclusive control and returns a lease. |
| `close-debugger-controller controller` | Releases its leases.  Accepted commands remain with their stops. |
| `submit-debugger-command lease id operation &optional argument` | Accepts a command or recognizes an identical submission already recorded under that ID. |
| `debugger-command-result handle id` | Returns command state, whether it belongs to this boot, and its result. |
| `release-debugger-stop lease` | Releases a closed stop and its command records. |

All functions are exported from `MEZZANO.DEBUG`.  A new command uses the stop's next command ID.  Reusing an ID with different arguments signals `debugger-service-error`.  A busy stop rejects new commands until the current command and any nested stop finish.  Closing a controller invalidates its leases and permits another controller to attach.

Operations are `:condition`, `:restarts`, `:frames`, `:locals` with a returned frame reference, and `:invoke-restart` with a restart index.  Restart invocation currently supplies zero arguments.  Inspected values and normally returned restart values are printed on the stopped thread.  A printer failure enters a child stop.  Raw frame pointers and local objects remain within the service.

Command states are `:pending`, `:running`, `:returned`, `:unwound`, `:cancelled`, and `:expired`.  `:unwound` records that control left command execution.  Application completion must be checked separately.  The service retains results until explicit stop release.  Frames expire when execution leaves the stop, and boot changes expire handles and controllers.

The guest service test runs through the existing evaluation client:

```sh
tools/swank/lispm-eval --port 4006 --timeout 120 '(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE.LISP")) (values)'
```

It checks a background failure, locals after full GC, exclusive control, lease expiration, duplicate restart submissions during and after execution, conflicting requests, a nested printer failure, foreign frame rejection, function repair, returned application values, and unwind cleanup.  These tests exercise controller closure through the Lisp API.  Network disconnect and reconnection require the forthcoming SWANK adapter.
