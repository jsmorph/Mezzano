# Mezzano debugger development journal

Entries record findings, decisions, and implementation status at the time of each entry.  Historical checklists can contain work completed in later entries.  The [current debugger design](../../doc/debugger.md) owns present capability status and test scope.  The [development instructions](../../AGENTS.md) record the standing decision procedure.

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

## Headless and debugger design review: 2026-10-11

### Scope and evidence

This review covers the proposed headless x86-64 QEMU system, a host FEP, remote Lisp debugging, and the Genera debugger target.  Bare-metal FEP design remains deferred.  Implementation decisions below are proposals requiring approval.

The reviewed revisions are Mezzano `64be97183fc65e45650c597152ccdd8d72a3b073` and Slime `f81ab630423d9deb01d62464682ee0a21aab6624`.  The local Mezzano source used for inspection is the common base `7f899408666ca3fb676e87d933148f26edf81e4e`.  The intervening changes are the recorded structure-layout repair and host/client setup.

This was a source and documentation review.  The VM service reported active.  The debugger, failure, and headless tests proposed below have not run.  Earlier boot and evaluation tests establish the results recorded above.

### Findings

| Area | Evidence and consequence |
|---|---|
| Current VM | The launch script uses `-vga std -display none`, and the image initializes the desktop.  The script configures neither QMP nor a GDB endpoint.  Headless operation and FEP control remain proposed work. |
| Headless dependencies | The cold generator includes display/input code and fonts.  Supervisor entry calls early and normal video initialization.  IPL loads several graphics libraries before Swank, then GUI components and applications.  A headless build requires changes to the build inputs and both initialization paths. |
| Startup failure | `run-boot-hooks` uses `log-and-ignore-errors`.  `load-init-file` catches errors and returns after printing.  Those paths discard a failure as a control outcome.  Completion of boot hooks therefore cannot establish service readiness. |
| Early debugger | IPL installs a debugger that formats the condition and panics.  Serial `:read-char` panics.  Serial output polls device readiness without a bound and takes a spinlock.  The existing console has failure dependencies that need explicit tests. |
| Compiler debug policy | The default is `(safety 3 debug 3 speed 1)`.  Debug level 3 extends liveness for debug values in register allocation.  Enabling that setting alone cannot supply the missing debugger operations. |
| Frames and source | Debug metadata describes variable locations and representations.  The writer supports some stack and closure locations, and rejects register locations.  `function-source-location` returns a file and top-level form and does not use its offset argument.  These facilities do not establish general binding mutation or expression-level source mapping. |
| Native stepping | The supervisor implements thread stopping and single-stepping.  The low-level stepper treats certain runtime functions specially.  The x86 breakpoint exception handler panics.  `STEP` executes its form without stepping.  A Lisp breakpoint service remains to be designed. |
| SWANK backend | Backtraces, local values, thread interruption, and definition locations have implementations.  Lexical frame evaluation, frame return/restart, and stepping interfaces lack Mezzano implementations.  The backend declines global debugger installation. |
| Local-variable IDs | The Mezzano SWANK backend's `frame-locals` uses `for id = 0`, assigning every local ID zero.  `frame-var-value` interprets the ID as a list index.  A request using an advertised ID can therefore retrieve the first local instead of the selected local.  This is a source-level defect, not a reproduced interactive failure. |
| Connection lifetime | SWANK's debugger sends events through the current connection.  Connection cleanup requests termination of its REPL and service threads.  Evaluation workers have different cleanup behavior.  A retained debugger session that a new connection can attach to remains unverified.  The current CLI requests an abort on `:debug`. |

