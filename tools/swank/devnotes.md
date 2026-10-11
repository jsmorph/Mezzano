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
