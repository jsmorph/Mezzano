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

Mezzano 71f051fb contains the reviewed Web UI increment and is pushed to fork/debugging.  The operations guide now selects it so a fresh checkout includes the HTTP server and browser test.  The guest compiler and runtime sources remain unchanged by this increment.

The [original-font identification report](web/font-research/README.md) records 21 exact ink-mask comparisons against original Symbolics captures, including distinct menu, label, help, and herald fonts.  It preserves source hashes and a reproduction script.  These comparisons establish the selected source glyphs, while font conversion and Chromium raster validation remain unfinished.

## Lisp Command Processor: 2026-10-12

The user approved nine authentic Listener commands, command-preferred input, completion, argument prompts, defaults, contextual help, pathname reuse, and authentic debugger names.  The implementation follows the [Genera User's Guide](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Genera-Users-Guide.pdf), sections Communicating with Genera and Entering Commands, and the [Genera Workbook](https://bitsavers.trailing-edge.com/pdf/symbolics/software/genera_8/Genera_Workbook.pdf), printed pages 15–18 and 109–110.  Command-preferred input recognizes alphabetic or colon-prefixed commands, permits Lisp forms, and uses a leading comma to force Lisp reading.  SPACE completes a component, COMPLETE completes a name, and HELP supplies context.  The browser maps COMPLETE to Tab and HELP to F12 or Control-?.

The recommendation is a guest Lisp command processor with one Listener state per retained SWANK session.  Lisp owns command definitions, parsing, argument validation, completion, help, package and pathname defaults, execution, and pathname presentation metadata.  Listener submissions use the existing retained evaluation worker, output, debugger, interruption, and replay mechanisms.  One active Listener submission per session orders package and pathname changes.  Ordinary evaluation jobs remain available independently.  Completed Listener jobs expose structured effects and character-offset presentations.  Python translates typed HTTP arguments to SWANK and does not parse commands.  Clear Output History changes the browser transcript and preserves input history and retained jobs.

The first command set is Help, Set Package, Show Herald, Show Command Processor Status, Clear Output History, Show Directory, Show File, Load File, and Compile File.  File operations use guest Common Lisp pathnames and filesystem functions.  Supported keyword subsets will be documented and unsupported keywords rejected.  Existing job creation replay must continue to identify the original execution after Set Package changes the current package.  Tests must cover this case, busy Listener rejection, two independent Listeners, Lisp/command disambiguation, completion ambiguity, invalid arguments without execution, file loading and compilation, pathname reuse, output clearing, and Chromium reload and lost-reply recovery.

Review of [Program Development Utilities](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Program-Development-Utilities.pdf), printed pages 210–214 and 225, corrected the earlier Show Stack recommendation.  Show Backtrace lists call frames.  Show Stack displays current-frame stack slots including temporaries, which the retained API does not expose.  The browser will use Show Backtrace and Show Proceed Options.  Show Frame and Show Local will report only the frame and binding data available from the retained API.  Original argument values and raw stack slots remain unavailable.

The first source load rejected an unbalanced assistance definition before loading it.  After correcting that form, compilation and loading succeeded.  The first transport test expected the nickname CL-USER instead of the canonical COMMON-LISP-USER returned by PACKAGE-NAME.  Its assertion was corrected.  A subsequent test found that Help :F followed by SPACE did not return the expanded keyword spelling.  Review then found that completion of a second keyword discarded later fields.  The revised argument scan preserves preceding arguments and keywords.  Tests cover both failures and duplicate keyword rejection.  Two empty failed-test sessions were identified and released.

Further manual comparison corrected Help :Format's mentioned default to Brief (Workbook printed page 18) and restricted keyword help to unused keywords (User's Guide, Help in the Command Processor).  The Lisp transport suite passed all nine commands, invalid-input checks, package/command disambiguation, defaults and completion, guest file operations, pathname presentation offsets/insertion, busy rejection, two independent Listeners, interactive input, same-name replay, an unread creation reply, reconnection, and replay after a package change.  The final log is listener-test-final.log.  The existing nine Python tests and live HTTP suite passed in /tmp/web-listener-live-1.log.

Clear Output History retains the pre-submission set of displayed job names with its original request.  The browser applies the returned effect once for the owned accepted job.  Input history and retained guest jobs survive.  A replay cannot clear output accepted after that original command.  A fresh full image build and CI boot are in progress in listener-build.log and listener-boot.log.  No full-build completion claim is made at this point.

## Document Examiner research and proposal: 2026-10-12