Source references: [VM launch](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/tools/swank/minideb2/run-live.sh), [cold generator](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/tools/cold-generator2/cold-generator.lisp), [supervisor entry](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/supervisor/entry.lisp), [IPL](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/ipl.lisp), [debugger](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/system/debug.lisp), [compiler policy](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/compiler/compiler.lisp), [register allocation](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/compiler/backend/register-allocation.lisp), [serial console](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/supervisor/serial.lisp), [x86 interrupts](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/supervisor/x86-64/interrupts.lisp), [SWANK backend](https://github.com/froggey/slime/blob/f81ab630423d9deb01d62464682ee0a21aab6624/swank/mezzano.lisp), and [SWANK connection/debugger code](https://github.com/froggey/slime/blob/f81ab630423d9deb01d62464682ee0a21aab6624/swank.lisp).

### Proposed component responsibilities

The host FEP would own VM lifecycle, image selection, boot-attempt identity, and retained diagnostics.  QMP would provide VM control.  GDB would provide machine-state inspection.  Mezzano would report boot progress, service readiness, and failures.  A host controller can remain reachable during a guest failure while the host and its control facilities remain operational.  Each QEMU operation still depends on QEMU responding.

QMP run state and guest readiness are separate observations.  The controller needs to distinguish an explicit failure from silence after the last reported stage.  A timeout establishes that the expected response did not arrive.  It does not establish a cause.

The guest debugger would own Lisp frames, bindings, restarts, and execution changes.  SWANK would expose those operations remotely.  Client presentation would consume that API.  QEMU's GDB interface identifies virtual CPUs as threads, and its breakpoint/watchpoint support depends on the accelerator.  Our KVM configuration requires its own tests.  See [QMP reference](https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html) and [QEMU GDB documentation](https://www.qemu.org/docs/master/system/gdb.html).

A whole-VM stop also stops the guest debugger and network.  Resuming enough of the guest to execute Lisp requires a separate, validated transition.  For in-guest debugging, a stopped application thread can retain locks and block services needed by the debugger.  Supervisor thread interruption is also restricted: `establish-thread-foothold` rejects supervisor and idle threads and can defer delivery while footholds are inhibited.

The early diagnostic channel should have bounded behavior and avoid dependence on the guest network.  Allocation, paging, lock use, concurrent writers, and a disconnected host reader need explicit treatment.  A minimal failure record should remain obtainable when ordinary condition printing fails.  Transport selection remains open.

### Startup and saved-image behavior

The headless profile must specify its required services and build inputs.  Cold initialization and restore from a Mezzano snapshot take different paths.  Both require tests with graphics devices absent.  Bootloader behavior with no framebuffer remains unverified.  Guest source-file access and other build-time dependencies need an explicit deployment policy.

A recoverable startup failure needs to enter debugging before unwinding the failing computation.  A handler that unwinds first loses inner frames and restart bindings.  Required-service failures must prevent a ready result.  Background-thread failures also need an explicit debugger policy because the current backend does not install one globally.

The FEP should retain evidence before a requested reset.  Image saving, crash-memory capture, and resetting have distinct effects.  Mezzano snapshot code coordinates threads, memory, and disk writes.  The current reboot function calls the platform reset directly and has a FIXME about disk synchronization and snapshots.  A graceful restart requires a tested sequence.  A forced reset has crash semantics.

Mezzano's TCP code detects connections whose recorded boot identity differs from the current one.  Debugger handles and active breakpoint state also need defined behavior across restore.  Recommendations are to invalidate client references on a new boot and retain a separate known-good image.  Saving a stopped debugger session into a world remains an unresolved capability.

### Debugger semantics and compiler requirements

Genera's debugger manual documents lexical evaluation, conditional breakpoints and actions, traps on calls and exits, compiled instruction stepping, condition tracing, monitored locations, and frame return/reinvocation.  Its reinvocation defaults to current argument values, permits replacement arguments, and uses a redefined function when available.  SWANK's `restart-frame` interface describes original arguments.  The mapping needs an explicit API decision.  See [Program Development Utilities, chapter 5](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Program-Development-Utilities.pdf) and [SWANK backend interfaces](https://github.com/froggey/slime/blob/f81ab630423d9deb01d62464682ee0a21aab6624/swank/backend.lisp).

Full capability coverage needs an operation-by-operation specification and tests.  The preceding inventory covers selected operations.  Genera also documents restrictions on debugging system functions.  Compatibility claims must identify the supported operation, code class, and stopping state.

Compiler work must define what a debugger-visible binding means after optimization.  A location map allows observation.  Every subsequent source-level read of a changed binding must observe its new value.  Values computed before the change retain their earlier results.  The compiler must account for register copies, propagated constants, closure aliasing, type assumptions, and GC roots.  Type and representation restrictions need explicit errors.  Retaining debug values alone establishes no such guarantee.

Frame evaluation needs lexical identity and shadowing, local functions and macros where supported, closure bindings, and a defined dynamic environment.  Source locations must identify the code version executing in the frame, including older definitions that remain active after recompilation.  Anonymous functions, methods, inlined calls, and eliminated frames require documented behavior.

Frame return and reinvocation require runtime support for unwinding, multiple values, and dynamic bindings.  Cleanup may signal another condition or transfer control.  The implementation must preserve those behaviors.  Prior program effects remain after reinvocation.  [UNWIND-PROTECT](https://www.lispworks.com/documentation/HyperSpec/Body/s_unwind.htm) specifies cleanup behavior.  [Restarts](https://www.lispworks.com/documentation/HyperSpec/Body/09_adb.htm) have dynamic extent.

Stepping must specify its unit: native instruction, function call, or source expression.  Conditional breakpoint evaluation runs Lisp and can signal, allocate, or block.  Breakpoint installation and removal must account for both CPUs executing shared code.  Object watchpoints need a definition of covered accesses, object movement, access before/after trapping, and whether runtime/collector accesses count.  Their implementation and cost remain unproven.

### Remote session behavior

Frames, locals, restarts, and objects need identifiers with defined lifetimes.  Frame and restart references must expire when their dynamic context ends.  Object references need GC retention and release rules.  Object inspection should preserve identity through references whose validity the server checks.

Reconnect requires a server-side policy for the suspended computation and its connection-dependent state.  The proposed default is to retain a recoverable debug stop until an authorized client resumes or aborts it, subject to the runtime still operating.  This requires implementation and tests.  The current SWANK path establishes no such guarantee.

For shared use, a proposed initial policy is one client controlling a stopped thread at a time.  Commands must identify the boot and stop they apply to and reject stale references.  A lost reply to a mutating operation leaves its outcome uncertain.  A reconnecting client must resolve that outcome before repeating it.

Object expansion, condition printing, and debugger evaluation can run user code.  Their failures need their own reportable state.  A failed presentation must preserve the original stop.  Limits on output and nested debugging need an explicit policy.  Existing SWANK operations should be reused where their semantics fit.  Additional protocol operations require a demonstrated gap.

### Decisions and test sequence

The proposed division between host control, guest debugger, and remote presentation is consistent with the inspected dependencies.  Compiler support, startup failure handling, and session lifetime remain open design work.  The first milestone should establish preservation and resumption through an existing restart.  Local mutation should follow after its compiler semantics are specified.

- [x] Review the current boot, debugger, compiler metadata, thread interruption, and SWANK connection paths.
- [x] Record source-level defects and corrections to previous assumptions.
- [ ] Agree on the supported code classes, debug compilation behavior, and required Genera operations.
- [ ] Agree on disconnect behavior, control ownership, and boot-failure recovery policy.
- [ ] Specify frame/binding/source identity, stopping states, and legal transitions.
- [ ] Test a persistent remote debug stop: inspect distinct locals, invoke an existing restart, preserve multiple values, and verify continuation.
- [ ] Test disconnection, reattachment, nested conditions, stale references, and concurrent client requests.
- [ ] Test binding mutation, closure aliasing, GC during stops, frame return/reinvocation, cleanup failure, and active older function definitions.
- [ ] Test breakpoints on two CPUs, stepping boundaries, and the specified watchpoint cases.
- [ ] Test cold boot and saved-image restore with graphics absent, failures before and after SWANK startup, and host access during guest network/runtime failure.

Only this journal was edited during the review.  The proposed policies remain subject to approval.

## Second debugger review: 2026-10-11

### Additional evidence

This review examined binding preservation, dynamic state, frame control, and the Genera manual.  Two inspection tests ran against the existing x86-64 guest on `minideb2`.  Neither test changed a frame binding.  Both functions completed after inspection.  Implementation and policy changes remain proposals.

The first test compiled a function with arguments `A = 111` and `B = 222`, captured its frame through the Mezzano SWANK backend, and requested each local using its advertised ID:

```lisp
(:locals ((:name a :id 0 :listed-value 111 :selected-value 111)
          (:name b :id 0 :listed-value 222 :selected-value 111))
 :continued-result (111 222))
```

This reproduces the local-ID defect identified in the first review.  The test exercises frame inspection inside a callback.  It does not establish persistent debugger-session behavior.

The second test compiled this function with `(debug 3)` and `(safety 3)`:

```lisp
(lambda (a callback)
  (declare (optimize (debug 3) (safety 3)))
  (let ((b a))
    (funcall callback)
    (list a b)))
```

At the callback, the frame API reported `A` at stack location 1 with value 111.  It reported no `B`, including when asked for hidden variables.  The function returned `(111 111)`.  The test therefore establishes missing binding information at this inspection point.  It does not establish that two reported bindings share a writable location.

The compiler source explains how the binding can disappear.  `constprop-value-p` permits propagation of an unwritten local variable.  `cp-form` substitutes that value for uses of a binding.  `simp-form` removes unused bindings with pure initializers.  Those rules do not consult debug quality.  Later SSA conversion also replaces local reads with computed values, while retaining debug records when debug quality is nonzero.  Register-allocation liveness cannot restore bindings removed before those records exist.

Test source and output remain in `/home/somebody/src/mezzano-boot/debug-review-probe.{lisp,log}` and `debug-binding-probe.{lisp,log}`.  The first binding-test attempt used the wrong package for private accessors and failed.  Those accessors are defined in `MEZZANO.INTERNALS`.  The corrected test passed.  Earlier attempts remain in the corresponding `-v1` and `-v2` files.

### Required semantics

The Genera manual distinguishes original call arguments from changed parameter values, displays dynamic bindings, catches, handlers, and stack temporaries, and permits editing values at an exit trap.  Its debugger accessors include the selected frame's function object.  Monitored locations distinguish read, write, boundness, unbinding, and location-taking operations.  Source-form operations require source-locator information.  These are additions to the first review's inventory, not a complete compatibility specification.  See [Program Development Utilities](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Program-Development-Utilities.pdf), printed pages 212–214, 222–224, and 249–250.

| Requirement | Consequence for the design |
|---|---|
| Original arguments and current parameters | Preserve enough invocation information to distinguish them after assignment, argument processing, and optimization.  Specify optional, keyword, rest, and supplied-p bindings.  Choose explicit reinvocation modes rather than assigning two meanings to SWANK's existing restart operation. |
| Binding identity and scope | Preserve source bindings through compiler transformations, including shadowed names and closure sharing.  The current x86 debug emitter records names, locations, representations, and a hidden flag.  Lexical evaluation needs scope information beyond that tuple. |
| Binding mutation | Define mutation as a change to one logical binding.  Future reads of that binding observe the change, earlier computed values retain their results, and closures sharing the binding observe it.  Compiler transformations must preserve this behavior at supported stops. |
| Dynamic environment | Specify the selected frame's special bindings, handlers, restarts, catch targets, and cleanup context.  Evaluation in an older frame needs defined behavior while younger activations remain stopped.  Evaluating in the debugger worker's environment would give different results. |
| Return and reinvocation | Record the activation's return destination and dynamic-unwind boundary.  Preserve zero, one, and multiple values.  Execute cleanup with its normal control effects, including another condition or nonlocal transfer.  Reinvocation preserves effects already performed. |
| Exit traps | Retain the pending result values before delivery to the caller and define how editing them changes that delivery.  Distinguish normal return from an unwind through the activation. |
| Source and code identity | Associate a frame with the executing code version and its source.  Define mappings for macro expansion, inlining, and multiple machine locations implementing one source form.  Function redefinition must preserve inspection of active older code. |
| Stop validity | Establish a valid runtime and GC state before debugger operations that allocate or execute Lisp.  Specify available operations for condition entry, asynchronous interruption, instruction traps, and source stops.  Test register and stack representations at each supported transition. |
| Debugger object lifetime | Heap roots require retention rules.  Stack-allocated objects additionally require an activation lifetime.  A remote reference must expire before the storage it denotes becomes invalid. |

A useful binding-mutation acceptance case is the second test above: after initialization of `B`, changing `A` from 111 to 222 must produce `(222 111)`.  Changing `B` instead must produce `(111 222)`.  A separate captured-binding case must demonstrate that debugger writes and closure writes refer to the same binding.  These mutation tests remain unimplemented and unrun.

The proposed baseline is ordinary compiled application code with an explicitly specified debugger policy.  That policy must preserve the information and execution behavior needed by the advertised operations.  The compiler audit must start with AST transformations and continue through lowering, SSA, register allocation, and code generation.  Choosing the representation and optimization restrictions requires design approval and measured cost.  Requiring the programmer to add artificial uses or assignments to retain a local would fail this baseline.

### Runtime facilities and limits

Mezzano already provides useful recovery behavior.  `SIGNAL` honors `*BREAK-ON-SIGNALS*` before searching handlers.  Undefined-function calls offer restarts to retry the call, supply result values, or call another function with the arguments.  Invalid-argument handling offers replacement arguments or result values.  These operations should be included in the first remote recovery tests.

The runtime's `%%unwind-to` handles special bindings, block/tagbody state, unwind-protect state, and continuation stack changes.  Frame-control operations need to cooperate with that machinery.  Existing delimited continuations have consumption rules and barriers.  In particular, nested handler establishment can insert a continuation barrier.  Their presence does not establish arbitrary frame capture or reinvocation.

The invalid-argument path also documents that its tail call removes the affected function from ordinary backtraces.  Recovering the logical call and identifying the faulty argument therefore requires attention beyond successful stack walking.

The initial debugger backend should expose semantic operations independently of connection lifetime and client presentation.  SWANK can carry those operations where its interfaces fit.  This remains a responsibility boundary, not a decision to introduce another protocol.  The host FEP retains its proposed VM-control and diagnostic responsibilities.  Lisp evaluation still depends on a functioning guest runtime.

### Acceptance sequence

Each stage needs observable results and a recorded failure mode.  Reaching an earlier stage does not establish the later capabilities.

1. Preserve a recoverable condition before unwind, inspect distinct locals, repair an undefined function, invoke its retry restart, and verify the caller receives the expected multiple values.  Repeat for a background thread.
2. Preserve source bindings under the agreed compiler policy.  Test shadowing, copied values, closure sharing, original arguments, and unavailable or representation-incompatible writes.
3. Evaluate in selected lexical and dynamic environments.  Test conditions raised by evaluation and object printing while preserving the original stop.
4. Return and reinvoke frames across dynamic bindings and unwind-protect.  Verify cleanup runs once, including cleanup that signals or transfers control.  Test active older definitions after recompilation and the chosen reinvocation mode.
5. Exercise conditional call/source breakpoints, exit traps, instruction and source stepping, and each promised watchpoint access category.  Repeat relevant tests during GC and with two CPUs executing shared code.
6. Disconnect and reattach at each mutation boundary.  Verify stop ownership, stale-reference rejection, and resolution of a lost reply without repeating the mutation.
7. Test the headless cold-boot and restore paths, startup failures, debugger service failures, and host diagnostics while the guest cannot serve SWANK.

- [x] Reproduce the SWANK local-ID defect on the running guest.
- [x] Test whether debug level 3 preserves a copied lexical binding.
- [x] Inspect the relevant optimizer rules and runtime recovery facilities.
- [ ] Agree on debugger compilation guarantees and frame-operation semantics.
- [ ] Specify the complete Genera operation inventory and its tests.
- [ ] Implement and run the acceptance sequence.

Only this journal changed in the repository.  The inspection programs and logs are host-side review artifacts.  No debugger implementation, headless build, or FEP change was made.

Source references: [constant propagation](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/compiler/constprop.lisp), [simplification](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/compiler/simplify.lisp), [SSA conversion](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/compiler/backend/ssa.lisp), [x86 debug metadata](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/compiler/backend/x86-64/codegen.lisp), [runtime unwinding](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/runtime/runtime.lisp), [condition handling](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/system/condition.lisp), [error recovery](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/system/error.lisp), and [delimited continuations](https://github.com/jsmorph/Mezzano/blob/64be97183fc65e45650c597152ccdd8d72a3b073/system/delimited-continuations.lisp).

## Debugger implementation: shared client transport

Work proceeds on `debugging`, based on `swank`.  The review notes are committed.  Git pushes run on `minideb2` with the existing workstation SSH agent forwarded through Tailscale SSH.  GitHub host keys came from its HTTPS metadata endpoint.  The repository uses the established Jamie Stephens commit identity.

`client.lisp` now contains the socket connection, SWANK packet writer, and message reader used by `lispm-eval`.  Separating those functions permits debugger tests and a debugger client to use the same transport.  The evaluation client's seven existing test groups passed against the guest after the extraction.  Installation instructions now copy both files.

The SWANK local-ID correction has passed its focused live test.  Publication of the Slime change awaits the dependency repository decision.  The compiler-policy question is also pending.  Work on those choices will follow the user's answer.

## Debugger implementation: first remote recovery test

Slime commit `d2c70f2ea5916d8da2fe0a41ff302b2002715f61` changes `frame-locals` from `for id = 0` to `for id from 0`.  The frame-local test failed before this change: three locals had one distinct ID.  After compiling and loading the backend in the running guest, the test passed.  The Slime commit is local to `minideb2` pending a fork destination.

The remote recovery test passed against that backend.  It enters a real SWANK debugger stop on an undefined-function call, inspects the application frame and its distinct argument values, and checks that cleanup has not run.  A separate request succeeds while the failing request is stopped.  The test compiles and installs the missing function, invokes its existing retry restart, receives 333 and `:RESUMED`, and verifies that the caller continued and cleanup ran once.

This establishes recovery through an existing restart over one connected session.  The running guest contains the reloaded backend.  Cold boot, saved-image restore, background-thread debugging, and reconnect behavior require later tests.  The test programs are committed with the fixture and run commands.  Compiler and session policy decisions remain pending.

- [x] Test distinct local IDs and selection against the running guest.
- [x] Test a retained stop and repair through an existing restart while connected.
- [x] Verify continuation, multiple values, and cleanup after recovery.
- [ ] Publish the Slime dependency change and record its fetchable revision.
- [ ] Test the corrected backend after boot and restore.
- [ ] Extend debugging to background failures and reconnection after agreeing on session behavior.

## Approved debugger policy and dependency publication

The user approved publication through `jsmorph/slime` and preservation of source bindings for inspection and mutation at `(debug 3)`.  Lower debug levels retain their current optimization policy.  Compiler implementation will follow the binding through AST transformations, closure conversion, and backend storage.  This approval establishes the target behavior.  Each increment will document the behavior its tests establish.

Slime commit [d2c70f2e](https://github.com/jsmorph/slime/commit/d2c70f2ea5916d8da2fe0a41ff302b2002715f61) is now published on `debugging`.  The build instructions select that exact revision after MBuild submodule initialization.  This resolves the pending dependency destination.

## Debugger implementation: preserving source bindings

The compiler marks variables created under `(debug 3)` during source processing.  Copying an AST variable retains that property.  Constant propagation, unused-binding removal, and temporary elimination now retain marked bindings.  The change uses a binding property rather than changing the compiler's use or write counts.

The live test first failed because the copied binding `B` was absent.  After compiling and loading the five changed compiler files, copied, constant, unused, and shadowed bindings were present with the expected values.  A `(debug 1)` case retained its previous propagation behavior.  The existing evaluation tests and the remote function-repair/restart test passed.  The test helper's first draft had an unmatched parenthesis.  That test error was corrected before establishing the compiler failure.

A separate CI image built and reached `CI build completed successfully!`, with QEMU exit status 3.  Logs are `debugging-build.log`, `debugging-boot.log`, and `debug-binding-preservation-serial.log` in the MBuild directory.  The live compiler-load log is `debug-binding-compiler-load.log`.

This increment establishes the recorded inspection cases.  The subsequent storage test changed `A` through the existing frame writer after `(let ((b a)) ...)`.  Both values became 222.  SSA conversion still shares the value representing those two bindings.  Writable storage, closure sharing, declared-type validation, and binding lifetimes require further work.

## Debugger implementation: writable local storage

Preserved bindings now bypass SSA substitution.  Local lowering assigns each one a debug-variable register, and register allocation places that register in stack storage throughout its live ranges.  The existing move lowering emits loads and stores for accesses to the binding.  Other values retain their own registers and spill locations.

The copied-binding mutation test now returns `(222 111)` when changing `A` and `(111 222)` when changing `B`.  Further live tests passed for replacement of a constant initializer, multiple-value bindings, and a variable updated in a loop.  A test stored a new list in a binding, returned from the inspection callback, ran a full GC, and then read both the replacement and the earlier copied value.  The remote restart test also passed.

The separate CI image built and booted with these changes.  QEMU exited with status 3 after the CI success message.  Logs are `debug-binding-storage-load.log`, `debug-binding-storage-build.log`, `debug-binding-storage-boot.log`, and `debug-binding-storage-serial.log` in the MBuild directory.

The tests use the existing internal frame writer while the inspected activation is live.  Public mutation, declared-type validation, arbitrary stopping points, and escaped frame references require further implementation.  Captured variables require one shared storage location used by both the defining function and its closures.  That is the next compiler increment.

## Cold-build audit and keyword validation

The cold generator's `maybe-compile-file` checks each source file's timestamp against its compiled output.  It does not invalidate all compiled outputs after a compiler change.  The preceding cold-boot passes therefore used a mixture of earlier compiled system code and rebuilt compiler files.  They establish boot of that mixture, not a complete rebuild with the changed compiler.

The closure-sharing work reproduced two entries for captured `A`.  Changing the environment cell produced `(111 222)` when the defining function and closure read it.  The proposed lowering correction passed live closure tests, but its incremental cold boot failed during filesystem initialization with a disk bounce-buffer allocation error.  A diagnostic rebuild of the disk source failed earlier: `MAKE-DISK` allocated a general-area closure environment during early boot.  These failures remain in `debug-closure-failed-serial.log` and `debug-closure-diagnostic-serial.log`.  The temporary diagnostic source change was removed.

Inspection of the lowered AST showed that generated keyword validation calls `MEMBER`.  Inlining its definition under binding preservation retains closures and their environment.  Keyword validation now emits direct `EQ` comparisons against the known accepted keywords.  This removes closure allocation from that generated check.

Live tests passed for defaults, keyword selection, duplicate keys, `:ALLOW-OTHER-KEYS`, invalid keywords, and odd argument counts.  A per-thread allocation counter measured zero heap bytes for a valid call at debug levels 1 and 3.  The closure tests also passed after reloading keyword lowering.  Logs are `debug-constructor-ast.log`, `debug-keyword-load.log`, and `debug-keyword-test.log` in the MBuild directory.

A full build is running after moving `build-x86-64` to `build-x86-64.before-debug-full`.  The closure correction remains uncommitted pending that test and diagnosis of any further failures.  A separate live test confirmed that a local `(debug 3)` declaration inside a `(debug 0)` function currently loses its binding metadata.  That policy boundary remains open.

## Debugger implementation: jump-table binding cleanup

The full rebuild stopped while compiling `ACPI-GENERIC-ADDRESS`.  Its generated jump table bypassed lexical unbinding instructions.  `cg-form` connected a local `GO` target directly to the switch, even when intervening bindings required cleanup.  Retaining those bindings exposed the malformed control flow.

The shortcut now requires the current dynamic stack to match the target's stack.  Other targets use normal `GO` generation, which emits the required unbinding instructions.  The assertion remains in `dynamic-contours`.

The reduced expression `(1+ (ecase x (1 11) (2 22) (3 33) (4 44)))` failed compilation before the correction in both the host cross-compiler and the guest compiler.  Afterward, arithmetic and list contexts compiled and passed each branch and invalid-selector tests at debug levels 1 and 3.  The ACPI source compiled with a diagnostic check of dynamic contours after each backend pass.  Closure-write tests passed again.  Logs are `debug-contour-fixed.log`, `debug-jump-probe.log`, and `debug-jump-table-load.log`.

The first host diagnostic omitted the target architecture binding.  Its replacement-predicate test then encountered an SBCL function-result type check.  Correcting those test setup errors established the failing cases above.  A second full rebuild started from an empty cache after moving the incomplete first cache to `build-x86-64.before-debug-go`.

## Cold-generator allocator state

Every target file compiled after the jump-table correction.  Serialization then rejected creation of the value cell for `*WIRED-AREA-FREE-BINS*` after image finalization.  The serializer had assumed that compiled references would already make every allocator state cell reachable.

The serializer now creates its required allocator state cells before traversing the symbol graph.  Finalization still prohibits allocation and verifies that those cells are present.  The image built successfully using the fully rebuilt target files.  The serializer change affects the host builder, so those target files did not require another compilation.  The build log is `debug-full-serialize-build.log`.

The resulting image has not passed boot.  KVM QEMU exited with status 0 immediately after the bootloader transfer, before supervisor console output.  A QEMU instruction-emulator diagnostic recorded a page fault at `0x8000004970`, followed by a double fault and another page fault.  The generated symbol map identifies that address as `BYTE-POSITION`, in pageable function memory.  Paging and the supervisor exception handlers were not yet initialized.  The traces are `debug-full-early-failure-serial.log` and `debug-tcg-cpu.log`.

Binding preservation prevents optimizations that the early bootstrap had depended on to avoid calls into pageable code.  The user has been asked to choose between a bootstrap build at debug level 1, retaining debug level 3 as the running compiler's default, and further compiler support for debug level 3 throughout the bootstrap.  This changes the supported code classes and requires explicit approval.  No bootstrap policy change has been made.

GDB 16.3 was installed on `minideb2` under the user's authorization for required host tools.  The diagnostic QEMU instance used host-loopback GDB and a local QMP socket.  It was stopped after inspection.  The original SWANK VM remains running.  A second VM's launch scripts have been prepared for cold-boot and saved-image tests, but that VM has not been started.

## Test setup after the full-build audit

The installed and recorded `build-test.sh` now remove the generated `build-x86-64` cache before building the CI image.  This makes full target recompilation part of every compiler boot test.  The preceding full build exercised the same compiler invocation after moving that cache aside.  The edited shell script passed its syntax check.  Boot still awaits resolution of the debug policy issue above.

`test-debugger.lisp` accepts an optional port.  Its explicit-port run against the existing endpoint passed remote stop, local inspection, function repair, restart, multiple values, and cleanup.  The default remains 4005.  The prepared second VM uses 4006.

## Approved bootstrap compilation profile

The user approved compiling the bootstrap at `(debug 1)` while retaining `(debug 3)` as the running compiler's default.  Bootstrap code retains existing inspection support without guaranteed mutable source bindings.  The source definition of the running compiler's default policy remains unchanged.

The recorded live and CI scripts now load one `build-image.lisp` recipe.  Its policy binding covers cross-compiler initialization and image compilation, since initialization creates inline ASTs whose binding properties survive later copying.  Both scripts remove the generated target cache before compilation.  A full CI rebuild and boot test will validate this profile before publication.

The first profile build generated its image, then failed while reading the build script.  I had edited that script while SBCL held it open, changing the text at the remaining file position.  The final recipe accepts one image base pathname, and the full build was restarted with the recipe held fixed.  The failed invocation remains in `debug-bootstrap-build.log`.

The final script completed a full rebuild from an empty target cache.  Its KVM boot reached `CI build completed successfully!` and exited with status 3.  The source tree included the pending closure-sharing correction.  Logs are `debug-bootstrap-final-build.log`, `debug-bootstrap-boot.log`, and `debug-bootstrap-serial.log`.  A separate live image was serialized from those same target files for tests on port 4006.

## Debugger implementation: shared closure storage

Closure lowering now gives each preserved captured binding one environment cell.  Incoming arguments and binding initializers use hidden temporary variables.  Reads in the defining function use the same cell as reads in its closures, including bindings without source assignments.

The earlier probe exposed two entries for captured `A`, and changing the environment cell left the defining function reading 111 while the closure read 222.  After the correction, the test finds one entry and both reads return 222.  Additional cases passed for a closure writer, `LET`, multiple-value bindings, optional parameters with and without supplied arguments, supplied-p variables, rest lists, and keyword parameters.  Escaped closures observe the expected values after a full GC and continue sharing writes.

The separate image on port 4006 booted from the approved bootstrap profile.  Its running compiler reports `(SAFETY 3 DEBUG 3 SPEED 1)`.  All binding and closure tests passed without reloading compiler files.  Frame-local IDs, keyword allocation, jump-table cleanup, structure layouts, the client tests, and remote function repair through a restart also passed.  Logs are `debug-bootstrap-cold-tests.log`, `debug-bootstrap-cold-client.log`, and `debug-bootstrap-cold-restart.log`.

The initial readiness query used a source-only package nickname.  Its replacement incorrectly expected the debugger hook to be `NIL` inside a SWANK request.  SWANK dynamically binds that hook in `call-with-debugger-hook`.  The corrected query checks desktop initialization and the compiler policy.  The hook assertion failure remains in `debug-bootstrap-readiness-error.log`.

These tests use the internal frame writer during a callback with a live target activation.  Local debug-policy overrides, declared types, scope identities, public mutation, and stop lifetimes remain separate work.

## Saved-image tests of the bootstrap profile

The second VM saved a snapshot containing a newly compiled closure and restarted from it.  That closure returned its captured list after restore, and the running compiler still reported debug level 3.  Binding inspection, local writes, closure writes, GC, frame-local IDs, keyword allocation, jump-table cleanup, structure layouts, client behavior, and remote restart recovery passed again.  Logs are `debug-bootstrap-snapshot.log`, `debug-bootstrap-restored-tests.log`, `debug-bootstrap-restored-client.log`, and `debug-bootstrap-restored-restart.log`.

## Debugger implementation: local compilation policy

The compiler already marked a binding introduced under a local `(debug 3)` declaration, but backend policy decisions used the enclosing function's debug level.  At function-level debug 0, metadata removal and final map construction discarded that binding.  At levels 1 and 2, register allocation did not extend its lifetime for inspection.

Backend removal now retains marked bindings at debug level 0.  The allocator includes each marked binding in debug liveness and rebuilds the retained map at every function debug level.  Closure lowering also preserves the environment pointer needed to reach a marked captured binding.  At function-level debug 0, closure metadata names only preserved bindings.

The new test failed before the correction with no binding for `A`.  After reloading the four compiler files, all cases passed at enclosing debug levels 0, 1, and 2.  The cases check independent copies, captured bindings, an unused heap value, debugger writes, and full GC before and after mutation during inspection.  Further cases check use of a preserved binding inside a nested debug-0 region.  The function's ordinary debug-0 parameters remain absent from its reported locals.  Existing binding, closure, keyword, jump-table, and remote restart tests passed.  Logs are `debug-policy-before.log`, `debug-policy-load.log`, `debug-policy-live-tests.log`, and `debug-policy-live-restart.log`.

The full rebuild completed from an empty target cache.  The CI image reached its success marker and QEMU exited with status 3.  Logs are `debug-policy-full-build.log`, `debug-policy-full-boot.log`, and `debug-policy-full-serial.log`.

The updated live compiler was then saved and restored.  The local-policy, binding, closure, GC, keyword, jump-table, and remote restart tests passed after restore.  Logs are `debug-policy-snapshot.log`, `debug-policy-restored-tests.log`, and `debug-policy-restored-restart.log`.

## Proposed debugger stop lifetime

The next proposed increment gives a guest debugger service ownership of condition stops in ordinary Lisp threads, including background threads.  SWANK carries requests to that service.  The stopped thread retains its dynamic environment and executes debugger operations through a command loop.  The current frame structure contains a frame pointer and saved-register data without a lifetime check, so public mutation needs this service before exposing those references remotely.

The proposed lifetime and control rules require approval:

| Event | Proposed behavior |
|---|---|
| A condition enters the debugger | Create a stop before unwinding the failing activation.  Retain its condition and restart context. |
| A connection closes | Keep the stop.  Release that connection's control ownership after accounting for any accepted command.  The thread retains its stack, reachable objects, and any locks it holds. |
| A client attaches | Grant one controller access to the stop and return a new control token.  Reject commands carrying an older token. |
| A command identifies a frame or binding | Require the current boot, stop, and frame generation.  Reject expired references before accessing stack memory. |
| A mutating request loses its reply | Query its recorded state on reconnect.  An accepted operation is executed at most once within that boot.  Keep its outcome with the stop record until explicit release. |
| A restart or abort transfers control | Invalidate the stop's frame and binding references when execution leaves the stop.  Preserve the operation record for reconnect. |
| Debugger execution enters another stop | Retain the parent and identify the child.  Frame-changing operations on the parent wait for resolution of the child. |
| The VM restarts or restores an image | Reject handles from the preceding boot.  Any retained stop and operation state reflects the restored image. |

Acceptance tests would disconnect before and after command acceptance, reconnect to inspect and invoke a restart, reject a second controller and stale references, and verify that a lost reply cannot repeat a write or restart.  Background-thread failures, GC while stopped, nested debugger failures, multiple values, and unwind cleanup each need tests.  The first implementation would expose only operations whose stop-state requirements have passed those tests.

Public binding mutation also requires type and scope metadata.  The [Common Lisp type declaration rules](https://www.lispworks.com/documentation/HyperSpec/Body/d_type.htm) constrain references and assignments within each declaration's scope, including nested declarations.  Mezzano represents those declarations with `AST-THE` nodes, while its current runtime local-variable records contain a name, location, and representation.  One type attached to the binding's initial declaration would omit later scope restrictions.  The metadata and compiler audit must account for those restrictions before a public writer is added.

The user requires the implementation to remain in Lisp wherever possible.  The guest stop service, session state, frame operations, and debugger evaluation will use Common Lisp.  The current SWANK client and compiler/debugger tests use Common Lisp, apart from the existing Python client integration test.  Shell scripts build the images and launch QEMU.

## Approved stop lifetime: guest service

The user approved the proposed stop-lifetime rules.  The first implementation is `system/debugger-service.lisp`, loaded after the existing debugger during warm initialization.  The compiler package definition exports the guest API.  This increment implements opt-in condition stops in ordinary Lisp threads.

The stopped thread owns its condition, restart objects, and captured frames.  A service mutex protects ownership, command acceptance, and recorded outcomes.  Frame inspection, printers, and restart functions execute outside that mutex on the stopped thread.  Cleanup closes the stop and clears live frame and restart references before the failing activation unwinds.  The frame capture starts at the retained debugger activation, identified by its frame pointer, excluding temporary stack-walking activations.

Controllers acquire distinct leases.  Closing a controller releases ownership while accepted commands retain their state.  Each stop records monotonically numbered commands and rejects conflicting reuse.  An identical accepted request returns its existing ID, including after the stop has closed.  The record distinguishes a normal return from a nonlocal exit.  Explicit release removes a closed stop and clears its command records.

Opaque guest handles retain the boot event returned by [the supervisor boot implementation](../../supervisor/entry.lisp).  Validation uses object identity before reading stack memory.  The command loop rejects a queued command from an earlier boot.  Saved-image behavior needs a separate restore test.  External SWANK identifiers need their own representation and validation.  The numeric stop counter does not establish boot identity.

The live test compiled the service and ran it on the debugging VM at port 4006.  It passed background-stop retention, caller locals after GC, exclusive control, closed-controller rejection, restart replay while running and after completion, conflicting-request rejection, nested printer failure and recovery, multiple application values, and one unwind cleanup.  The first test expected unqualified local names, but the new thread's package context produced qualified names.  Correcting those expectations produced the pass in `debug-service-second-test.log`.  The service's first compilation is recorded in `debug-service-load.log`.

Review identified a completion race: publishing a returned result before clearing the active command could make a subsequent request receive a transient busy error.  The final implementation updates both fields under the same lock.  Further checks cover release of an active stop and use of a parent's frame in a child stop.

- [x] Approve stop and controller lifetimes.
- [x] Implement and test guest-owned background stops and command records.
- [ ] Test the warm source addition with a full build and boot.
- [ ] Test retained stops and stale guest handles across saved-image restore.
- [ ] Add SWANK controller lifecycle and external handle validation.
- [ ] Test disconnect before acceptance and after acceptance, followed by recovery.
- [ ] Add type and scope metadata before public binding mutation.

The reviewed service test passed, including those two checks.  The existing SWANK function-repair and restart test also passed.  The logs are `debug-service-live-test.log` and `debug-service-legacy-test.log`.

## Stop service build and saved-image tests

The full rebuild compiled every target file, including the new warm debugger service.  The CI image reached `CI build completed successfully!` and QEMU exited with status 3.  Logs are `debug-service-build.log`, `debug-service-boot.log`, and `debug-service-serial.log`.

The live debugging VM saved an image with an ordinary thread stopped at an undefined-function call.  The snapshot retained a controller, control lease, stop handle, frame reference, and completed frame-list command.  After restarting that VM, the test rejected the old stop handle, lease, frame reference, and controller.  A fresh controller attached to the restored stop, inspected its locals after GC, repaired the function, and invoked its retry restart.  The application returned `333` and `:RESTORED`, with cleanup running once.  The completed command record survived and reported that it belonged to an earlier boot.  Logs are `debug-service-snapshot.log` and `debug-service-restored-test.log`.

This restore test covers a parked stop and a completed command.  A command in progress at snapshot time and a queued command spanning restore need separate tests.

- [x] Test the warm source addition with a full rebuild and boot.
- [x] Test a retained stop and stale guest handles across saved-image restore.

## Debugger implementation: SWANK sessions and host client

[Slime commit 19b017fe](https://github.com/jsmorph/slime/commit/19b017fe5a53bfe71b095c12c88ffe9ccc002f94) adds the Mezzano debugger contrib.  It uses SWANK's existing [connection-closed hook](https://github.com/jsmorph/slime/blob/19b017fe5a53bfe71b095c12c88ffe9ccc002f94/swank.lisp) to close the guest controller.  The stop service owns accepted commands independently of that connection.  The adapter maps protocol tokens to opaque guest handles and creates a new controller on reconnect.

Session names come from 256 bits read by host Lisp from `/dev/urandom`.  The client creates that name before opening the session.  The guest records its current boot-event object.  Resume requires the existing record and the same boot event.  It rejects both a session restored from an earlier boot and a session absent because the image predates its creation.  Creating a fresh session uses a fresh host-generated name.  A resume failure never creates a session.  The protocol therefore avoids identifying a boot through a guest counter, saved random state, or object address.

The host client uses the existing Common Lisp packet transport.  It supports opening, reconnecting, submitting commands, and querying recorded outcomes.  The core result now includes its operation so the adapter can encode frame results without accessing private service structures.  The background fixture is shared by the guest and remote tests.

The reconnect test passed against port 4006.  One connection closed before submitting a command.  Later connections submitted a returning restart and a nonlocal retry restart, verified acceptance through a second connection, and closed without reading the submission replies.  Reconnection recovered the recorded states.  Repeated submissions did not repeat either restart.  The tests also passed exclusive-control, old-lease, foreign-token, frame-inspection, multiple-value, and cleanup checks.  The first host test draft had two extra closing parentheses and failed before connecting.  Its corrected run is `debug-service-reconnect-second-test.log`.

The remote restore test passed for a session saved in the image and a session created after the snapshot.  Both were rejected after VM restart.  A fresh session rejected old protocol tokens and a prior-boot frame returned by a retained command record.  It inspected the restored caller after GC, repaired the function, and resumed the application with `333`, `:REMOTE-RESTORED`, and one cleanup.  Logs are `debug-service-remote-snapshot.log` and `debug-service-remote-restored-test.log`.

Review also found that a retained child's parent handle could refer to an explicitly released record.  Stop information now reports the parent ID independently and returns a parent handle only while that record remains registered.  The guest test checks release of the parent before inspecting the child.  The final reconnect test includes that guest test and passed.  Existing SLDB recovery also passed.  Logs are `debug-service-final-load.log`, `debug-service-reconnect-final-test.log`, and `debug-service-legacy-final-test.log`.

Entry remains explicit through `call-with-debugger-service`.  Existing SWANK evaluations still use SLDB and its connection-dependent completion path.  Default debugger installation, retained evaluation jobs and I/O, and the remaining compiler/debugger agenda require further implementation.

- [x] Add SWANK controller lifecycle and external handle validation.
- [x] Test disconnect before commands and lost replies after acceptance.
- [x] Test rejection of remote sessions and frame references across restore.
- [ ] Test queued and running commands across image restore.
- [ ] Integrate retained top-level evaluation and its I/O.
- [ ] Complete type/scope metadata and the Genera operation inventory.

## Expired session storage

The final review found that boot validation rejected old sessions but left their handle tables reachable.  [Slime commit 2b2086a9](https://github.com/jsmorph/slime/commit/2b2086a9951f7b18dc0b88e32729224ba1485029) releases those tables and controllers on the first adapter operation after a boot change.  Used names remain recorded to reject reuse.  The README and build instructions select this revision.

The remote restore test now checks that prior-boot sessions retain no controller, connection, or handle-table entries.  That test passed, including stop recovery, GC, restart values, and cleanup.  The network reconnect test then passed on the restored VM.  Logs are `debug-service-session-cleanup-load.log`, `debug-service-cleanup-snapshot.log`, `debug-service-session-cleanup-test.log`, and `debug-service-reconnect-restored-test.log`.

The debugging VM saved the published service and adapter with no active debugger stops, then restarted from that image.  A fresh host client connected through the saved adapter, listed no active stops, and released its session.  Logs are `debug-service-published-snapshot.log` and `debug-service-published-readiness.log`.  The original VM on port 4005 remained running.  Development and tests used port 4006.

## Approved reinvocation defaults: 2026-10-12

The user approved current argument values as the default for frame reinvocation, with original arguments available through an explicit option.  Debugger edits to arguments will therefore affect the retried call.  The user also approved using the latest definition when reinvoking a globally named function, so redefining that function changes the code used for the retry.

Frame reinvocation, original argument storage, and their tests remain to be implemented.

## Approved evaluation lifetime and input: 2026-10-12

The user approved continuing remote evaluations after client disconnection and retaining their results until explicit release.  This permits reconnection to retrieve the result of work already in progress.

Input behavior depends on the evaluation mode.  An explicitly interactive evaluation waits for input or an explicit EOF, and reconnection restores access to that input stream.  A batch evaluation consumes supplied input and then receives EOF.  The user approved this distinction after the initial question failed to specify the input mode.

Retained evaluation jobs and their input streams remain to be implemented and tested.

## Decision procedure and running-command restore: 2026-10-12

The user authorized the remaining agenda under a standing procedure: review the implementation and evidence, prioritize simplicity, state a recommendation and its consequences, document it, and proceed with that recommendation.  This replaces separate approval requests for design decisions within the agenda.  The repository instruction files record the procedure and require rereading after compaction.

For a command running at snapshot time, the recommendation is to use Mezzano's existing thread restoration.  [Thread initialization](../../supervisor/thread.lisp) retains ordinary thread state and resumes the saved world.  [Command execution](../../system/debugger-service.lisp) keeps the active command on that thread's stack and records its result when the operation returns.  These source findings support testing the existing behavior before adding implementation code.

The test will snapshot an invoked restart while it waits on an event, let it return in the original execution, restore the snapshot, and complete the restored invocation.  Assertions will check the saved command state, expired old control, rejection of prior-boot resubmission, one restart entry in the restored state, GC, returned values, application recovery, and cleanup.  This tests a running command blocked inside Lisp.  Queued commands, arbitrary instruction positions, and external I/O remain separate cases.

## Running-command restore test: 2026-10-12

The existing thread-restoration mechanism passed the running-command test.  A restart entered once and waited on an event when the image was saved.  A later request opened the event and let the original execution return.  Restoring the image recovered the earlier `:running` state and closed event.  The restored command retained its prior-boot identity.  Old control was rejected, and resubmitting that command under a new controller reported `:request-conflict`.

After full GC, opening the restored event let the saved invocation return `42` and `:PROBE`.  The restart-entry counter remained one.  Repairing the application's missing function and invoking its continuation then returned `333` and `:RUNNING-RESTORED`, with one cleanup.  The test released the stop and found no active stops.

The first driver placed the post-snapshot event release in the same evaluation that saved the image.  Although that run passed, it left the release in a saved evaluation's continuation.  The final driver sends the release through a separate evaluation created after saving.  That run also passed.  Logs are `debug-service-running-prepare.log`, `debug-service-running-restored-first.log`, `debug-service-running-prepare-final.log`, and `debug-service-running-restored-final.log`.

Only the test and documentation changed.  The tested case is a running restart blocked inside Lisp.  Queued commands, other execution positions, and external I/O remain untested.

The VM then saved the completed test state and restarted.  A fresh debugger client listed no active stops and released its session.  Logs are `debug-service-running-clean-snapshot.log` and `debug-service-running-readiness.log`.

## Documentation ownership: 2026-10-12

The user approved one current design document, with separate usage, protocol, operations, and historical references.  The recommendation is to put architecture, capability status, and test scope in `doc/debugger.md`; user workflows in `tools/swank/README.md`; exact RPC forms and errors in Slime's `contrib/swank-mezzano-debugger.md`; and build, VM, snapshot, restore, and test commands in `tools/swank/minideb2/README.md`.  This journal retains decisions and evidence in chronological order.

The user guide will demonstrate the implemented explicit background-thread wrapper.  Its example must pass against the development VM.  Documentation checks will verify repository links and formatting.  Planned evaluation jobs and frame operations will remain identified as implementation work.

The user-guide example passed on port 4006.  It created an explicitly wrapped background computation, inspected `A = 111` and `B = 222`, reconnected through the same session, invoked `CONTINUE`, and checked `333`, `:DONE`, and one cleanup before releasing the stop and session.  Logs are `debugger-guide-guest.log` and `debugger-guide-host.log`.

The latest service metadata changes had live and restore evidence but lacked a fresh cold build.  The recommendation is to run the existing full-recompilation CI build and boot scripts against the current implementation, using the separate `mezzano.image` test image.  This supplies evidence for the pinned build recipe while the live and development VMs keep their separate images.  Logs will be `debugger-current-build.log` and `debugger-current-boot.log`.

The fresh full recompilation and CI boot passed at Mezzano `6edf42a5` with the Slime implementation at `2b2086a9`.  QEMU exited with status 3 and the serial log contained `CI build completed successfully!`.  The serial log was preserved as `debugger-current-serial.log`.  Documentation checks passed for 22 shell blocks and 32 repository links, including section anchors and links between the two repositories.  Shell syntax checks do not establish that the fresh-host provisioning commands have been run.

## Queued-command restore decision: 2026-10-12

The recommendation is to test queued-command expiration with the existing supervisor thread controls.  `stop-thread` waits until a foothold stops the target.  The service mutex inhibits footholds, so this stop cannot suspend the target while it holds that mutex.  Submitting after the thread stops leaves the command pending.  Ordinary stopped threads retain their state through image restoration.  The service command loop compares the accepted command's boot event before executing it and marks an earlier-boot command `:expired`.

The test will stop a retained debugger thread, queue a returning restart, and save the image with zero restart entries.  After restore, it will verify the pending record and old-control rejection, resume the thread, and check expiration without executing the restart.  A fresh command will invoke that restart once, followed by application recovery and cleanup.  This covers the pending-to-expired transition using production supervisor operations.  Running commands at other instruction positions and external I/O remain separate cases.

The queued-command restore test passed on port 4006.  The saved target remained stopped, and the command remained pending with its prior-boot identity.  After full GC and thread resumption, the command became `:expired` with zero restart entries.  A fresh invocation returned `42` and `:PROBE` with one entry.  Application recovery returned `333` and `:QUEUED-RESTORED`, and cleanup ran once.  The test released its stop.  Logs are `debug-service-queued-prepare.log` and `debug-service-queued-restored.log`.  No runtime changes were required.

## Retained evaluation foundation: 2026-10-12

The recommendation is a guest-owned evaluation record and worker thread, exposed through the existing debugger service and SWANK session adapter.  The first increment implements batch source evaluation with supplied string input followed by EOF.  Interactive input and asynchronous interruption follow as separate increments.  The approved interactive waiting behavior remains the requirement.

A client-generated name identifies a submission independently of its connection.  An identical submission in the same boot returns the existing job.  Changed source, package, or input under that name is a conflict.  Restored jobs remain discoverable through new boot-scoped handles, while earlier-boot submissions reject replay.  Release removes completed job data and retains the used name to reject reuse.  These rules address a lost creation reply without another execution.

The worker establishes the retained debugger before reading or evaluating source.  It reads and evaluates forms in order, preserving package changes within the job and the final form's multiple values.  An ABORT restart unwinds the job with normal cleanup.  Unhandled conditions retain their activation and appear as stops associated with the job.  No SWANK connection or streams enter the worker's bindings.

Output uses a character stream with synchronized storage.  Reading from a character offset copies retained output without consuming it, so a reconnecting client can repeat a read.  Standard, error, and trace output share this stream, preserving write order.  The worker prints result representations while still inside retained debugging, then records completion.  Guest APIs also retain the Lisp result objects.  Output and results remain until explicit release.  This increment has no output quota.

The implementation will reuse the service mutex and boot validation, existing thread creation, string input streams, Gray output streams, and retained condition stops.  Required tests cover source order, package changes, zero and multiple values, batch EOF, output while stopped, printer failure, abort cleanup, duplicate/conflicting submission, result release, and later adapter reconnect tests.  A fresh image build must load the service after the stream definitions.

The guest batch service passed its live test on port 4006.  It retained output through stops, distinguished zero values from one NIL value, preserved source/package sequencing, consumed supplied Unicode input followed by EOF, rejected conflicting/released submissions, recovered reader and printer conditions, survived full GC, and ran abort cleanup once.  Logs are `evaluation-service-load.log` and `evaluation-service-test.log`.  The full build has started in `evaluation-current-build.log`.  SWANK job operations, interactive input, interruption, and job restore remain separate increments.

## SWANK evaluation operations: 2026-10-12

The recommendation is to extend the existing session adapter with job creation, listing, information, output reads, and release.  A `:job` token follows the existing session-token rules and maps to a boot-scoped guest job handle.  The adapter reuses a stable token for each job name within a session.  Job information translates associated stops into existing stop tokens.  Restart execution keeps the current exclusive-controller rules.

Job records belong to the guest.  Any attached session can discover them, read output/results, and release a terminal job.  Releasing a session leaves its jobs running.  The adapter returns printed result strings produced by the worker, avoiding application printers inside adapter locks.  Job output returns copied text and an ending character offset.  No new transport or host dependency is required.

The host client will export its existing random-name generator for job names.  Tests will leave a creation reply unread after an observer confirms acceptance, disconnect, repeat that submission, and check one execution.  They will also disconnect at a condition stop, recover through a fresh session, read output repeatedly, reject foreign job tokens, and release completed storage.  Old-session release and job release have separate tests.

The first network test failed because its fixture setup passed several forms to SWANK's `eval-and-grab-output`, which evaluates one form.  Only the first definition ran, leaving the gate variable unbound.  The evaluation job retained that condition.  The fixture was aborted through its job restart and released.  The test helper now wraps its setup forms in PROGN.  The failed log is `evaluation-reconnect-first-failed.log`.

The corrected network test passed: an unread creation reply, one execution after duplicate submission, continued evaluation after session release, retained output and values, fresh-session condition recovery, foreign-token rejection, full GC, one cleanup, and explicit job release.  Logs are `evaluation-adapter-load.log` and `evaluation-reconnect-test.log`.  Reloading the adapter also preserved existing session records with initialized job-token tables.

The batch service passed a fresh full recompilation and CI boot at Mezzano `0381885f`.  QEMU exited with status 3 and the serial log contained `CI build completed successfully!`.  Logs are `evaluation-current-build.log`, `evaluation-current-boot.log`, and `evaluation-current-serial.log`.  The user-guide batch example also passed, printing `Computed.`, `42`, and `:DONE`.  Its log is `evaluation-guide-example.log`.

## Evaluation restore decision: 2026-10-12

The recommendation is to test evaluation persistence through the existing image snapshot and thread restoration.  The job record, output buffer, input stream position, values, and retained stop already reside in the guest heap and stack.  No additional restore mechanism is proposed.

The test will save one completed job and one job stopped after reading its first input line.  A fresh session after restart must reject old remote and guest handles, reject resubmission of the earlier-boot job, recover saved output and completed values, and continue the stopped job at its second input line.  It will check one body entry, one cleanup, EOF after the remaining input, and retirement of old session job-token tables.  Tests will preserve their host state file across the VM restart.

The restore test passed for a completed batch job and a condition-stopped job with partially consumed input.  The completed result and output survived.  The stopped job continued with its second input line and then EOF, preserving one body entry and one cleanup.  Old guest/session handles and prior-boot submission replay were rejected.  Old session job-token tables were empty after retirement.  Logs are `evaluation-restore-prepare.log` and `evaluation-restore-finish.log`.  The existing debugger reconnect test also passed with the extended adapter in `evaluation-existing-debugger-test.log`.

After the batch restore test, the VM saved the completed state with no unreleased jobs or active stops.  The log is `evaluation-completed-snapshot.log`.  The operations guide now pins Mezzano `0609f5ee` and Slime `9b2630cd`, including the batch network and restore tests.

## Interactive input decision: 2026-10-12

The recommendation is an explicitly interactive job mode with a guest character-input stream backed by retained input and a supervisor event.  Reads wait when input is exhausted and EOF has not been supplied.  They use no connection-owned state.  Batch jobs keep their existing supplied-input-then-EOF behavior.  Job information reports input mode, accepted length, explicit EOF, and whether a read is waiting.

Input submission uses an expected character offset, text, and an optional EOF flag.  Text appends only at the accepted length.  A repeated range that already matches retained input succeeds without appending.  A conflicting range fails.  EOF closes input after the accepted text, and a repeated EOF succeeds only at the recorded end.  This uses the input history to resolve lost replies without a second request ledger.  Concurrent writers serialize under the service mutex, and an incompatible append at the same offset reports a conflict.

Any attached session can supply input to an interactive job.  The guest validates boot-scoped handles.  After restore, a fresh session discovers the restored input length before supplying further input.  Stored input and output remain until job release.  No quota or automatic truncation is introduced in this increment.

The stream will use existing Gray methods, unread-character support, and event waiting.  Growth and copying complete before advancing the visible input length.  Closing the stream wakes a blocked reader.  Completion closes the job's input and output streams.

Tests will cover waiting across disconnect, character offsets and Unicode, unread/listen/nonblocking reads, supplied EOF, conflicting and repeated input, EOF after a partial line, closure, GC, and restore while waiting for input.  Existing batch and reconnect tests must still pass.

The guest input tests passed, covering Unicode character offsets, replay/conflicts, EOF, peek/unread/listen, nonblocking reads, buffer growth, clear/close, GC, cleanup, and completion closing both streams.  Batch tests also passed.  The first host input-test draft had an extra closing parenthesis and failed to load before executing its tests.  After correction, both batch and interactive network tests passed, including unread input and EOF replies without duplicate text.  Logs are `interactive-service-load.log`, `interactive-guest-test.log`, `interactive-reconnect-syntax-failed.log`, and `interactive-reconnect-test.log`.

The interactive restore test passed while READ-LINE waited with a partially read line.  It retained the accepted input prefix and returned the completed line after receiving a suffix and EOF through a fresh session.  GC, old-token rejection, values, one body entry, and one cleanup passed.  Logs are `interactive-restore-prepare.log` and `interactive-restore-finish.log`.

Source review found that input waiting was marked immediately before establishing its unwind cleanup.  A nonlocal exit in that interval could leave the flag set.  The recommendation is to establish cleanup before changing the flag, preserving the flag's lifetime across every exit from the read operation.  This changes the final source after the first successful compilation.  Guest and network tests and a fresh build will run against the corrected source.

The corrected input cleanup passed the guest and network tests and the restore test again.  Logs are `interactive-final-guest-test.log`, `interactive-final-reconnect-test.log`, `interactive-final-restore-prepare.log`, and `interactive-final-restore-finish.log`.  The input example check initially expected only the line value from READ-LINE.  Its corrected assertion includes the missing-newline flag, NIL for the supplied newline, and passed.  The failed fixture was released.  Logs are `interactive-guide-example-first-failed.log` and `interactive-guide-example.log`.

The final interactive implementation passed a full recompilation and CI boot.  QEMU exited with status 3 and the success marker appeared in the serial log.  Logs are `interactive-final-build.log`, `interactive-final-boot.log`, and `interactive-final-serial.log`.  The development VM saved the completed state with no unreleased jobs or active stops in `interactive-completed-snapshot.log`.

## Evaluation interruption decision: 2026-10-12

The recommendation is a retained, numbered interrupt request delivered through `establish-thread-foothold`, which the existing SWANK backend already uses for thread interruption.  Delivery respects `without-footholds`.  It enters the retained debugger with a CONTINUE restart.  The job's existing ABORT restart performs application cleanup.

A job keeps interrupt request history until release.  Repeating an accepted ID in the same boot returns that ID without another delivery.  Earlier-boot requests reject resubmission.  One interrupt can be pending or running per job.  Results distinguish pending delivery, an active interrupt stop, continuation, nonlocal exit, cancellation, and expiration.  Any attached session may request an interruption, while stop commands keep their exclusive controller requirement.

The service must own an accepted request independently of the requesting connection.  Publication and foothold scheduling occur under its mutex with caller footholds inhibited.  An interrupt requested before the worker installs its streams and ABORT restart stays pending until the worker arms delivery inside that dynamic context.  Interrupting the calling thread through this API will be rejected.  A target already inside a retained stop records cancellation without creating another stop.  Interrupting an executing debugger command remains separate work.

Completion cancels an undelivered request.  A queued request from an earlier boot expires when selected.  A running interrupt stop uses the tested retained-stop restoration path.  Cleanup must be established before publishing the running state, so nonlocal exit always records its outcome.

Tests will cover a computing worker, a worker waiting for input, continuation and abort, locals and GC, immediate submission after job creation, duplicate IDs and unread replies, existing stops, inhibited delivery, and queued/running requests across restore.  Source inspection of the startup transition complements the immediate-submission test.  That test alone cannot establish which scheduler ordering occurred.

The interruption guest test passed for computing and input-waiting jobs, preserved locals after GC, continuation, abort, duplicate IDs, existing stops, immediate requests, inhibited delivery, self-interruption rejection, and cleanup.  The network test passed with an unread interrupt reply and one stop after resubmission.  Logs are `interrupt-service-load.log`, `interrupt-guest-test.log`, and `interrupt-reconnect-test.log`.

Review found a completion interval in which the worker had left RESTART-CASE's ABORT binding but had not yet cleared its interrupt-ready flag.  The recommendation is an inner UNWIND-PROTECT that disarms delivery before leaving that restart binding.  The outer cleanup then cancels any request accepted while disarmed and records job completion.  This follows the scopes in `system/restarts.lisp` and keeps the two cleanup responsibilities explicit.  The initial successful tests do not establish correctness for the identified interval.  Tests and a fresh build will run against the corrected source.

The abort review also requires tests for cleanup that signals a condition or performs another nonlocal transfer.  The recommendation is to preserve those Common Lisp effects and report the observed job outcome.  Reaching the job's ABORT clause records `:aborted`.  If cleanup redirects control back into the computation, the job can return instead.  The interrupt record's `:unwound` state must not imply that the job aborted.

The corrected-source guest run timed out after the computing worker continued from full GC.  Inspection found a retained memory-fault condition at `%%OBJECT-OF-TYPE-P`, with R8 containing an unmapped former heap address.  The later cleanup tests reached their final empty-registry assertion and found this earlier failed job.  Their final result is therefore a failure.  Logs are `interrupt-final-guest-test.log`, `interrupt-cleanup-test.log`, `interrupt-memory-fault.log`, `interrupt-fault-state.log`, and `interrupt-fault-registers.log`.  The recommendation is to retain diagnostic evidence and reproduce the GC/resumption fault before publishing interruption support.  The successful build alone does not establish this behavior.

The saved-register scanner in `scavenge-interrupt-stack-frame` passes `memref-signed-byte-64` results to `scavenge-object`.  Those accessors box the raw word as an integer, as defined by the x86-64 memory builtins.  `scavenge-object` returns immediate integers unchanged.  Normal stack roots use `memref-t`, and the full-save thread scanner uses Lisp-valued register accessors.  The recommendation is to use `memref-t` for the saved data-register roots and to test each x86-64 data register with a movable vector held across an injected foothold and full GC.  The test compares against the relocated root without dereferencing a stale value.  It will first run against the existing scanner, then against the correction.  R14 is reserved for NIL and is outside the movable-register fixture.

The deterministic test failed in all eight tested movable-data registers with the original scanner: R8, R9, R10, R11, R12, R13, R15, and RBX.  The log is `foothold-gc-original-test.log`.  The correction changes saved Lisp-root accesses to `memref-t`.  Live testing will reload only the scanner function as wired code, using the loader's existing `:wired T` option and bootstrap optimization policy.  A fresh full build and boot will test the compiled image afterward.

The corrected scanner passed all eight register cases in `foothold-gc-corrected-test.log`.  The changes also use the Lisp-valued accessor in the ARM64 extra-register branch, but ARM64 execution remains untested.  Review identified further interrupt-scanner paths to test: collection while the return thunk is restoring registers, compiler GC restart addresses, and ARM64 interior-pointer adjustment.  These are separate from the tested saved-data-register correction.

With the corrected GC scanner, the interruption guest tests and all batch, interactive, and interruption network tests passed.  The queued/running interruption restore test also passed after snapshot and restart, preserving one body entry and one cleanup.  Logs are `interrupt-gc-corrected-guest-test.log`, `interrupt-gc-corrected-network-test.log`, `interrupt-gc-corrected-restore-prepare.log`, and `interrupt-gc-corrected-restore-finish.log`.  Cleanup tests cover a continuable condition during ABORT cleanup and a cleanup THROW that supersedes ABORT, leaving the job returned and the interrupt unwound.  The design, guide, and protocol now distinguish those outcomes.  A fresh image build is still running in `interrupt-gc-corrected-build.log`.

## Interrupt return scanning decision: 2026-10-12

The next increment will test collection at both GC metadata regions of `%%partial-save-return-thunk`: before register restoration and immediately before IRET.  Existing supervisor single-step controls can place a stopped fixture at those instructions.  Tests will cover both a full-save thread and an additional foothold above that saved return state.  A movable register value must survive and the thread must finish normally.  This exercises production return code without adding instrumentation to it.

Source review found that the nested interrupt scanner recurses with its stack pointer although its argument is a frame pointer.  It also writes compiler restart instruction addresses through `memref-t`, which stores a tagged Lisp integer.  These require targeted tests and corrections before relying on arbitrary interruption positions.  The current saved-register test covers neither path.  The development VM has saved its completed state before these low-level tests.

Mezzano `bf07d9cb` and Slime `04d5ef6b` are pushed.  The interruption implementation and GC correction passed a full build and CI boot.  QEMU exited with status 3 and `CI build completed successfully!`.  Logs are `interrupt-gc-corrected-build.log`, `interrupt-gc-corrected-boot.log`, and `interrupt-gc-corrected-serial.log`.  The development VM saved the completed state with no unreleased jobs or active stops in `interrupt-completed-snapshot.log`.  The operations guide pins these revisions.

The first return-scanner test file used the single-colon spelling of internal supervisor thread-control symbols.  Compilation rejected it before executing the test.  The corrected spelling uses the existing internal API.  The failed log is `interrupt-return-original-test.log`.

The corrected return test triggered an allocating-during-GC panic.  The traceback enters `raise-undefined-function` from `scavenge-full-save-thread`.  Its IRET-only branch calls `mezzano.supervisor::%object-slot-address`, which is undefined.  The runtime-package function is defined and used by the other branches.  The recommendation is to correct that package qualifier, reload that scanner as wired code, and repeat the return test before changing the nested-frame path.  Logs are `interrupt-return-original-run.log` and `interrupt-return-original-serial.log`.  The VM was restarted from the completed snapshot.  An explicit FBOUNDP check returned NIL for the supervisor symbol and T for the runtime symbol.

After the namespace correction, the return-entry case passed.  The IRET case then panicked while `scavenge-interrupt-stack-frame` recursively decoded NIL as a return address.  This matches the reviewed stack-pointer/frame-pointer mismatch.  The recommendation is to recurse with the original interrupt frame pointer after normalizing the saved state.  Logs are `interrupt-return-namespace-test.log` and `interrupt-return-namespace-serial.log`.  Both corrections will be tested together from the saved completed VM state.

With the namespace and recursion-pointer corrections, all four return cases passed: entry and IRET, each in full-save state and beneath an additional foothold.  The movable vector matched its relocated root after resumption.  The log is `interrupt-return-corrected-test.log`.  The test uses the existing single-step API to reach the production return instructions.  Compiler GC restart regions and ARM64 remain separate tests.

The final return test, all saved-data-register tests, and the interruption service tests passed together in `interrupt-return-final-test.log`.  Review caught and corrected two literal-newline escaping errors in the test catalog and shell command before commit.  A fresh build is running in `interrupt-return-build.log`.

## GC instruction restart decision: 2026-10-12

Allocation routines mark instruction ranges with `:restart T`, directing GC to rewind execution to the metadata entry offset.  The full-save scanner writes the instruction address through the raw register accessor.  The interrupt-stack scanner uses `memref-t`, which tags the address as a Lisp integer.  The recommendation is a raw unsigned-word write, tested with a Lisp-assembled restart region in both full-save state and beneath a foothold.  The fixture checks the saved instruction word before resumption, so a failure can remain suspended for inspection without executing an invalid address.  The existing register fixture gains an optional restart region.  This tests instruction rewriting and resumption without relying on allocation timing.

The restart test passed in full-save state and failed beneath a foothold.  The saved address was `#x1000347BF60`, exactly twice the expected `#x8001A3DFB0`.  The fixture remained suspended before executing that address.  The log is `gc-restart-original-test.log`.  The VM will restore its completed snapshot before loading the raw-word correction.  Review also narrows the fixture's restart region to its waiting loop, ending before it overwrites the object argument with its Boolean result.

The raw-address correction passed the full-save and nested restart-region cases.  The eight saved-data-register cases, four return-thunk cases, and retained interruption tests also passed in `gc-restart-corrected-test.log`.  This establishes the metadata-controlled instruction rewrite with a Lisp-assembled fixture.  Individual allocator instruction positions remain additional coverage.  The preceding return-scanner build completed, but a new full build will cover the final source including this correction.

## Binding mutation flow review: 2026-10-12

The next public binding-write prerequisite is compiler metadata for binding identity and the type declarations active at the selected instruction.  The lexical environment already keys type declarations by lexical-variable objects and merges nested constraints.  Backend debug records retain those variable objects until code generation, which currently writes names, locations, representations, and hidden flags.  Captured bindings use separate environment layouts.

Before extending that metadata, the recommendation is to test debugger writes across earlier type tests and previously computed values.  An undeclared binding may change type, and subsequent reads must observe that new value while earlier branch choices and computed values persist.  The current SSA pass excludes preserved bindings from SSA conversion, which should prevent reuse of earlier variable reads.  Tests will exercise fixnum-to-ratio mutation, a selected numeric type branch, an earlier identity test, and a vector-to-list change followed by generic sequence access.  These remain internal-writer tests in compiled x86-64 code at debug 3 and safety 3.  They do not add a public writer.

All four flow tests passed in `debug-write-flow-test.log`, together with the prerequisite binding-write tests.  The computed earlier value remained unchanged, and later reads observed the changed binding, including a different type.  These cases do not establish correctness for every optimization.  Binding identity, active declaration metadata, and the compiler audit remain prerequisites for the public writer.

The final GC source at Mezzano `5c7ee5bc` passed a fresh full compilation and CI boot.  QEMU exited with status 3 and the success marker appeared in the serial log.  Logs are `gc-restart-build.log`, `gc-restart-boot.log`, and `gc-restart-serial.log`.  The development VM saved the corrections with no unreleased jobs or active stops in `gc-restart-snapshot.log`.  The operations guide now pins this Mezzano revision and Slime `04d5ef6b`.

The operations guide selects Mezzano `6188206f` so a fresh checkout also contains the added binding-flow test.  The tested compiler/runtime source matches `5c7ee5bc`.

## Web UI research: 2026-10-12

The user requested a separate agent to research Symbolics displays and build a uv-runnable Python HTTP interface to the existing SWANK endpoint.  That work owns `tools/swank/web/`.  The [Web UI research and prototype](web/README.md) records the original manuals and visual choices, and the [component journal](web/devnotes.md) records the proposed session and request behavior.

The recommendation uses Python's standard library, browser-native HTML/CSS/JavaScript, loopback HTTP access through SSH, and retained guest jobs and stops.  A short-lived SWANK connection per HTTP request follows the existing Lisp client's connection lifetime.  A debugger submission acquires its lease and submits on that connection.  Later requests query the retained result.  The current session instruction requires confirmation before design decisions, so the architecture question is pending while research and the static prototype are complete.

The official uv installer installed uv 0.13.0 on minideb2 without changing shell profiles.  The temporary static server uses the existing Python 3.13.5.  HTTP delivery through an SSH forward returned status 200 and 5,341 bytes.  The browser tool reported no available browser, so rendered appearance and browser interactions remain untested.  The prototype contains labeled examples and implements no SWANK requests.

The user approved proceeding with a wildcard HTTP listener, specifying `*:PORT`, and required the original Symbolics Listener and Debugger fonts, colors, and layout.  The implementation will use port 8765 by default and keep the SWANK target on loopback port 4006.  The agent is implementing the approved Python HTTP service and researching the original font assets.  Browser access was requested for the rendered comparison.

## Binding identity source review: 2026-10-12

The [assembler](../../compiler/lap.lisp) indexes constants with an EQL hash table.  The [compiled-file serializer](../../system/file-compiler.lisp) uses an identity table and writes backlinks for shared vectors.  The [cold-image serializer](../cold-generator2/serialize.lisp) uses EQUAL for array deduplication, which preserves distinct general vectors.  These source findings support representing a static binding identity with a shared general vector.  They require tests through compilation, loading, closure creation, and GC before becoming a debugger guarantee.

The current AST copier creates a fresh lexical-variable object and copies its debugger-preservation flag.  Closure layout metadata is produced before the final simplification passes.  A descriptor added there must remain associated with the correct variable through those passes.  Runtime activation identity remains separate from static binding identity.  No new metadata or public binding-write API was implemented in this review.

## Web UI browser testing: 2026-10-12

The user authorized headless Chromium.  The workstation provides Chromium 145.0.7632.109 and Node 24.13.0.  The test driver uses Node's built-in WebSocket implementation and the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) with a fresh browser profile.  It adds no npm dependencies.  The Python server and guest continue to run on minideb2.

The first browser interaction test passed evaluation, output, multiple values, reload of a retained result, condition and stack inspection, locals 111 and 222, CONTINUE, returned value 333, and release of its jobs, stop, and session.  Screenshots were inspected against the original Genera Workbook figures and original Listener and Display Debugger captures.  The first rendering exposed a favicon 404, corrected by the server's explicit 204 response.  The successful run produced no browser console errors.  This run used a fallback monospace font and does not establish visual fidelity.

The recovered CPTFONT bitmap OTB failed Chromium's FontFace load with “Invalid font data in ArrayBuffer.”  The recommendation remains conversion of the original glyphs with fontTools as a build-only dependency.  Dependency approval is pending.  The regular font's recorded advance and line height are 8 and 12 pixels.  Browser glyph comparison remains required after conversion.

The recommendation for continued access is a systemd service running the same uv command as user somebody, listening on 0.0.0.0:8765 and talking to SWANK on 127.0.0.1:4006.  The checked-in service records the minideb2 paths and allowed hostnames.  This transfers the HTTP process from an interactive SSH session to systemd without changing either VM.

The revised classic Listener debugger and the final Chromium run passed evaluation, reload, interactive input, condition/stack/locals, CONTINUE returning 333, and cleanup.  Controlled discarded fetch responses tested original-name evaluation replay, job-release reconciliation, expired-session reconciliation, and explicit new-session recovery.  Two expected HTTP 409 responses represented the released job and expired session.  There were no unexpected browser errors.  Screenshots cover the Listener, System Menu, Debugger, request history, and a 640-pixel viewport.  Three earlier driver-readiness failures and their exact fixture cleanup are recorded in the component journal.

The final Python suite passed nine isolated tests and the live HTTP-to-SWANK tests, including child-printer recovery and released-reference checks.  The live log is /tmp/web-final-live.log on minideb2.  Browser evidence is retained in the MBuild directory under web-browser-evidence.  The systemd unit passed systemd-analyze verify and is running.  Font measurement confirms the remaining mismatch: Hello occupies 36.123046875 pixels with fallback rendering, compared with CPTFONT's expected 40 pixels.  This increment is ready for review and publication as a working HTTP client.  Exact Symbolics typography and visual matching remain unfinished.