The user requested a Symbolics Document Examiner covering all project work.  The [Genera User's Guide](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Genera-Users-Guide.pdf), Document Examiner chapter, printed pages 2908–2912 in that edition, specifies four panes: Viewer on the left, Current Candidates above Bookmarks on the right, and Commands below.  Topic viewing appends text with separators and adds a bookmark.  Search and tables of contents create candidate lists with a recall history.  Viewed bookmarks have a white background.  Deferred bookmarks follow on gray.  Named viewers have independent contents and bookmarks.

The recommendation submitted for approval keeps the checked-in project documentation as its source, with guest Lisp constructing named topics, cross-references, and search results.  The browser renders topics and retains viewers, bookmarks, and candidate history.  The catalog must include architecture and capability status, compiler/GC guarantees, Lisp and Web Listener use, Command Processor commands, retained debugger and evaluation APIs, SWANK and HTTP protocols, connection/replay/restore behavior, build and VM operations, test scope and evidence, font research, journals, and the remaining debugger/headless/QEMU agenda.  Approval is pending under the current instruction to ask before design decisions.  No Document Examiner implementation has started.

Review found that adding :command and :error to a local property-list variable left the job holding the earlier list head.  The initial result now contains both fields, and tests assert command identity and input-error metadata through SWANK.  The final Lisp suite passed in listener-test-final.log, and all nine isolated Python tests passed in /tmp/web-listener-unit-final.log.

The first fresh image compiled successfully.  Its CI guest then waited for file-server access while browser tests used the development guest.  Source and socket inspection established that the host file server processes one connection until its 60-second idle timeout.  Repeated SWANK connections probe .slime-secret, keeping the development guest connection active and leaving the CI connection queued.  The owned CI process was stopped.  Final build/boot testing will run after browser tests without concurrent guest file traffic.  Concurrent file-server clients require a separate implementation decision.

## Listener publication review: 2026-10-12

The directory command pushes pathname presentations in reverse output order.  The browser renderer requires increasing character offsets.  The recommendation is to retain the efficient prepend in the worker and reverse the copied presentation list in job information.  Metadata writes will use the existing service mutex, as metadata reads already do.  A directory test will include both the source and compiled file and check every presentation's order and text.

The browser marks display effects as applied when it first sees Listener metadata, including while a job is still running with an empty effects list.  The recommendation is to apply and record effects only after the job reaches a terminal state.  A focused browser test will distinguish the running and returned replies.

The reviewed Lisp transport suite passed, including a directory containing both the source and compiled file, in listener-review-test.log.  The final expanded Chromium run passed the terminal-effect case, explicit HELP candidates, two Unicode pathname presentations, all nine commands, replay, debugger inspection, and owned-fixture cleanup.  Its evidence is web-browser-evidence/lispm-listener-final2 and the adjacent log.  The earlier browser failures and corrections are recorded in the Web journal.

The user approved the Document Examiner proposal.  Implementation will use checked-in documents as the source, Lisp topics/search/command parsing, and browser viewer state.  The original User's Guide, printed pages 2913–2924, specifies title and keyword searching, multiword AND and adjacent searches, overview metadata and hierarchy, topic-sensitive mouse operations, per-viewer candidate history, and private documents containing bookmark references.  These behaviors will guide implementation and tests.

## Document Examiner implementation sequence: 2026-10-12

The approved design uses a checked-in catalog of project documents.  Each document and Markdown heading becomes a stable topic ID based on its source path and heading.  Guest Lisp reads paragraphs, lists, tables, fenced code, and inline references, then returns structured records.  Search compares title and keyword words.  Source errors remain visible.  The first search increment supports explicit exact, initial, and substring modes, with unordered AND or adjacent terms.  The original manuals describe suffix stemming but do not specify its algorithm.  Original stemming compatibility remains unimplemented.

Named viewers, bookmarks, and candidate histories use the browser's existing sessionStorage.  Stored topic references survive guest-session replacement.  The browser fetches topic bodies from Lisp when restoring its viewer.  This keeps a single documentation corpus.  Hardcopy Viewer prints the rendered viewer through the browser's print dialog.  Browser tests will share the existing dependency-free Chromium/CDP harness.

The coverage catalog includes a project guide, the Examiner guide, debugger design and status, remote evaluation, the Command Processor, the Web UI, the SWANK protocol, minideb2 operations, original-font research, both journals, and Mezzano's existing user and implementation documents.  Tests will compare the catalog with this manifest, resolve cross-references, check hierarchy and search behavior, then exercise commands, bookmarks, viewers, candidate recall, and reload in Chromium.

- [x] Build and test the Lisp topic catalog, reader, lookup, search, and command assistance.
- [x] Expose the typed documentation operations through SWANK and HTTP.
- [x] Implement and test the four-pane browser activity against the original captures.  Typography and measured layout remain in the font increment.
- [x] Document supported behavior, source coverage, test evidence, and remaining differences.

The Listener increment 3d042859 passed a fresh full recompilation and CI boot.  QEMU exited with status 3 and the serial success marker.  Logs are listener-reviewed-build.log, listener-reviewed-boot.log, and listener-reviewed-serial.log.  Continuing browser polling required stopping the HTTP service during the single-client file-server boot test.  The service restarted after the test.  Both existing VMs remained running.  The development guest saved its tested Listener state in listener-reviewed-snapshot.log.

The first Document Examiner compile rejected an extra closing parenthesis in command assistance.  After correction, the module compiled and loaded 25 source documents.  The Lisp transport test passed with 294 topics and 153 references, including all book content, hierarchy, cross-references, formatting records, three search modes, adjacency, ambiguous/missing topics, command assistance, Unicode cursor offsets, and session release.  Logs are examiner-load-1.log, examiner-load-2.log, examiner-load-3.log, and examiner-test-1.log.  Nine isolated Python tests passed with the added documentation request validation in /tmp/examiner-http-unit-1.log.  Browser tests are running.

The user approved fontTools as a build-only dependency.  The font increment will preserve source provenance and conversion instructions and compare Chromium glyph pixels and metrics with the recovered Symbolics fonts.

The first Examiner browser run reached reload after passing topic lookup, mouse operations, overviews, bookmarks, tables of contents, search, viewer selection, and discard.  Its driver checked the connection variable before app.js loaded.  A readiness guard corrected the driver.  The owned session was released, and no test jobs were created.  The second run passed with zero browser errors.  Review then found that the browser selected Exact when the Lisp command omitted a search mode.  Lisp's catalog now supplies supported modes and the default Substring.  A search-options menu will use those records and preserve the selected mode and adjacency with candidate history.

Bookmark review found that viewing a deferred bookmark retained its bookmark-insertion position, which could precede topics read earlier.  The corrected transition must append a newly viewed bookmark to the viewed order while preserving the position of a previously read bookmark.  A browser test will check deferred A, read B, then read A.  Internal links will also carry their canonical topic titles so bookmarks use topic names rather than link-label aliases.

The revised transport suite passed with 25 documents, 295 topics, and 158 references in examiner-test-2.log, including the Lisp search-options metadata and canonical link titles.  A separate audit found no unresolved anchors targeting registered documents in examiner-link-audit.log.  The full image build is running in examiner-build.log.

The final Examiner browser test passed all functional assertions, including search options, first-view bookmark order, candidate recall, Unicode viewer names, and exact 100-pixel reading-position restoration.  No browser errors occurred, and the owned session was released.  The full Listener suite also passed after extraction of the shared Chromium harness.  The Web journal records the browser failures and corrections.  The fresh full image build passed in examiner-build.log.  CI boot is running.

## Private-document proposal: 2026-10-12

The original User's Guide, printed pages 2923–2924, defines a private document as a saved bookmark list.  Read displays the referenced topics.  Load inserts bookmarks without displaying the text.  The recommendation submitted for approval stores an ordered list of topic IDs in a guest Lisp data file, with a documented Mezzano format and reader evaluation disabled.  Save will use the existing retained evaluation job identity and replay rules.  Read and Load will use guest Lisp file access and return validated topic records.  Approval is pending.  No private-document implementation has started.

The user approved the private-document design.  Save will accept a client name, pathname, and ordered topic IDs through a typed SWANK operation.  Lisp constructs a quoted call to the private-document writer and submits it to the existing evaluation service.  This preserves the service's acceptance, errors, results, and replay semantics without another worker mechanism.  The file contains a versioned Lisp data record and is read with reader evaluation disabled.  Tests must check order, Unicode physical pathnames, malformed/reader-evaluation input, unread save replies, identical job replay, conflicting content, Read versus Load behavior, and owned-file cleanup.

## Concurrent debugger and Examiner work: 2026-10-12

The Web UI agent owns frontend behavior, font conversion, visual comparison, and Chromium tests.  A second agent owns the approved private-document reader/writer, retained Save operations, HTTP integration, and their tests.  The primary agent resumes compiler/debugger work.  Shared VM builds, restart, and snapshot tests require coordination because the host file server serves one connection at a time.

The private-document reader must reject circular data before traversing it.  The recommendation uses Common Lisp LIST-LENGTH to check the record and topic list, with reader evaluation disabled.  A circular list returns NIL, and a dotted list signals a type error.  Both failures remain visible to the caller.  This refines the approved data validation without introducing another parser.  Tests will cover circular records and topic lists, malformed records, trailing input, and reader evaluation.

The Examiner image passed CI boot with QEMU exit status 3 and the serial success marker.  Logs are examiner-build.log, examiner-boot.log, and examiner-serial.log.  The development VM saved that state in examiner-snapshot.log.  These results precede the private-document changes.

The private-document default-path test failed before file writes.  Merging an empty logical namestring with SYS:HOME;PRIVATE.PSB produces SYS:PRIVATE.PSB because the empty namestring supplies an absolute directory.  The correction uses the declared default pathname for an empty command argument and applies MERGE-PATHNAMES to nonempty arguments.  The tests compare canonical pathnames, including the logical version.  Nine Python tests and the catalog test with 26 books and 14 commands passed.  Private-file tests remain in progress.

## Compiler binding identity proposal: 2026-10-12

The recommendation is one shared general-vector descriptor per compiled lexical binding.  Local-location and closure-layout metadata would reference that descriptor, so equal names remain distinguishable and a defining frame can identify the same static binding as its closure.  A stop and frame still identify a particular activation.  Independently compiled functions and distinct shadowed bindings require distinct descriptors.

The existing constant-pool and file serializers can preserve general-vector identity.  The existing debug bytecode can reference either a legacy name or the descriptor through its constant-pool index, avoiding another bytecode field.  Runtime decoding must preserve legacy metadata and preserve name-based display APIs.  Type constraints, lexical scope, activation-safe mutation, and lexical evaluation remain subsequent increments.

Approval is pending under the current instruction to ask before design decisions.  Review is checking AST copy/lowering order and every metadata consumer.  Tests must cover shadowing, shared captured bindings, independent compilation, compile-file/load, GC, and existing local inspection.  No descriptor implementation has been made.

## Interrupt-return instruction coverage: 2026-10-12

The existing GC test covers return-thunk entry and IRET.  The next test increment uses the existing single-step controls to survey every instruction address visited from entry through IRET, then repeats full GC and normal resumption at each address in full-save state and beneath an additional foothold.  Repeated REP iterations contribute one instruction address.  This extends the already approved interrupt-scanner tests and preserves the production return code.  The fixture checks relocation of its vector and the resumed function result.  The development guest will be saved and other guest testing paused before this run.

All 23 observed interrupt-return instruction addresses passed in both saved states, totaling 46 full-GC and resumption cases.  The saved-data-register suite also passed for R8, R9, R10, R11, R12, R13, R15, and RBX.  Logs are interrupt-positions-snapshot.log and interrupt-positions-test-1.log.  The HTTP service resumed after testing, and the VM required no restart.  This test-only increment changes no runtime or compiler source, so it requires no image rebuild.  Repeated REP iterations at the same address and individual allocation-routine positions remain further tests.

## Production cons allocation coverage: 2026-10-12

The GC restart test currently uses a Lisp-assembled fixture.  The next bounded test follows the production x86-64 DO-CONS success path instruction by instruction.  A Lisp-assembled caller holds two movable vectors in the normal argument registers and transfers to CONS after a controlled wait.  The existing thread-step API identifies the instruction addresses visited inside DO-CONS.  Tests will collect at each address in full-save state and beneath an additional foothold, check the saved restart address when its metadata requires rewinding, and verify that the completed cons contains both relocated arguments.  This exercises allocation before and after the cons pointer becomes valid.  General-object allocators and structure copying remain separate cases.

## Private-document backend test results: 2026-10-12

The writer and retained-job source generator use WITH-STANDARD-IO-SYNTAX so ambient printer settings cannot alter the file format or replay identity.  The changed-PRINT-CASE replay test passed.  The second test attempt first failed in its raw SWANK fixture because LET lacked the CL package qualifier.  The fixture now qualifies LET and *PRINT-CASE*.  The third attempt exposed the reader's KEYWORD package binding: a written empty list, NIL, was read as :NIL.  Reading now uses standard I/O syntax with *READ-EVAL* NIL.  Non-string topic elements receive a fixed error message so malformed circular elements cannot cause unbounded condition printing.  Cleanup ran after the failed tests.

The fourth private-document test passed ordered and duplicate topic references, empty references, command defaults, a Unicode physical pathname, malformed/dotted/circular/trailing/reader-evaluation rejection, preservation of the prior file after an invalid save, unread creation-reply recovery, identical replay without rewriting, changed printer settings, changed-reference conflict, and owned file/job/symbol/session cleanup.  To detect an unintended second write, the test replaced the file between the original request and its replay.  Logs are examiner-private-load-5.log and examiner-private-test-4.log.  Catalog tests passed 26 books, 303 topics, 168 references, and 14 commands in examiner-test-3.log.  Nine isolated Python tests passed in examiner-private-http-unit-1.log.  Private browser commands and a full image build remain to be tested.

Private Save replay must remain valid after a catalog reload removes a referenced topic.  Review found that the submission helper resolved topic IDs before the retained-job lookup.  The correction generates the retained source from the original ordered strings and resolves topics in the writer, which already validates before opening the file.  List and string shape checks still precede serialization.  This preserves the approved request identity across catalog changes without a second request registry.  A test temporarily removes a referenced topic after saving, checks replay, and restores the catalog in UNWIND-PROTECT.

## Instruction-test review and results: 2026-10-12

Review identified two ways to overstate allocator coverage.  CONS can recover from a failed DO-CONS call, so instruction discovery now checks that DO-CONS returned one value through its success path.  An intervening GC during metadata or foothold preparation can move the saved instruction back to the restart boundary.  The tests now record the GC epoch at the selected instruction, verify the saved address and unchanged epoch immediately before collection, and require one completed collection.  The interrupt-return test received the same guards.  The allocation fixture preserves a failed worker for inspection and rejects a new run while that reference remains.

The production cons test passed all 17 observed success-path instruction addresses in both saved states: 34 full-GC and resumption cases.  Both vector arguments moved, the saved address matched the required restart or continuation address, and the completed cons contained the relocated arguments.  The strengthened interrupt-return test passed all 23 observed instruction addresses in both saved states: 46 cases.  Logs are cons-positions-snapshot.log, cons-positions-test-1.log, and interrupt-positions-test-2.log.  The HTTP service resumed, and no VM restart was required.  General-object allocation, structure copying, other REP iteration states, and ARM64 remain further test coverage.

The private Save test passed again after deferring catalog lookup, including replay while the request thread binds an empty catalog.  Logs are examiner-private-load-6.log and examiner-private-test-5.log.  Slime e07dbeda and Mezzano 5291512c publish the backend and protocol changes.  The browser commands remain pending.

The full image build failed while serializing PRIVATE-PATHNAME.  Its pathname literal was an SBCL host pathname without a target MAKE-LOAD-FORM method.  Guest compilation had accepted the guest pathname and therefore did not expose this cross-compilation failure.  The correction constructs the guest default with PATHNAME from its namestring at runtime, following the existing Command Processor.  The private suite and a fresh full build must pass with this correction.  The failed log remains examiner-private-build.log.

## Binding descriptor allocation review: 2026-10-12

The binding identity proposal must distinguish a source binding from each compiled occurrence.  Copying a descriptor through every AST copy would conflate occurrences introduced by optimizer duplication.  The current inliner reparses source at each call site, while constant propagation copies lambda ASTs.  Both create distinct lexical-variable objects for newly introduced bindings and retain references to external bindings.

The refined recommendation creates descriptors through a fresh EQ table around each outer CODEGEN-LAMBDA call.  The table keys lexical-variable objects and remains bound during recursive compilation of nested backend functions.  Closure layouts retain those variable objects until emission.  Both native backends obtain local and captured descriptors through the same table.  This shares a binding with its closures while separating shadowed bindings, inline occurrences, and repeated code generation from the same lowered AST.  The descriptors remain immutable general vectors in emitted metadata.  No descriptor state needs to be stored on the AST.

Source evidence is compiler/compiler.lisp CODEGEN-LAMBDA and COMPILE-LAMBDA-2, compiler/inline.lisp INLINE-FORM, compiler/constprop.lisp COPY-FORM calls, compiler/ast.lisp COPY-VARIABLE, compiler/backend/convert-ast.lisp nested function constants, and both backends' recursive constant compilation.  Ordinary compilation does not copy closure-lowered ASTs.  The current generic copier drops their environment layouts, so support for that operation requires separate work.  Tests for the proposed increment must retain closures from two inline sites at once, inspect copied local lambdas, compare defining-frame and closure identities, and generate code twice from one lowered AST.  Approval remains pending, and no compiler implementation has changed.

The operations guide now selects Mezzano 49a4e93c and Slime 2a15e2b9.  These revisions contain the built and boot-tested Examiner code and the added core GC tests.  Private-document changes will receive a later recorded revision after their full build and boot pass.

## Private-document build correction: 2026-10-12

The guest now constructs the default private pathname from its namestring at runtime.  The private-document suite passed again, including empty and ordered references, Unicode pathnames, malformed input, unread replies, replay without rewriting or catalog lookup, changed printer case, conflicts, and owned-fixture cleanup.  Evidence is examiner-private-load-7.log and examiner-private-test-6.log.  The fresh full image build passed in examiner-private-build-2.log.  CI boot remains in progress.

The private-document CI boot passed with QEMU exit status 3 and the serial success marker.  Logs are examiner-private-build-2.log, examiner-private-boot.log, examiner-private-serial.log, and examiner-private-qemu.exit.  The Web service resumed after CI, and the development VM stayed running.  Mezzano 6924319b contains the runtime-pathname correction.  Font commit 71c601cf adds the catalog's conversion document and browser assets.  The operations guide now selects 71c601cf and Slime e07dbeda, lists the Listener and Examiner transport tests, and records the shared file server's required CI pause.

After the documentation updates, catalog refresh and transport test passed with 26 documents, 313 topics, and 172 references in examiner-final-catalog.log and examiner-test-4.log.  No retained stops remained.  Two completed jobs already present in the earlier Examiner evidence were preserved.  All private and browser test fixtures had been released.  The development guest saved its loaded backend and catalog in examiner-private-snapshot.log.  No restore test was performed for private documents in this increment.

## Private-document browser completion: 2026-10-12

Frontend 64788cd6 passed the focused Chromium test for Save, Read, Load, and Hardcopy Private Document.  The test covered displayed bookmark order, the pathname default and command menus, a discarded accepted Save reply followed by reload and replay of the original job token and typed command, deferred Load without text, Read, Hardcopy dispatch with unique sections and unchanged viewer state, and exact owned file/job/session cleanup.  The browser reported no errors.  Physical printer output remains untested.  The first run failed a driver assertion that omitted the displayed Command: prefix.  That assertion was corrected and its fixtures were removed before the passing run.  Evidence is web-browser-evidence/lispm-private-second and web-browser-evidence/lispm-private-second.log.

The guide and SWANK reference now describe the tested browser commands.  The operations guide selects Mezzano 64788cd6 and Slime e352c295.  The earlier guide cited printed pages 2906–2924 for the Document Examiner chapter.  The supplied User's Guide text places the private-command descriptions on Page 688 and private-document creation around Pages 699–700.  The guide now cites the named Document Examiner and Creating a Private Document sections.

The final catalog refresh and transport test passed with 26 documents, 314 topics, and 172 references after the private UI documentation changes.  No retained stops remained.  Evidence is examiner-private-ui-catalog.log and examiner-test-5.log.  The development guest saved the refreshed catalog in examiner-private-ui-snapshot.log after browser fixture cleanup.

## Final Examiner source selection: 2026-10-12

The operations guide selects Mezzano f52e4b0b and Slime e352c295.  The Mezzano revision includes the private-document browser commands, their documentation, and the tested title-clipping correction.  The title's 320 by 24 rectangle matches both original reference captures pixel for pixel.  Paragraph justification and complete-window fidelity remain unfinished.  The font report records the measured result and distinguishes it from the inferred historical clipping behavior.

The final catalog refresh and development snapshot will include these published documents after browser test sessions have closed.  This source-selection and CSS increment changes no guest implementation and requires no image rebuild.

## Product documentation cleanup: 2026-10-12

The user requests general-purpose product documentation.  The current Examiner catalog includes deployment records, research reports, journals, and unfinished internal notes.  The editorial recommendation is a task-based product catalog: installation, desktop and Web operation, commands, debugger and evaluation APIs, documentation, networking, and language extensions.  Developer test instructions move to separate testing documents.  Research, licensing, historical evidence, and implementation notes remain in the repository, outside the product catalog.  Font license and provenance files remain unchanged.

The installation guide will use configurable paths and ports and a host-independent image-building script.  Product references will retain operation semantics, lifecycle rules, supported compiler policies, and known limits while removing approval history, development chronology, and test-run counts.  Existing debugger topic IDs for Compiler guarantees and Retained evaluation remain stable.  Source review found that the old manual incorrectly says DHCP is unsupported.  The current network initialization selects DHCP for every interface by default.

Required tests are document and link review, catalog loading and reference resolution, command/topic lookup, and browser navigation after refreshing the live catalog.  Installation examples will be checked against the build and startup sources.  This editorial increment will not claim a new installation test or hardware coverage.

The product catalog now contains 13 books.  The main README links task-based manuals and retains upstream release history in a separate document.  Portable installation instructions replace the host-specific operations guide, and the unchanged image-building recipe moves to tools/build-image.lisp.  The old deployment directory retains its deployment scripts and a pointer to the portable guide.  Product references preserve supported operations and limits.  Developer workflows remain in separate TESTING documents, and source/font attribution remains in the repository.

Source review corrected the old DHCP claim, the paging-light color, omitted Dvorak keymaps, the Left Alt requirement for the emergency shortcut, separate allocated/committed memory traces, and an unbound-variable command example.  The atomic reference removes unsupported lexical places from its supported list, fixes the double-CAS signature, supplies existing update macro behavior, and separates the unspecified portable memory-order model from proposed ordering arguments.  Structure reference wording and the DCAS cross-reference were corrected.

The guest compiled and loaded the catalog module and loaded all 13 product books.  The transport test passed 104 topics and 76 references, hierarchy, search modes, command assistance, ambiguous titles, Unicode cursor offsets, and session cleanup in product-docs-catalog.log and product-docs-test.log.  Static review passed 11 product shell blocks and 72 repository links.  Independent review checked installation commands against the builder, file server, network startup, and snapshot sources.  No new installation or hardware test is claimed.  Browser navigation and the final refreshed catalog snapshot remain to be performed after the last editorial corrections.

## Peek, activity selection, and product navigation: 2026-10-12

The approved increment adds a read-only Processes query in Lisp, Show Processes, and SELECT navigation.  The scheduler sampler copies five values under the existing interrupt and lock discipline.  Bounded display labels avoid arbitrary printers for thread names and wait descriptions.  The browser uses existing retained stop tokens and creates no thread registry.  The product catalog now includes the Peek guide as its fourteenth book.  The [Peek development note](peek-devnotes.md) records the implementation and guest tests.  The [Web journal](web/devnotes.md) records the Symbolics references and browser measurements.

The guest and SWANK tests passed duplicate names, nested stop associations, event and mutex waits, stale wait suppression, circular and hostile names, runtime growth, thread creation and exit, token reuse, and Show Processes assistance and output.  Chromium passed live process sampling through HTTP and SWANK, Describe, exact stop selection, continuation, and owned-object cleanup.  It also passed SELECT navigation and product-guide links.  Separate browser fixtures passed stale-result retention, reconnection, hidden-view polling suppression, and text rendering.  The fixture and live runs reported no browser errors.  Evidence is peek-live-first, peek-fixtures-second, and peek-navigation-first in the browser evidence directories.  Selected font and position comparisons passed four reference rectangles.  Complete-window identity has not been established.

The product documentation checks passed 14 books, 11 shell blocks, and 78 repository links.  Live catalog tests passed 110 topics and 83 references.  Product documentation excludes research reports, deployment records, and development journals.  A fresh image build and CI boot remain in progress.

## Backing-store reservation failure: 2026-10-12

During compilation of the bounded label formatter, the development guest panicked with Insufficient space for garbage collection.  The subsequent sampler query timed out because the world was stopped.  The serial log establishes that compilation entered GC before the sampler query.  The first targeted sampler hotload had omitted the required wired loading mode.  The corrected loader uses LOAD with :WIRED T, and the restarted guest passed its sampler tests with that correction.

The panic log and pre-test disk image were preserved before restarting the development VM from its saved image.  The VM retained its two-GiB memory and five-GiB disk settings.  Three full collections completed after recovery.  The last pair retained 928280 free blocks, 109051904 dynamic bytes, and 159383552 static bytes, while the reservation counter rose from 378569 to 378598.  That lost 118784 bytes of reported capacity.  The earlier two attempted measurement expressions failed during reading because of incorrect GC package names and ran no collections.  The successful measurement used MEZZANO.EXTENSIONS:GC.  Evidence is peek-gc-accounting-samples.log and peek-gc-panic-serial.log.

Source review found two missing reservation decrements: release of a committed eager wired/card page, and realization of a lazy page during dirty swap-out.  A host Lisp harness executing the production page-transition forms reproduced both one-block leaks.  Four control transitions passed.  Snapshot copying requires the eager reservation, so removing its allocation-time increment would change the accounting incorrectly.  The recommendation is to correct the two transitions, test their inverses and controls, then repeat guest collection and snapshot tests.  Kernel correction approval is pending.  These defects have not been established as the sole cause of the observed panic.  Pinned and function-area growth can also consume GC reserves and remain separate review findings.

## Removed Document Examiner topics: 2026-10-12

Catalog cleanup can leave saved viewers referencing removed development topics.  The initial browser probe found that the generic missing-topic error entered SWANK's debugger and marked the Web connection disconnected.  The user approved a typed missing-topic response and a visible unavailable-topic entry that preserves bookmarks and displays the remaining valid topics.  The backend uses the existing debugger-service error protocol.  Its tests passed missing topic, contents, and overview requests followed by a successful query in the same session, with no retained jobs or stops added.  [The correction note](examiner-missing-topic-devnotes.md) records the backend evidence.  The browser correction remains under test.

## Approved pager accounting correction: 2026-10-12

The user approved correction of the two identified reservation transitions.  A committed real wired page retains a reservation for snapshot copying.  Release must remove that reservation when lazy allocation is enabled.  Dirty swap-out must consume a lazy page's reservation after allocating its real disk block.  Existing release paths already remove lazy and uncommitted reservations.  The implementation adds these two decrements without changing allocation-time reservations.

The isolated host test reads the production constants and six pager functions into a one-page fixture.  Before the correction, eager release and lazy realization each left one reservation behind.  Six controls passed: early eager allocation, lazy release, read-only allocation, failed realization, and release or replacement of a snapshot-owned page.  All eight cases pass after the correction.  Evidence is pager-accounting-before.log and pager-accounting-after.log.  The checked-in test is tools/swank/test-pager-accounting.lisp.  Its physical-memory, locking, page-table, and disk stubs restrict these results to local accounting transitions.

Independent review confirms the two corrections and identifies a separate wired-stack snapshot case: snapshot copying skips these stacks, while block-map saving uncommits their entries and adds a reservation.  The two-transition correction does not resolve that lifecycle.  No claim of complete snapshot accounting balance follows from the isolated tests.  Repeated guest collection, a fresh build and boot, and snapshot restoration remain required for this increment.

The two corrected functions compiled and loaded with :WIRED T.  Five full guest collections completed.  The final two samples were identical: 928280 free blocks, reservation count 388928, dynamic size 109051904 bytes, static size 159383552 bytes, and remaining capacity 2090389504 bytes.  An earlier sample pair with the same dynamic size also had reservation count 388928.  The observed per-collection reservation growth is absent in these samples.  Evidence is pager-accounting-load.log and pager-accounting-gc-after.log.  The counters accumulated before the correction were preserved.  Fresh kernel build, boot, and snapshot restoration remain in progress.

## Final Peek, Examiner, and pager tests: 2026-10-12

The missing-topic browser correction passed mixed valid and unavailable roots and headings, bookmark preservation across reload, and separate transport-error handling.  Screenshot review then exposed printer labels in a code block.  The guest's FORMAT path inserted labels for repeated string objects while *PRINT-CIRCLE* was true.  JOIN now writes literal strings.  Shared-string tests, the Examiner suite, and an exact browser comparison of the three Getting started command lines passed.  The [Examiner correction note](examiner-missing-topic-devnotes.md) records the reproduction and tests.

Live Peek screenshot review found that a long process name pushed the runtime column outside the 980-pixel display.  Fixed column widths now preserve all five fields.  Name and Wait clip within their columns, and Describe displays their complete sampled strings.  A 160-character worker name passed field containment, Describe, exact retained-stop navigation, Show Processes, continuation, and owned-object cleanup.  Fixture tests also passed the longest scheduler-state label and narrow-window scrolling.  Five selected text rectangles match the original raster and position.  Complete-window fidelity remains unfinished.  The [Web journal](web/devnotes.md) records the source comparisons, driver correction, and evidence.

The development guest saved the corrected pager, Processes service, and 14-book product catalog.  Snapshot completion appears in peek-pager-snapshot.log and peek-pager-before-restore-serial.log.  After restarting the VM from that snapshot, five full collections completed.  The last four samples were identical: 926484 free blocks, reservation count 381327, dynamic size 104857600 bytes, static size 159383552 bytes, and remaining capacity 2118369280 bytes.  Evidence is pager-accounting-restore.log.  The Processes and Examiner transport tests passed after restoration, including 110 topics and 83 references, and released their owned fixtures and sessions.  Their logs are peek-processes-restored-test.log and peek-examiner-restored-test.log.

A fresh image build incorporating the pager correction passed in peek-pager-build.log.  Its separate x86-64 QEMU boot used two virtual CPUs, two GiB of memory, and the five-GiB image.  QEMU exited with status 3 and printed CI build completed successfully.  Evidence is peek-pager-ci-serial.log and peek-pager-ci.exit.  The HTTP service resumed.  The final headless Chromium navigation check passed SELECT, input preservation, Peek Quit, and product-guide navigation through Installation and Debugger.  It created no guest jobs, released its session, and reported no browser errors.  Evidence is web-browser-evidence/final-navigation-after-boot.  Nine isolated HTTP and transport tests also passed.

The two corrected pager transitions pass the isolated accounting tests and repeated guest collection before and after snapshot restoration.  Forced physical-memory pressure and the separate wired-stack snapshot reservation case remain further tests and work.  Pinned and function-area expansion bypassing the collector's reservation check remains a source-review finding.  These results do not establish the sole cause of the earlier panic.  The original VM was unchanged.

## Listener herald: 2026-10-12

The user approved a shared opening display and Show Herald renderer based on the supplied [Genera 8.3 Listener image](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/genera.gif).  The Genera User's Guide, printed page 2756, describes Show Herald as the opening system display and :Detailed as additional version information.  The opening display and Show Herald :Detailed will include two columns of loaded ASDF systems.  Plain Show Herald will omit that table.

Lisp will supply the title, image version, architecture, physical-memory and backing-store totals, loaded-system names and declared versions, and supported-key help.  The running image version comes from LISP-IMPLEMENTATION-VERSION.  ASDF lookup will use its registered loaded systems without loading or discovering files.  Missing component versions remain absent.  Memory totals use the supervisor's 4096-byte page and store-block units.  No guest hostname or loaded-image pathname is currently available.

The existing output-presentation mechanism will carry a :herald payload with character offsets over the text output.  This preserves plain-text clients and retained output order across reload and request replay.  Listener information will return a fresh detailed herald sample outside the debugger service lock.  The browser will keep its initial rendered display until Clear Output History.  Retained Show Herald output keeps the data captured by that command.  A separate cache or guest registry is unnecessary.

Required tests cover brief and detailed Lisp output, typed presentation offsets, declared system versions, retained replay, startup and clear behavior, reload, and headless Chromium rendering.  Font and geometry comparisons will distinguish sampled matches from complete-screen fidelity.  Font conversion uses the existing approved fontTools dependency.  The Web agent owns rendering, fonts, and browser tests.  The main agent owns Lisp data, transport tests, and API documentation.

The guest compiled and loaded the Lisp implementation.  The Listener transport suite passed brief, explicitly brief, and detailed output, exact presentation boundaries, agreement with the opening sample, and replay preserving captured data and text.  Existing completion, file, package, interactive input, reconnect, and cleanup tests also passed.  Evidence is herald-load-2.log and herald-listener-test.log.  The sample contains 31 loaded ASDF systems.  A first formatting attempt exposed that the guest FORMAT ignored the requested fractional precision for ~,2F.  The final display uses exact integer KiB totals.  Browser tests and a fresh image build remain in progress.

The fresh x86-64 image build passed in herald-build.log.  The isolated QEMU boot printed CI build completed successfully and exited with status 3, recorded in herald-ci-serial.log and herald-ci.exit.  This checks the Command Processor warm-load order before ASDF is loaded.  The herald looks up ASDF at runtime so the core reader requires no ASDF package.  The original and development VMs stayed running.  HTTP was paused for the single-client file server and resumed after CI.  All nine isolated HTTP and transport tests passed in herald-http-test.log.

Source review locates the fractional-format limitation in system/xp-format.lisp FORMAT-FLOAT: it declares D, K, OVERFLOWCHAR, and PADCHAR ignored and delegates real numbers to WRITE-FLOAT.  This pre-existing incomplete floating-point formatter remains unchanged.  Herald totals use integer arithmetic and exact KiB units.

The same-content visual fixture found horizontal system-column offsets of -3, -17, -3, and -10 pixels.  It also found that CSS grid stretched the shorter system table to the taller table, producing fractional row baselines and gray pixels.  The correction keeps the shared renderer, aligns both tables at their top, and uses the measured 314-pixel left table, 16-pixel gap, and 366-pixel right table at the reference viewport.  Table widths and text positions remain whole pixels.  The visual fixture intercepts all API replies and makes no guest requests.

Review of the actual guest capture found that the initial historical table widths split the ASDF version 3.3.3.3 across two lines.  The final layout allocates unused horizontal room to the version fields: 322-pixel and 374-pixel tables with an eight-pixel gap.  The measured text-column starts remain unchanged.  The final live test must keep the current versions on one line at the reference width while retaining wrapping at narrow widths.

The final focused Chromium suite passed the combined renderer and geometry.  All three displayed 3.3.3.3 version rows occupy one 13-pixel line at 1024 pixels.  The 640-pixel layout, startup with existing jobs, brief and detailed commands, Unicode ranges, text insertion, discarded-reply replay, reload, and Clear Output History passed.  All owned fixtures and sessions were released, with zero browser errors.  Evidence is web-browser-evidence/herald-live-wide.  The earlier shared-output run passed the existing Listener/Debugger suite in herald-listener-shared.  Ten isolated HTTP tests and all 1922 recovered-font glyph checks passed.  Renderer commit 048c0080 is published.

The historical fixture uses the shipped renderer with intercepted API replies and original reference text.  Twelve selected text rasters and the complete HELP keycap have zero missing, extra, or gray pixels.  Nine of thirteen rectangles have exact positions after subtracting the Macintosh menu's 20-pixel height.  The title prefix is one pixel left, the image-version line one pixel right, and HELP is eight pixels lower because of the adapted help grouping.  Original trademark characters use fallback fonts and introduce gray pixels outside the selected rectangles.  These results establish the measured samples, not complete-window identity.  The comparison files and font guide retain the source hash, coordinate normalization, and reproducible commands.

Product checks passed 14 books, 11 shell examples, and 79 repository links.  The refreshed guest catalog passed 111 topics and 83 references.  The guide now states that the image revision is recorded at build time.  The final catalog and Lisp implementation were saved in the development image, with completion recorded in herald-final-snapshot.log and the serial End snapshot marker.  This increment did not restart that snapshot.  Its separate fresh image build and QEMU boot passed as recorded above.

## Jzon integration: 2026-10-12

The user approved adding Jzon and keeping HTTPS/TLS work separate.  The recommendation uses unmodified upstream [Jzon](https://github.com/Zulu-Inuoe/jzon) 1.1.4 at 99b19fb18ab3555c04564a51a990db06ed1d8a23 and [float-features](https://github.com/Shinmera/float-features) at cd5dab00d2f4a562d65f46b3fc1cecec308e2443.  Both sources will reside beneath the existing guest home directory and use its ASDF source registry.  Closer-MOP, Flexi Streams, and trivial-gray-streams already have source trees in MBuild.  Float-features includes a Mezzano implementation.  Installation documentation will record the exact additional checkouts.  Startup will require COM.INUOE.JZON after ASDF initialization, following the existing library-loading mechanism.

The public interface remains Jzon's API.  A portable Lisp test will check distinct JSON types, Unicode and UTF-8, finite number conversion, malformed input, and configured limits.  Testing will include the running x86-64 guest, a fresh image boot, and snapshot restoration.  Product documentation and the Document Examiner catalog will describe the API and tested scope.  No HTTP or TLS implementation is part of this increment.

- [ ] Compile and load the pinned libraries in the development guest.
- [ ] Test JSON behavior and diagnose failures.
- [ ] Add startup loading and installation/API documentation.
- [ ] Test a fresh image boot and snapshot restoration.
- [ ] Review, commit, and push the completed increment.

Dependency inspection found that FLOAT-FEATURES also requires DOCUMENTATION-UTILS, which requires TRIVIAL-INDENT.  Their proposed pins are fcbd927dee7f311915a27ee557e3db1d4510403c and 87b35ff9202b107230e35790e93c471cc7880900.  Approval for these two previously unlisted dependencies is pending under the user's dependency rule.  They have not been installed.  The two approved source checkouts exist, and the API/corpus test and product documentation are prepared.  Jzon's release stores its ASDF file under src/ and includes JSONTestSuite fixtures in its own tree.  No separate test-framework dependency is proposed.

Dependency review traced Jzon's numeric code to three FLOAT-FEATURES operations: BITS-DOUBLE-FLOAT, SINGLE-FLOAT-BITS, and DOUBLE-FLOAT-BITS.  FLOAT-FEATURES references DOCUMENTATION-UTILS only through the single DOCS:DEFINE-DOCS form in documentation.lisp.  That macro expands its entries into SETF DOCUMENTATION calls.  The dependency supplies Lisp documentation accessible through CL:DOCUMENTATION.  Its implementation also supplies documentation formatting, translation, and completeness checks.  It has 20 lines of package definitions, 138 lines of implementation, and 151 lines documenting its own API at the proposed revision.

DOCUMENTATION-UTILS references TRIVIAL-INDENT once, to register the indentation rule for DEFINE-DOCS.  TRIVIAL-INDENT has 82 lines of Lisp and no further dependencies.  It stores rules in a hash table and registers that table with SWANK-INDENTATION or SLYNK/INDENTATION when those modules are already loaded.  Setting or removing a rule then requests an indentation-information update.  Its role is editor metadata.  The numeric routines use none of these documentation or indentation operations during JSON conversion.

Sources inspected: [documentation utility implementation](https://github.com/Shinmera/documentation-utils/blob/fcbd927dee7f311915a27ee557e3db1d4510403c/toolkit.lisp), [indentation implementation](https://github.com/Shinmera/trivial-indent/blob/87b35ff9202b107230e35790e93c471cc7880900/indent.lisp), and the pinned FLOAT-FEATURES and Jzon checkouts.  The recommendation remains to include the two small dependencies unchanged, preserving runtime documentation and the upstream ASDF definitions.  Installation approval remains pending.  This review installed neither library.

The user approved DOCUMENTATION-UTILS and TRIVIAL-INDENT.  Both pinned checkouts are installed under home/.  Guest compilation and the independent SBCL API/corpus test are in progress.

The SBCL API test passes after correcting two missing parentheses and the WITH-OBJECT invocation in the new test.  The host setup also needed the existing dependency directories in its ASDF registry.  Loading *STANDARD-INPUT* avoids reopening SSH's standard-input descriptor, which SBCL could not open through /dev/stdin.  The full corpus stopped in Jzon's numeric fallback constructing EXPT 10 -10000000 for i_number_real_underflow.json.  SIGINT captured that stack in json-sbcl-test.log.  Current upstream still has that fallback.  A source correction to detect provable underflow/overflow before EXPT has been recommended, and user approval is pending.  The y_/n_ cases are being tested separately while that correction is reviewed.

Guest compilation reached SCHUBFACH, then remained at eight completed functions out of 35.  During an attempted compiler-worker backtrace sample, the pager panicked with "Page fault in pager" at 8000032470.  The complete serial log is preserved as json-compile-panic-serial.log.  The development VM was restored from its saved image and Web service resumed.  Address lookup in that restored image identifies BYTE-POSITION, whose code is pageable.  Disassembly in json-page-allocator-disassembly.log confirms the earlier live replacement of PAGER-ALLOCATE-PAGE calls BYTE-POSITION and BYTE-SIZE.  The replacement was loaded in wired memory, but those callees remain pageable.  The active worker sample timed out, and neither the sample nor guest compilation completed.  Fresh-image testing must distinguish this saved live-replacement problem from the current cold-built kernel.  The current JSON image build completed in json-build.log.  Its boot remains to be tested.

Compiling the current PAGER-ALLOCATE-PAGE source at the bootstrap policy `(safety 3 debug 1 speed 1)` removed BYTE-POSITION and BYTE-SIZE calls in json-pager-bootstrap-policy.log.  The previous live replacement was compiled at the running application's debug level 3.  The correction reuses the approved pager source with the kernel compilation policy and wired loading.  No pager algorithm changes are required for this fault.  The developer test guide now records both requirements and the need to inspect callees.  The reload, three full collections, and fresh-image compilation are being tested.  The SBCL required corpus passed 95 valid cases and 188 invalid cases in json-sbcl-required-corpus.log.

The user approved the Jzon numeric correction.  The fork's fallback will use integer bounds derived from 2^3 < 10.  For positive mantissa m with bit length n and exponent e, e >= 0 and n + 3e > 1024 proves overflow.  For e < 0, n + 3e <= -1075 proves a value below half the minimum subnormal.  The existing conversion handles the remaining values, including rounding boundaries.  Zero bypasses exponentiation and preserves its sign for arbitrary-size exponents.  Tests cover both signs, extreme and bignum exponents, cancellation by a large mantissa, and both binary64 rounding boundaries.

The pager reload succeeded with the kernel policy and wired loading.  Three full collections and snapshot completion passed in json-pager-policy-gc.log and serial-debugging.log.  The first collection command used an unavailable SYS.INT package nickname in CL-USER and failed before running the collections.  The repeated command uses MEZZANO.INTERNALS.  The isolated JSON boot was stopped during SCHUBFACH compilation to inspect the compiler through the restored development guest.  That interrupted boot is not a passing boot test.

Compiler samples in json-compiler-sample-2.log and json-compiler-sample-3.log reached local-variable lowering and live-range construction for %WRITE-FLOAT and %WRITE-DOUBLE.  Reading the stopped worker's locals showed 43,715 instructions and a maximum of 803 debug variables for %WRITE-FLOAT.  One instruction compared two lists of 664 preserved values through SET-DIFFERENCE.  Compilation continues under the existing policy.  Evidence is json-compiler-locals.log.  An initial remote editing command had incorrect shell quoting and failed before changing the Jzon source.  The corrected command quotes the complete remote script.

The numeric source correction and upstream test cases are published on [Jzon numeric-range-v1.1.4](https://github.com/jsmorph/jzon/tree/8f8099ae762d54de9cbe2a084fc52ae3de96ee7d).  The first edit of the upstream test file normalized two embedded carriage returns.  The following commit restores those fixture bytes.  The final difference from upstream consists of the numeric helper and its tests.  The project API tests passed under SBCL, including exact underflow and overflow rounding boundaries, and all 318 included corpus cases completed: 95 accepted, 188 rejected, and 35 implementation-defined cases (6 accepted, 29 rejected).  Evidence is json-sbcl-fixed.log.  The upstream FiveAM suite was not run.  No test-framework dependency was installed.  Installation documentation now pins the corrected fork, and the JSON reference identifies numeric conditions and the release's empty-input TYPE-ERROR.

During the continued compile, both the worker sample and a separate readiness evaluation timed out.  QEMU continued executing and issuing paging I/O, with no new serial panic.  The serial log was preserved as json-compile-slow-serial.log, and the development VM was restored from the corrected pager snapshot.  The compile did not finish.

The proposed compiler correction replaces BUILD-LIVE-RANGES' repeated list membership scans with an EQ hash table reused across its set differences.  Virtual registers are identity objects, so EQ preserves the current EQL comparisons.  Tests must compare the resulting register sets and live ranges with the existing implementation and compile Jzon at the unchanged application debug policy.  The full debugger-variable tests must remain passing.  User approval is pending.

The corrected pager survived snapshot restoration.  Both replacement functions still lack pageable BYTE-POSITION and BYTE-SIZE calls, and three further full collections passed.  Evidence is json-pager-restored.log.  This establishes the corrected saved compilation policy.  Jzon guest compilation and its memory-pressure test remain incomplete.

The updated Document Examiner catalog passed 15 documents, 117 topics, 89 references, searches, missing-topic replies, command assistance, Unicode cursors, and cleanup in json-examiner-test-2.log.  The first run caught an incorrect edit to the test's command count: adding a book changes the book count to 15, while the command count remains 14.  The test now preserves that distinction.

## Register-allocation set comparisons: 2026-10-12

The user approved replacing repeated register-list searches with a reusable EQ hash table.  The table records an integer generation for each right-hand operand.  Each comparison increments the generation, so earlier entries require no clearing.  This avoids Mezzano CLRHASH allocating a new storage vector for every comparison.  The local helper preserves Mezzano SET-DIFFERENCE's result order and duplicate handling.  Only the five virtual-register set differences in BUILD-LIVE-RANGES change.  The physical-register constraints keep their existing computation.

Validation will compare the previous and corrected builders on live/debug/dead transitions, aliases, empty sets, and large preserved-variable sets.  Existing binding-inspection and write tests will check generated behavior.  Jzon must then compile and pass its API and corpus tests with the existing debug-3 policy before a fresh image boot and snapshot restoration.

The running x86-64 guest compiled the corrected allocator.  The old and new BUILD-LIVE-RANGES functions produced matching interval endpoints, debug-only intervals, register IDs, and physical-register conflicts on the checked fixtures, including 800 preserved variables across 64 instructions.  The comparison also covered duplicate aliases and empty inputs.  Evidence is json-live-range-compare.log.

Nine guest tests passed with the corrected allocator: live ranges, frame-local identity, binding visibility, binding writes, type-changing writes, captured bindings, local debug policy, keyword processing, and jump-table cleanup.  The fixtures exercise debug levels 1 and 3, mutation, and collection.  Evidence is json-allocator-debug-tests.log.  A fresh image build and Jzon compilation are running.  This commit establishes the allocator change and these tests; JSON guest validation remains pending.

## Debug metadata allocation: 2026-10-12

The hashed live-range builder let Jzon's writer compilation reach register rewriting.  The live guest later stopped answering SWANK.  The separate fresh image built successfully in json-allocator-build.log, but its boot remained at eight of 35 SCHUBFACH functions.  QEMU's GDB endpoint showed the garbage collector in TRANSPORT-OBJECT waiting for page reads and writes while application execution was stopped.  Disk I/O continued.  Evidence is json-fixed-compiler-sample.log, json-allocator-live-slow-serial.log, json-gdb-final-threads.log, and json-allocator-ci-serial.log.  Neither compilation nor this boot passed.

REBUILD-DEBUG-MAP allocates a new three-element binding record and list cell for every binding at every original instruction.  A guest fixture supplied the same 800 input records to 64 instructions with unchanged locations.  The result contained 51,200 distinct binding records and 64 distinct lists.  Evidence is json-debug-map-shared-input.log.  This is a confirmed source of retained allocation.  The available samples do not establish that it accounts for all compilation memory use.

The x86-64 and ARM64 EMIT-DEBUG-INFO functions copy the bindings again for every instruction.  The assembler reads their layout lists without modifying them.  Its final metadata pass removes adjacent equal layouts only after those allocations have occurred.  REBUILD-DEBUG-MAP also maintains an active-range list that no later computation reads.

The recommendation is to share unchanged immutable binding records and lists during rebuilding, reuse converted layouts during each function's LAP generation, and remove that unused range list.  Caches remain local to one function compilation.  Binding order, locations, representations, hidden flags, instruction positions, and debug policy must remain unchanged.  User approval for this additional compiler correction is pending.

Required tests compare old and new metadata through location changes, spills, aliases, scope changes, empty layouts, and inserted instructions.  The shared-input fixture must retain 800 output records rather than 51,200.  Emitter and encoded-metadata comparisons must cover x86-64 and ARM64 metadata, with ARM64 execution reported separately as untested.  Existing guest binding tests, Jzon compilation and JSON tests, fresh boot, and snapshot restoration remain required.

The isolated CI guest was stopped after continued paging without completion.  Its termination status was 0, which does not satisfy the required CI status 3 or completion marker.  The development guest reloaded the committed allocator, passed the live-range fixture, and saved a snapshot.  The VM restarted from that snapshot and passed the fixture again.  Evidence is json-allocator-persist.log and json-allocator-restored.log.  The Web service resumed.  Jzon remains unloaded in this guest.

The user approved the metadata-sharing correction.  Rebuilding will cache translated binding records by input-record identity and reversed list prefixes by input-list identity.  A changed location creates a new record.  A changed prefix creates a new list cell.  Earlier instruction layouts retain their previous values.  Each target emitter will receive a per-function EQ cache of converted layouts, retaining its existing :DEBUG instruction positions.  The assembler requires no change.

The guest compiled and loaded the allocator and both target emitters.  Old/new comparisons passed for the rebuild maps and emitted layouts.  The unchanged 800-binding fixture now retains 800 records and one layout across 64 instructions.  Location changes, spills, aliases, representation changes, scope changes, empty inputs, and inserted instructions passed.  Both emitters matched expected layouts and encoded bytes, including hidden variables and ARM64 callee-save entries.  A missing spill slot still signals an error.  Evidence is json-metadata-compare.log.  ARM64 machine code was not executed.

The nine existing live-range and debugger-binding tests passed with the correction, including mutation, closure sharing, local debug policies, and GC during inspection.  The guest saved the corrected compiler in its development snapshot.  Evidence is json-metadata-debug-tests.log and the serial End snapshot marker.  Jzon compilation and fresh-image testing remain pending.

## Lisp HTTPS investigation: 2026-10-12

The user requested a working Lisp TLS and HTTP client, including an authenticated OpenAI endpoint test.  The recommendation is an SBCL baseline using [pure-tls](https://github.com/atgreen/pure-tls) 1.15.1 at 439d85b6bc90f335f17fd51f30bba37742c4b652 and [Drakma](https://edicl.github.io/drakma/) 2.0.10 at f9d001b203ebe27b74facf558ba08ed672882ac7.  Pure-tls supplies a CL+SSL compatibility layer.  Its documented ASDF registration lets Drakma use that layer.  Certificate-chain and hostname verification must remain enabled.  The test will serialize and parse JSON with the approved Jzon library.

New dependencies are pure-tls, Drakma, Ironclad, cl-base64, IDNA, USOCKET, cl-cancel, atomics, precise-time, global-vars, PURI, Chunga, and CFFI.  CFFI serves precise-time's SBCL clock backend.  Its Mezzano backend uses native Lisp operations.  Other dependencies already have source trees in the build environment.  Bordeaux-Threads must move to a version containing API v2, which Ironclad and cl-cancel use.  The initial installation will be isolated from the guest's library trees.  Dependency approval is pending.  Source inspection has installed no library.

The host tests will check a verified HTTPS response, rejection with an empty trust store and a mismatched hostname, then a short authenticated Responses request using the user's key.  The request will disable redirects and header logging.  Output and evidence must exclude credentials.  The [official API quickstart](https://developers.openai.com/api/docs/quickstart) specifies the Responses endpoint and Bearer authentication.  This bounded test establishes interoperability, not a security audit.

Mezzano requires separate porting work.  Ironclad's OS random generator has no Mezzano backend.  Mezzano MAKE-RANDOM-STATE seeds its generator from GET-UNIVERSAL-TIME and supplies no cryptographic entropy.  The VirtIO source defines the entropy-device identifier but has no driver.  The new Bordeaux-Threads tree includes Mezzano API v2 support, with several operations explicitly unsupported.  The required operations and USOCKET backend must be checked before guest integration.  No entropy or thread fallback has been selected.

Jzon compiled SCHUBFACH after the metadata-sharing correction and reached its parser.  The evaluation client timed out after 600 seconds.  Two compiler workers remain runnable, and a subsequent SWANK evaluation completed.  Jzon is not yet registered as loaded.  The fresh image build passed in json-metadata-build.log; its boot has not run.

The user approved the HTTPS dependency set.  The Linux SBCL baseline compiled and loaded the pinned libraries without source changes.  The independent source tree takes precedence over the guest's old Bordeaux-Threads.  Quicklisp 2026-01-01 supplied the remaining approved releases.  The checked-in tools/https source manifest and guide record the inputs and commands.

The transport test negotiated TLS 1.3 and cipher suite #x1303, TLS_CHACHA20_POLY1305_SHA256, with api.openai.com.  It rejected a mismatched hostname with the correct SNI and rejected an empty trust store.  Drakma returned HTTP 401 for an unauthenticated GET, and Jzon parsed the JSON error.  The authenticated Responses POST returned HTTP 200, model gpt-4.1-nano-2025-04-14, status completed, and "Lisp HTTPS works."  Usage was 15 input tokens and 6 output tokens.  Verification was required, redirects were disabled, and store was false.  Evidence is https-sbcl/transport.log, https-sbcl/transport-final.log, and https-sbcl/openai.log.

The selected OPENAI_API_KEY assignment was read from the local private file and sent through SSH standard input to the SBCL runner.  Other credentials were not transferred.  No credential was written to the repository or test logs.  The first runner failed to read because I omitted a closing parenthesis, before reading the key or making a request.  The corrected runner passed.  A separate syntax check initially lacked ASDF/UIOP and passed after REQUIRE ASDF.  The reusable runner redacts the supplied key from error messages and returns a failure status.

The final transport command passed using the checked-in loader and the documented CL_SOURCE_REGISTRY configuration.  The host test establishes the stated request and certificate-verification behavior.  Guest HTTPS, streaming, blocked-I/O cancellation, revocation behavior, and the upstream TLS suite remain untested.  Source review found that USOCKET's Mezzano backend rejects connection timeout arguments.  CL-CANCEL's stream-monitor cleanup passes :TIMEOUT to the API v1 JOIN-THREAD, which accepts one argument.  Pure-tls creates that cleanup function but does not call it.  The request's cancellation context eventually wakes the monitor.  This cleanup behavior needs a separate review before using long-lived contexts.

A second ordinary SWANK evaluation timed out during Jzon parser compilation after 300 seconds.  The previous completed worker set had left no loaded Jzon system.  The retained evaluation service now owns a build-and-test job that first waits for the existing compiler workers, then loads Jzon and runs the API and corpus tests.  Its output and conditions survive client disconnects.  Compilation policy remains unchanged.  The fresh CI image has not booted.

## Spill interference allocation: 2026-10-12

Jzon's parser compilation remains in BUILD-INTERFERENCE-GRAPH.  A guest frame sample found 58,536 virtual-register IDs, 84,501 spill ranges, 2,334,011 directed edges accumulated, and a largest neighbor set of 14,274 entries for %PARSE.  PARSE-NEXT-ELEMENT had 58,913 IDs, 86,800 ranges, 2,739,739 directed edges, and a largest neighbor set of 14,557.  Evidence is json-interference-size.log.  The sample observes incomplete graphs.

INSERT-INTO-VREG-SET allocates a vector one element larger and copies the previous elements for every new edge.  A neighbor set growing to degree d therefore copies d(d-1)/2 entries.  BUILD-INTERFERENCE-GRAPH inserts each undirected edge in both directions.  This allocation remains after the previously corrected live-range comparisons and debug-layout sharing.

The recommendation is a lazily allocated mutable bit vector for each nonempty neighbor set, indexed by the existing dense virtual-register ID.  A separate bit vector records spilled IDs and produces their ascending vector for ASSIGN-STACK-SLOTS.  Graph membership becomes SBIT lookup.  Edge construction, interval endpoints, variable preservation, slot classes, and assignment order remain unchanged.  The representation requires at most N squared bits for N registers, excluding vector headers.  At 58,913 IDs, that bound is about 414 MiB per function.  Actual allocation depends on the number of nonempty rows.  This removes the per-edge vector copying and bounds the graph's storage independently of edge density.

Approval is pending.  Tests must compare old and new edge membership and stack-slot assignments for overlapping, adjacent, disjoint, repeated, and unused ranges, including SSE/ADVSIMD slot classes.  A dense fixture must establish that existing neighbor arrays are reused as edges are added.  The existing debugger-binding tests, Jzon compilation and JSON tests, fresh boot, and snapshot restoration remain required.

The user approved the spill-interference bit-vector correction.  Implementation and old/new graph and slot-assignment comparisons will precede the next Jzon build.

## Guest entropy and socket proposal: 2026-10-12

The recommendation is a Lisp VirtIO entropy driver using the existing transport and queue support, with QEMU's rng-random backend reading the host's /dev/urandom.  Ironclad's OS random method would request bytes through that driver.  The [VirtIO 1.3 entropy-device specification](https://docs.oasis-open.org/virtio/virtio/v1.3/virtio-v1.3.html) defines device ID 4, one queue, and writable buffers whose completed length must be checked.  Mezzano defines that device ID and has PCI and MMIO transports.  QEMU's installed device help confirms the rng-random filename and virtio-rng-pci rng properties.

The driver must handle short completions, serialize shared queue access, validate descriptor IDs and lengths, and fail when no usable device exists.  Each request obtains fresh device bytes.  Restoring an image must invalidate saved queue state and incomplete requests through the existing boot-ID mechanism.  Tests must cover concurrent readers, partial completion, missing-device errors, and a fresh request after restoration.  This initial entropy source supports QEMU.  Bare-metal entropy remains separate.

Mezzano already has TCP streams, connection timers, and timeout conditions.  TCP-CONNECT uses the global ten-second *TCP-CONNECT-TIMEOUT*.  Its TIMEOUT argument configures later connection inactivity.  USOCKET's Mezzano backend rejects an explicit connection timeout.  DNS resolution uses ten-second receives across up to three attempts per configured server.  TCP stream CLOSE ignores ABORT and follows normal shutdown.  Therefore assigning USOCKET's timeout directly to the existing TIMEOUT argument would give the wrong behavior.

The recommendation is to pass a connection deadline through DNS and TCP establishment using the existing waits and timers, expose it through USOCKET's timeout argument, and preserve the existing inactivity timeout's meaning.  Abort close must detach the connection, wake waiters, and cause blocked operations to report closure.  Refused connections, elapsed deadlines, EOF, abort during blocked input, and snapshot-invalidated connections require tests.  TLS handshake and read cancellation must then be tested through the approved CL-CANCEL and pure-tls stack, including monitor-thread cleanup.

An installed CA bundle supplies trust anchors to pure-tls.  The final guest test will repeat the verified OpenAI POST with Jzon for request and response JSON.  The TLS implementation remains in the guest.  This proposal introduces no additional libraries.  User approval for the entropy and socket changes is pending.

The user approved the guest entropy, connection deadline, abort-close, CA bundle, cancellation tests, and guest OpenAI POST plan.  Implementation will reuse the existing VirtIO queues, timers, and streams.

The x86-64 guest compiled the corrected allocator at the unchanged application policy.  Old and new builders produced identical edge sets and ascending spilled-register IDs on empty, overlapping, endpoint-touching, disjoint, repeated, unused, and partially spilled ranges.  Their scalar and SSE/ADVSIMD slot assignments and classes matched, including a dense 128-register graph.  A separate 800-register fixture retained each row's identity through all insertions and used 640,000 payload bits.  The new representation also passed a single-spilled-register fixture.  Evidence is json-spill-compare.log and json-spill-final.log.

Ten existing guest tests passed: live ranges, debug-metadata sharing and encoding, frame-local identity, binding visibility, binding writes, type-changing writes, captured bindings, local debug policy, keyword processing, and jump-table cleanup.  Evidence is json-spill-debug-tests.log.  These tests establish the allocator increment.  Jzon guest compilation, JSON tests, a fresh image boot, and snapshot restoration remain incomplete.

The entropy driver will use one Lisp worker, one request mailbox, and one nonpersistent DMA page.  Each caller submits a private result buffer and waits for its completion, a driver failure, or expiration of the device's boot ID.  The worker serializes descriptors and acknowledges interrupts even after a caller leaves.  It validates one used descriptor and its positive length before copying bytes, then resubmits the remaining length after a short completion.  This follows the existing pageable VirtIO network driver and DMA-buffer API.  Driver errors propagate to callers and remain errors in the worker.  Publication of a completed result checks the boot ID again.

SSH access failed during implementation and returned before the next test run.  The entropy driver compiled, but its first completion fixture failed because my live definition called MEZZANO.SUPERVISOR::%MFENCE.  The x86-64 source switches to MEZZANO.INTERNALS before defining that helper.  The source addition already uses the correct package.  Correcting the live definition made the completion fixture pass short lengths, invalid lengths and descriptor IDs, unexpected completion counts, index wraparound, and missing-device errors.  Evidence is entropy-completion-test-2.log.  Hardware reads and snapshot tests remain pending.

The retained Jzon compilation reached function construction and stopped on the GC metadata size assertion: 70,062 bytes exceed the 16-bit function-header field's limit of 65,535.  Evidence is json-bitset-inspect.log.  The compilation failed, and Jzon remains unloaded.  The retained stop is preserved while the metadata format and compiler output are reviewed.

## OpenAI inference objective: 2026-10-13

The user clarified the target: clean OpenAI inference endpoint access from Mezzano.  The deliverable is a reusable Lisp request function that accepts credentials and request data, performs verified HTTPS with a bounded request lifetime, and returns parsed JSON or a reported failure.  Dependency work, compiler changes, and driver changes serve that end-to-end result.

Jzon's GC metadata exceeds the compiled-function header's 16-bit length field.  The 56-bit header data currently allocates bits 8 through 23 to code length, 24 through 39 to constant-pool length, and 40 through 55 to metadata length.  Bits 0 through 7 are unused by the current function constructors and readers.  The recommendation is to store the metadata length's additional eight high bits there, allowing lengths through 16,777,215 bytes.  Existing function headers keep their interpretation because their unused bits are zero.  Code and constant-pool fields keep their positions.

This requires corresponding changes in runtime allocation, metadata readers, GC object sizing, and cold-image serialization.  Shared named field constants will define the encoding.  Tests must cover 65,535/65,536-byte boundaries, a large function across collection, metadata decoding, ordinary function compatibility, a fresh image boot, and snapshot restoration.  Jzon compilation and API/corpus tests must then pass.  Approval is pending because this extends the function representation and its collector interpretation.

The user approved the 24-bit GC metadata length correction.  The entropy device passed four concurrent 8,193-byte reads with QEMU configured for at most 17 bytes every five milliseconds.  Evidence is entropy-device-test.log.  The next entropy test saves an incomplete request and checks that restoration expires it before accepting bytes from the new device instance.

The entropy snapshot test passed: an incomplete 1 MiB request saved under the test rate limit failed with ENTROPY-UNAVAILABLE after restoration, and a new request returned bytes from the new device instance.  Evidence is entropy-restore-prepare.log and entropy-restore-finish.log.  The worker exits on an expired boot ID and publishes its failure state to waiters.  It accesses device registers and DMA buffers only inside the existing snapshot exclusion mechanism.  The guide records the API, QEMU options, and tests.  A cold image boot remains part of the combined integration tests.

The approved metadata length correction now updates runtime allocation, the three metadata readers, collector object sizing, and cold-image serialization.  The runtime readers and collector were installed before enabling extended allocations.  Replacement kernel functions were compiled at safety 3, debug 1, speed 1 and loaded wired.  Application compilation remains safety 3, debug 3, speed 1.

The guest tests passed length boundaries 0, 65,535, 65,536, and 70,062, final-byte access, out-of-range access, collector sizing, and rejection at 16,777,216 bytes.  A callable x86-64 fixture has 83,923 bytes and 12,004 decoded metadata entries.  It passed a full collection while its frame held a movable Lisp object.  Its constant-pool reference remained valid.  The initial fixture incorrectly expected no final layout, although the return instruction requires #*0.  Correcting that assertion produced metadata-length-test-2.log.

The guest saved the corrected runtime and fixture, restarted, and passed the same metadata and active-frame collection checks.  The entropy concurrency test also passed after that restart.  Evidence is metadata-length-restored.log.  QEMU's partial-entropy test rate limit was removed, and the Web service resumed.

The host test passed old-header compatibility, unchanged code and pool fields, lengths through 16,777,215, and upper-bound rejection in metadata-cold-header-test.log.  The fresh cold image built successfully in https-metadata-build.log.  Its boot remains pending.  Jzon compilation and JSON tests resumed in a new retained job using the corrected guest.  ARM64 execution remains untested.

## Connection deadlines and abort close: 2026-10-12

The approved socket increment will add an absolute deadline measured by GET-INTERNAL-RUN-TIME, which is the supervisor timer clock.  TCP-STREAM-CONNECT will compute it once from CONNECT-TIMEOUT and pass it through DNS and TCP establishment.  The existing TIMEOUT argument will retain its connection-inactivity meaning.  DNS will propagate network errors rather than converting them into an unknown-host result.

The TCP caller will wait with the remaining deadline and abort on an unsuccessful exit.  Its queued start must check that the caller has not already closed the connection.  Start errors will reach the waiting caller through the existing pending-error slot.  Abort will close the local state and wake readers immediately, then remove timers and dispatch sources on the network queue.  Reset generation will follow [RFC 9293 section 3.10.5](https://www.rfc-editor.org/rfc/rfc9293.html#section-3.10.5).  A blocked read must check pending errors again after waking.  Tests will cover connection refusal, DNS and connect deadlines, interrupted establishment, EOF, abort during a blocked read, dispatch cleanup, and snapshot invalidation.

Jzon compiled and loaded after the metadata correction.  Its API test stopped at the binary64 overflow rounding threshold.  Direct guest tests show that FLOAT and Jzon both return the largest finite double for the threshold and threshold + 1.  SYSTEM/NUMBERS/BIGNUM.LISP BIGNUM-TO-FLOAT takes the leading significand bits with LDB and discards the remainder.  This truncates instead of rounding and prevents the carry that should overflow.  The recommendation is to round the integer significand with ROUND before scaling by the power of two, covering short, single, and double floats through the shared routine.  Tests must cover both signs, even/odd halfway significands, values on either side, and the overflow boundary.  The [Common Lisp FLOAT specification](https://www.lispworks.com/documentation/HyperSpec/Body/f_float.htm) describes conversion to the requested format.  Nearest-even rounding is the numeric behavior required here by Jzon's conversion tests.  Approval is pending before changing this shared runtime routine.

The user approved nearest-even bignum conversion.  The shared routine will use exact integer ROUND before the existing float conversion and power-of-two scaling.  A nonnegative shift also permits direct checks of the shared routine at the short-float boundary.

The bignum conversion tests passed both signs, even and odd halfway significands, neighboring values, and single/double overflow boundaries with overflow masked and unmasked.  Short-float checks cover its finite/infinite boundary through the shared routine.  The first new test had a missing parenthesis.  The next run exposed an incorrect test assumption: Mezzano masks hardware overflow by default.  The numeric and JSON boundary assertions now accept a correctly signed infinity or FLOATING-POINT-OVERFLOW, preserving the caller's trap mode.  Evidence is bignum-json-tests-3.log.

Jzon's API tests now pass in the guest.  Its full corpus has eight failures, all valid strings containing Unicode noncharacters.  Results are 87 accepted valid inputs, 188 rejected invalid inputs, and 35 implementation-defined inputs (3 accepted and 32 rejected).  The corpus is not passing.  The stopped earlier API job was aborted and released after recording its condition and frames.

The eight corpus failures come from Mezzano's %MAKE-CHARACTER and UNICODE-SCALAR-VALUE-P rejecting U+FDD0 through U+FDEF and the final two code points in every plane.  Unicode defines these noncharacters as valid scalar values.  The recommendation is to retain the surrogate and range checks and remove only the noncharacter exclusions from those two functions.  This permits lossless JSON and UTF-8 transport of those values.  Tests must check all 66 noncharacters, surrogate rejection, and the unchanged JSON corpus.  Sources: [Unicode noncharacter FAQ](https://www.unicode.org/faq/private_use.html#nonchar1) and [RFC 8259 section 8.2](https://www.rfc-editor.org/rfc/rfc8259.html#section-8.2).  Approval is pending for this character behavior change.

The HTTPS sources now occupy a separate guest-visible directory using the approved revisions and Quicklisp releases.  The portability edits add the VirtIO entropy calls to Ironclad, pass Drakma's connection timeout through USOCKET, fix Bordeaux-Threads' undefined RELEASE-NOT-IMPLEMENTED call, and use precise-time's declared fractional units in cl-cancel.  The host CA bundle is copied to a guest-readable file.  Source installation first failed because Quicklisp release directories include a -git suffix.  The repeated installation selects each exact release's existing directory.  Compilation remains to be tested.

Cancellation source review found that CL-CANCEL:CLOSE-STREAM-ON-CANCEL leaves its monitor blocked when cleanup runs before cancellation, then calls Bordeaux-Threads v1 JOIN-THREAD with an unsupported :TIMEOUT argument.  Pure-tls also discards the returned cleanup function.  The correction uses a child cancellation context so cleanup can wake and join its monitor without canceling the caller's context.  A captured close failure reaches the cleanup caller.  TLS streams retain the cleanup function and run it on close or failed construction.  TLS close uses UNWIND-PROTECT to close the raw stream and release the monitor even when output fails.  Tests must cover early cleanup, cancellation of blocked input and handshake, and thread cleanup.

Bordeaux-Threads v2 fails while expanding ATOMIC-CAS because its atomics file has no Mezzano branch.  Mezzano's native CAS and atomic increment/decrement cover the general operations, but increment/decrement require fixnums, while Bordeaux-Threads' ATOMIC-INTEGER advertises a full unsigned machine word.  The recommendation is to add native macro branches and reuse the existing CLISP implementation's mutex-protected ATOMIC-INTEGER operations for Mezzano.  This preserves the declared integer range with the existing code and adds no dependency.  Tests must cover success/failure of CAS, both arithmetic operations, values above MOST-POSITIVE-FIXNUM, and concurrent increments.  Approval is pending for this portability choice.

The user approved the Unicode noncharacter change.  The two checks now accept the 66 noncharacters while retaining surrogate exclusion and the Unicode range limit.

The Unicode tests passed all 66 noncharacters through CODE-CHAR, octet decoding, and the stream decoder.  They also passed every surrogate rejection and out-of-range checks.  Jzon's API and full corpus now pass in the x86-64 guest: 95 valid inputs accepted, 188 invalid inputs rejected, and 35 implementation-defined inputs (3 accepted and 32 rejected).  Evidence is unicode-json-tests.log.  Fresh-image boot and restoration of the Unicode change remain pending.

The guest network tests passed DNS/connect deadlines, expiration before queued start, connection refusal, interrupted establishment, octet transfer, EOF, blocked-read abort, and removal from the connection list.  After snapshot restoration, the saved connection signaled CONNECTION-STALE and new connections passed stream tests.  Evidence is https-network-interrupt.log and https-snapshot-restored.log.  This test does not cover a route disappearing during the queued reset send.  The current reset callback propagates that send error in the network worker, after detaching the connection through UNWIND-PROTECT.

The fresh image built from the current source passed its boot test, printing CI build completed successfully and exiting with status 3.  Evidence is https-current-build.log, https-current-ci-serial.log, and https-current-ci.exit.  This image includes Jzon startup loading, the metadata-length change, bignum rounding, Unicode conversion, entropy, and TCP changes.

I restarted the development VM before the first final JSON snapshot command confirmed completion.  That sequencing error restored the prior snapshot, which lacked the Unicode update.  The host command reported a closed SWANK connection.  I reloaded the update and catalog, repeated the JSON tests, and waited for both the explicit snapshot-completion reply and serial End snapshot marker before restarting again.  Evidence is json-snapshot-retry.log.  After that restart, Unicode, numeric conversion, JSON API/corpus, all network tests, and a full collection passed in json-restore-final.log.  The repeated snapshot is the tested saved state.

Document Examiner tests passed 15 books, 117 topics, and 89 references, including JSON documentation, search, commands, missing-topic replies, Unicode cursor offsets, and session cleanup.  Evidence is json-examiner-test.log.

The edited TLS sources passed SBCL verified TLS, hostname rejection, empty-trust rejection, and unauthenticated HTTP 401 JSON parsing in https-port-host-test.log.  Cancellation tests passed early cleanup without parent cancellation, reported stream-close errors, blocked reads, blocked handshakes, and monitor thread cleanup in https-cancellation-host.log.  Guest TLS loading stopped at the unimplemented Bordeaux-Threads ATOMIC-CAS macro.  That job was aborted and released before the snapshot retry.  The proposed Mezzano atomic backend remains awaiting approval.

Source review also found that precise-time's Mezzano GET-PRECISE-TIME combines RTC whole seconds with a separate timer's fractional second.  Those clocks have different phases.  Correct fractional units alone do not make their combined value continuous.  Mezzano's GET-INTERNAL-REAL-TIME already provides a boot-anchored wall clock in one unit and is used by precise-time's monotonic backend.  The recommendation is to derive both returned values from that single reading for GET-PRECISE-TIME as well.  This portability choice still requires review and approval after the pending atomics question.

The user approved the Bordeaux-Threads atomic backend.  General CAS will use Mezzano's EQ-based compare-and-swap.  General increment/decrement will preserve Mezzano's fixnum restrictions and evaluate the delta once.  The ATOMIC-INTEGER operations will reuse Bordeaux-Threads' existing mutex implementation and retain its unsigned 64-bit value type on x86-64.

Bordeaux-Threads next stopped while constructing its weak-key thread registry.  The installed trivial-garbage revision d3e470cb2385f7564147367452cb6237d3bd9818 has Mezzano weak-pointer support but omits Mezzano from weak-hash-table dispatch.  Mezzano already supports all four weakness modes through MAKE-HASH-TABLE and exports HASH-TABLE-WEAKNESS.  The portability edit maps those existing interfaces without changing collection semantics.

The guest atomic tests passed native CAS success/failure, single evaluation of increment/decrement amounts, unsigned 64-bit boundary values, and 4,000 concurrent increments from four threads above MOST-POSITIVE-FIXNUM.  The first test used single-colon syntax for internal Bordeaux-Threads helper macros and failed while reading.  The corrected test passed in https-atomics-test-2.log.  Trivial-garbage's four weakness mappings also passed.  The retained HTTPS load resumed and reached Ironclad compilation.
