# Debugger design and implementation status

This document describes the retained Lisp debugger on the `debugging` branch.  The implemented service retains condition stops in explicitly wrapped threads, inspects frames and locals, invokes existing restarts, and records command outcomes across connection loss.  Symbolics-level debugging remains the development objective.  The capability table identifies the remaining work.

The stop-service and compiler baseline reviewed here is Mezzano `37dbb34912616d85f6207edaa5161fa6e410c56a` with Slime `2b2086a9951f7b18dc0b88e32729224ba1485029`.  Tests used x86-64 QEMU/KVM.  The evaluation service described below extends that baseline.

| Document | Authority |
|---|---|
| This document | Architecture, ownership, compiler guarantees, capability status, and test scope. |
| [Remote evaluation and debugging](../tools/swank/README.md) | User workflow and executable examples. |
| [SWANK protocol reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) | RPC signatures, representations, and rejection reasons. |
| [Build and VM operations](../tools/swank/minideb2/README.md) | Dependency revisions, build, startup, snapshots, restore, and test commands. |
| [Development journal](../tools/swank/devnotes.md) | Decisions, diagnoses, failed attempts, commits, and historical evidence. |

## Architecture and ownership

The implementation uses Common Lisp for compiler metadata, stop management, SWANK adaptation, and the host client.  Architecture-specific frame access belongs in the existing runtime and compiler.  Host shell scripts run builds and QEMU.

The [guest stop service](../system/debugger-service.lisp) owns stops and accepted commands.  A stop retains the condition, applicable restart objects, captured frames, and the target thread's dynamic environment.  The target thread waits in a command loop and executes inspection, printing, and restart functions.  Other threads continue running.

The SWANK contrib owns sessions, connection associations, and token tables.  The [host client](../tools/swank/debugger-client.lisp) creates session names, transports requests, and decodes replies.  Closing a connection releases control through SWANK's connection-closed hook.  It leaves the stop and accepted commands in the guest service.

Entry is explicit:

```lisp
(mezzano.debug:call-with-debugger-service function)
```

The wrapper binds the condition debugger hooks for the function's dynamic extent.  A background thread needs its own wrapper.  Ordinary SWANK evaluation uses SLDB.  The batch evaluation API establishes this wrapper in its own worker.  Ordinary SWANK evaluation remains a separate path.

A service mutex protects the registry, ownership, command acceptance, and results.  Operations that inspect frames, print objects, or invoke restarts execute outside that mutex on the stopped thread.  Registry operations inhibit footholds while holding the mutex and re-signal errors after releasing it.

A stopped thread retains any application locks it holds.  Another thread can change shared objects reachable through its locals.  A stop therefore preserves an activation without freezing the heap.  The existing GC tests establish specific frame and binding cases.  Deadlock handling for arbitrary printers, application locks, and debugger dependencies remains open.

## Stop and command lifetimes

### Handles and control

Guest handles are opaque Lisp objects.  Stop handles and controllers carry the boot-event object from [the supervisor](../supervisor/entry.lisp).  Validation compares that object with the current boot event using `EQ`.  Numeric stop IDs describe records.  The service validates handles before accessing retained frames.

| Object | Lifetime and authority |
|---|---|
| Stop record | Registered on debugger entry.  State is `:stopped`, then `:closed` when control leaves the service.  Explicit release removes a closed record. |
| Stop handle | Identifies a registered record in one boot.  A closed record remains queryable. |
| Controller | Groups control leases.  Closing it releases ownership of its stops. |
| Control lease | Grants one controller exclusive command submission and closed-stop release.  Closing the controller invalidates its leases. |
| Frame reference | Identifies one frame in one stop generation.  It expires on stop exit or boot change. |
| Command record | Retains acceptance, state, operation, boot identity, and result until explicit stop release. |
| Remote session | Associates a client name and token table with one guest boot.  Reconnection creates a new controller. |

Frame capture begins at the retained service-debugger activation and continues toward older callers.  Temporary stack-walking activations are excluded.  Closing a stop increments its generation and clears live condition, frame, and restart references.  A child retains its parent's descriptive ID after parent release, but information returns a parent handle only while the parent remains registered.

The public functions are exported from `MEZZANO.DEBUG`:

| Function | Purpose |
|---|---|
| `call-with-debugger-service function` | Establishes condition-stop entry for a dynamic extent. |
| `debugger-stops &key include-closed` | Returns current-boot handles for registered stops. |
| `debugger-stop-information handle` | Returns identity, state, thread name, parent/child, generation, and next command ID. |
| `make-debugger-controller` | Creates a controller. |
| `close-debugger-controller controller` | Closes a controller and releases its leases. |
| `attach-debugger-stop handle controller` | Acquires exclusive control, including for a closed record. |
| `submit-debugger-command lease id operation &optional argument` | Accepts a new command or recognizes an identical accepted submission. |
| `debugger-command-result handle id` | Queries a recorded command without requiring control. |
| `release-debugger-stop lease` | Removes a closed stop and its command records. |

### Acceptance and execution

Command IDs start at zero and increase within each stop.  Acceptance occurs under the service mutex when the command is recorded, queued, and the next ID advances.  A transport reply can be lost after this transition.

A duplicate ID succeeds only when the operation is `EQ`, the argument is `EQL`, and the recorded command belongs to the current boot.  For a local-inspection command, argument identity means the same opaque frame reference.  A new frame-list command creates new references.  Duplicate recognition precedes the closed/busy checks but still requires a valid control lease.

A stop accepts one outstanding command.  A pending command, running command, or child stop causes new submissions to receive `:stop-busy`.  The accepted command may remain pending after its controller closes.  A returning restart leaves the stop active.  A restart that transfers control out of the debugger closes it.

| Command state | Meaning |
|---|---|
| `:pending` | Accepted and awaiting execution. |
| `:running` | Selected by the target thread. |
| `:returned` | The operation returned and its result was recorded. |
| `:unwound` | Control left command execution.  Application completion requires a separate observation. |
| `:cancelled` | The stop closed while the command was pending. |
| `:expired` | The command loop selected a queued command from an earlier boot. |

A failure during command execution can enter a child stop.  The parent command remains running, and new parent commands are rejected until the child resolves.  Client polling needs a deadline and a way to inspect child stops.  There is currently no remote command-cancellation operation.

The operation set is `:condition`, `:restarts`, `:frames`, `:locals`, and `:invoke-restart`.  Restart invocation supplies zero arguments.  The [protocol reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md#command-results) specifies result fields.

Values are printed on the stopped thread with `*print-readably* NIL`, `*print-circle* T`, `*print-level* 5`, and `*print-length* 20`.  User printers can allocate, block, signal conditions, or enter another stop.  Those bindings do not bound a custom printer's runtime or output.  Returned strings provide representations.  Object identity, browsing, and editing need a separate object-reference API.

### Disconnect and restore

Within one boot, an accepted command executes at most once under its recorded ID.  After reconnecting, a client reacquires control, queries that ID, and can repeat the identical submission.  Releasing the stop discards this record.

An image restore resumes the saved guest state and establishes a new boot event.  Old handles, controllers, leases, frames, and remote sessions expire.  A fresh session can discover a restored stop and read retained command history.  Each result reports whether its command belongs to the current boot.  A historical frame result can receive a new session token while its guest frame reference remains expired.

Restore tests cover a parked stop with a completed inspection command, a queued restart command, and a running restart command blocked on a Lisp event.  The queued command expires without executing after the target thread resumes.  The running command resumes its saved invocation, retains its prior-boot command identity, rejects resubmission, and records its result.  Other running-command positions and external I/O across restore remain untested.  Restoring an earlier image also restores an earlier command history.  At-most-once execution within a boot does not prevent repetition of external effects across image rollback.

## Retained evaluation

The [evaluation service](../system/evaluation-service.lisp) creates a guest worker for each named source submission.  It establishes retained debugging, reads and evaluates forms in order, and preserves the final form's multiple values.  The initial package is explicit, and package changes affect later forms within that job.  Each job starts with a fresh standard readtable.  Batch input is a supplied string followed by EOF.  `:interactive T` selects input that waits for supplied text or explicit EOF.

The worker binds its own standard streams.  Standard, error, and trace output share synchronized character storage.  Query, debug, and terminal I/O combine the job's input and retained output.  Output reads use character offsets and copy storage without consuming it.  Both job streams close when the job completes.  Input, output, and result objects remain until release, with no storage quota.

| Guest API | Meaning |
|---|---|
| `start-evaluation-job name source &key package input interactive` | Creates a batch job by default, or an interactive job when requested.  Package defaults to `"CL-USER"`, and input defaults to an empty string. |
| `evaluation-jobs` | Returns current-boot handles for unreleased jobs. |
| `evaluation-job-information handle` | Returns name, state, thread name, acceptance-boot comparison, active stop handles, printed values, and output length. |
| `evaluation-job-output handle start &optional end` | Returns copied output and the ending character offset.  The default end is the current length. |
| `supply-evaluation-input handle offset text &key eof` | Supplies or recognizes retained input and returns the ending character offset. |
| `interrupt-evaluation-job handle id` | Accepts or recognizes a numbered interruption request. |
| `evaluation-job-interrupt-result handle id` | Returns request state, acceptance-boot comparison, and cancellation reason. |
| `evaluation-job-result-values handle` | Returns a fresh list containing the retained Lisp values of a returned job. |
| `release-evaluation-job handle` | Releases terminal job data and retains the used name.  Active jobs reject release. |

Names are 64 lowercase hexadecimal digits generated by the client.  An identical submission in the same boot returns the existing job.  Another source, package object, initial input, or input mode under that name reports `:request-conflict`.  Earlier-boot submissions also reject replay.  Released names report `:released-job`.

Interactive jobs use a retained character-input stream and a supervisor event.  An exhausted read waits until more text or explicit EOF arrives.  Job information reports `:input-mode`, `:input-length`, `:input-eof-p`, and `:input-waiting-p`.  The waiting flag describes a pending input read.  Active debugger stops remain visible separately.

Input submission specifies a character offset, text, and optional EOF.  New text appends at the current accepted length.  A range that already matches retained input succeeds without appending, including after completion.  A gap, different text, or partial overlap reports `:input-conflict`.  EOF can accompany appended text or an empty append at the accepted end.  Repeating EOF requires an already recorded EOF at that same end.  Further appends after EOF, stream closure, or job completion report `:input-closed`.  Batch jobs reject input submission with `:input-not-interactive`.

Input growth and copying complete before the accepted length advances under the service mutex.  A connection can retry accepted text after a lost reply without supplying it twice.  Any attached session can supply input.  After restore, it acquires a fresh job token and reads the restored input length.  Input history remains in memory until job release.

A job remains `:running` while evaluating, waiting at a retained stop, or printing results.  The worker prints results inside retained debugging, so a printer condition remains recoverable.  Normal completion records `:returned`.  The job records `:aborted` when control reaches its ABORT restart clause after cleanup.  Cleanup can signal another retained condition or supersede that transfer.  A cleanup transfer back into the computation can let the job return normally.  Another exit from the worker records `:unwound`.  A terminal state distinguishes zero values from an incomplete result.

Job information associates stops by their target thread.  Stop ownership and release use the existing controller API.  Releasing a job leaves independently retained stop records under that API.

Guest tests cover batch input, output during a stop, source order, package changes, values, duplicate/conflicting submission, condition and printer recovery, GC, abort cleanup, and release.  SWANK job tests cover unread creation replies, duplicate submissions, session release during execution, fresh-session condition recovery, repeated output reads, foreign-token rejection, and release.  Restore tests cover a completed batch job and a condition-stopped batch job after partial input consumption, including preserved output, stream position, values, old-handle rejection, GC, continuation, and cleanup.  Interactive tests cover guest stream operations, disconnect, unread text and EOF replies, GC, and restore during a partial line read.

### Interruption

A numbered interrupt request uses the supervisor's existing thread foothold mechanism.  Delivery respects `without-footholds` and enters the retained debugger on the evaluation worker.  CONTINUE resumes the interrupted computation.  The job's ABORT restart follows normal Common Lisp unwinding and cleanup rules.

Interrupt IDs start at zero and increase per job.  The job retains their records until release.  Repeating an accepted ID in the same boot returns that ID without another delivery.  Prior-boot requests reject replay.  One request may be pending or running per job.  Job information reports `:next-interrupt-id` and the current `:interrupt-id`, or NIL.

| Interrupt state | Meaning |
|---|---|
| `:pending` | Accepted and awaiting delivery. |
| `:running` | The worker entered interruption handling.  Job information reports its stop once debugger entry registers it. |
| `:returned` | Control returned through CONTINUE. |
| `:unwound` | Control left interruption handling through a nonlocal exit.  The job outcome is separate. |
| `:cancelled` | Delivery found an existing retained stop or a completed job.  The result is `:already-stopped` or `:job-complete`. |
| `:expired` | Delivery selected a request accepted before the current boot. |

The worker arms delivery inside its stream bindings and ABORT restart, and disarms before leaving that restart's scope.  Early requests wait until it arms.  Completion cancels an undelivered request.  A target already inside a retained stop receives cancellation without another stop, including while it executes a debugger command.  Interruption of running debugger commands remains pending.

Any attached session can request interruption or read its history.  Stop commands retain exclusive controller ownership.  Request publication and scheduling use the service mutex with caller footholds inhibited.  A new request targeting its calling thread reports `:self-interrupt`.

Tests cover computing and input-waiting workers, full GC, locals, continuation, abort, cleanup conditions and nonlocal transfers, duplicate IDs, unread replies, existing stops, inhibited delivery, and immediate submission after creation.  The immediate-submission test does not establish which startup scheduling order occurred.  Restore tests cover a queued request expiring without delivery and a running interrupt stop resuming through a fresh session.  Other instruction positions and external I/O require further tests.

The x86-64 saved-interrupt scanner reads saved data registers as Lisp objects so that GC relocates their heap references.  A deterministic test holds a movable vector in each of R8, R9, R10, R11, R12, R13, R15, and RBX while an injected foothold waits across full GC.  Each register must match the relocated object when the interrupted function resumes.  R14 holds NIL.  A second test uses the existing single-step controls to stop at return-thunk entry and before IRET, with both full-save state and an additional foothold above it.  GC and normal resumption pass at those positions.  A Lisp-assembled GC restart-region test checks the raw saved instruction address and normal resumption in full-save state and beneath a foothold.  ARM64, intermediate return instructions, and individual allocation-routine positions require further tests.

## Compiler guarantees

The approved bootstrap policy is `(safety 3 debug 1 speed 1)` throughout cross-compiler initialization and image compilation.  The running compiler defaults to `(safety 3 debug 3 speed 1)`.  Bootstrap inspection remains subject to its compilation policy.

At debug level 3, [pass 1](../compiler/pass1.lisp) marks introduced lexical bindings for preservation.  AST copying retains the mark.  Optimizer and SSA transformations respect it.  Backend lowering uses dedicated debug-variable registers, and [register allocation](../compiler/backend/register-allocation.lisp) preserves their locations and debug liveness.  Captured preserved bindings share one environment cell between the defining function and its closures.

A binding follows the policy at its introduction.  A local debug-3 declaration retains it inside a function compiled at debug levels 0, 1, or 2.  Entering a lower-debug region afterward does not remove that preservation.  Tests cover copies, constants, unused bindings, shadowing, parameters, multiple-value bindings, loops, captured bindings, writes, and full GC in the inspected activation.

These results concern compiled Lisp functions exercised by the tests.  They do not establish complete logical-frame reconstruction for inlining, tail calls, every calling convention, or every architecture.  Current local records describe names, locations, and representations.  Public mutation and lexical evaluation still require binding identities, scopes, and applicable type information.

The [Common Lisp type declaration rules](https://www.lispworks.com/documentation/HyperSpec/Body/d_type.htm) constrain references and assignments within declaration scopes.  A type recorded only at binding introduction cannot describe every nested constraint.  The internal frame writer is exercised by tests, but the retained service exposes no public write operation.

## Capability and evidence

The operation inventory uses the debugger chapters of Symbolics' [Program Development Utilities](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Program-Development-Utilities.pdf), sections 5.3–5.6, printed pages 194–245.  The rows group operations by implementation requirement.  They describe progress toward the requested debugger semantics.  Exact command syntax and interface compatibility remain separate decisions.

“Implemented” below applies to the explicit condition-stop service on tested x86-64 Lisp code.  “Partial” identifies usable primitives or internal tests whose scope falls short of the intended operation.  “Pending” identifies work without a retained-service API.

| Operation | Status and prerequisites | Evidence or outstanding test |
|---|---|---|
| Condition entry and nested debugging | Implemented through the wrapper.  Default installation is pending. | Service test: background failure and nested printer failure. |
| Backtrace, frame selection, and search | Partial: ordered frames and function representations.  Selection and search can use the returned list. | Service and reconnect tests.  Logical frames and additional code classes need tests. |
| Arguments and locals | Partial: preserved bindings are readable.  Separate original/current argument records and complete argument recovery are pending. | Binding, closure, policy, and frame-local tests. |
| Lexical environment and evaluation | Pending: scope identities, shadowing, local functions/macros, and evaluation context. | No retained-service test. |
| Argument/local modification | Partial: internal writes tested.  Public API needs scope/type validation and lifetime-safe binding references. | Binding-write, closure-write, and policy tests. |
| Special bindings and dynamic evaluation | Pending: selected-frame dynamic context and binding history. | No retained-service test. |
| Catch blocks and condition handlers | Pending: frame-associated enumeration and validated references. | No retained-service test. |
| Restart options, proceed, and abort | Partial: lists applicable restarts and invokes zero-argument restarts.  Argument-taking and interactive restart APIs are pending. | Service, SLDB, and reconnect tests. |
| Return values and forced frame return | Pending: frame exit, multiple values, cleanup, dynamic bindings, and GC rules. | Existing restart tests do not test arbitrary frame return. |
| Reinvoke and function replacement | Pending: invocation state, argument semantics, and replacement compatibility. | Function repair through an existing restart is tested.  Arbitrary frame reinvocation is untested. |
| Nonlocal throw | Pending: live target identity and cleanup semantics. | No public throw operation. |
| Call/exit traps and combined resume operations | Pending: compiler/runtime stop points and saved values. | No retained-service test. |
| Breakpoint installation, removal, and listing | Pending: trap entry, instruction ownership, resumption, and concurrent execution. | No retained-service test. |
| Instruction stepping and instruction display | Partial: existing low-level debugger primitives.  Integration with retained stops is pending. | No integrated stepping test. |
| Source stepping and frame analysis | Pending: expression positions, executable ranges, and source versions. | Existing function-level source information is insufficient. |
| Disassembly, source display, and editing | Partial: existing Lisp/editor facilities.  Precise association with the executing function version is pending. | No retained-service integration test. |
| Variable/location monitoring | Pending: access semantics, architecture support, and interaction with GC. | No retained-service test. |
| Object inspection, description, and instance context | Partial: printed values.  Identity-preserving object operations are pending. | Printer failure tested.  Object browsing and mutation are untested. |
| Raw stack and debugger settings | Pending: privileged inspection, supported stack changes, and per-session settings. | No retained-service test. |
| Condition tracing and abort controls | Pending: entry policy and interaction with handlers and nested stops. | No retained-service test. |
| Help, reports, and display integration | Pending: client interface and capture of diagnostic state. | The current interface is a Lisp client library. |
| Reconnection and lost replies | Implemented within one boot and retained command history. | Reconnect test leaves accepted-command replies unread and checks one execution. |
| Image restore | Partial: parked stop, completed-command history, queued-command expiration, and a running command blocked on a Lisp event. | Guest and remote restore tests.  Other running-command positions and external I/O remain untested. |
| Retained evaluation and I/O | Partial: batch and interactive jobs, retained results/output, condition stops, and numbered asynchronous interruption.  Running debugger-command interruption is pending. | Guest, network, and saved-image evaluation tests.  Restore at other execution positions remains untested. |
| GUI-free startup | Pending: a build profile and initialization paths that omit graphics and GUI components. | Cold boot and restore with graphics devices absent remain untested. |
| Startup failure handling | Pending: preserve recoverable failures before unwind, report required-service readiness, and provide bounded early diagnostics. | The journal records error-swallowing startup paths.  Failure tests remain unrun. |
| QEMU host control | Pending: image selection, QMP/GDB access, and boot diagnostics independent of guest networking.  Bare-metal FEP work is deferred. | Current launchers configure SWANK forwarding and serial output. |

### Test scope and provenance

Test sources are in [the SWANK tools directory](../tools/swank/).  The [operations guide](../tools/swank/minideb2/README.md#tests) owns their commands and sequencing.

| Test source | Scope |
|---|---|
| `test-lispm-eval.py` | Evaluation, encoding, output, multiple values, errors, flow control, and timeout behavior. |
| `test-structure-layouts.lisp` | Inherited structure predicates/access and redefinition. |
| `test-foothold-gc.lisp` | Movable objects in eight x86-64 data registers across an injected foothold and full GC. |
| `test-interrupt-return-gc.lisp` | GC and resumption at x86-64 interrupt-return entry and IRET, in full-save state and beneath another foothold. |
| `test-gc-restart.lisp` | Raw instruction-address rewriting and resumption for an x86-64 GC restart region, in full-save state and beneath a foothold. |
| `test-frame-locals.lisp` | Distinct SWANK local IDs and lookup. |
| `test-debugger.lisp` | SLDB inspection, function repair, restart values, concurrent evaluation, and cleanup on one connection. |
| `test-debug-bindings.lisp` | Preserved binding visibility and lower-debug propagation. |
| `test-debug-binding-writes.lisp` | Internal writes, independent copies, constants, loops, multiple-value bindings, and GC. |
| `test-debug-write-flow.lisp` | Type-changing internal writes after arithmetic, type, identity, and vector tests at debug 3 and safety 3. |
| `test-debug-closure-writes.lisp` | Shared captured bindings, parameter forms, escaped closures, and GC. |
| `test-debug-policy.lisp` | Local debug declarations, preserved heap roots, writes, and GC. |
| `test-keyword-lowering.lisp` | Keyword semantics and allocation at debug levels 1 and 3. |
| `test-jump-table-bindings.lisp` | Branch binding cleanup and invalid selectors. |
| `test-debugger-service.lisp` | Ownership, frames, GC, duplicate commands, child stops, repair, values, release, and cleanup. |
| `test-debugger-service-restore.lisp` | Guest handles, completed-command history, queued-command expiration, and a running restart blocked on a Lisp event across restore. |
| `test-evaluation-service.lisp` | Batch submission identity, source order, package changes, values, condition/printer recovery, GC, abort, release, and interactive stream behavior. |
| `test-evaluation-interrupt.lisp` | Computing/input-waiting interruption, locals, GC, continuation, abort, cleanup conditions/transfers, duplicate requests, existing stops, startup, inhibited delivery, and self-interruption rejection. |
| `test-evaluation-reconnect.lisp` | Unread creation reply, duplicate submission, session release during execution, fresh-session condition recovery, output/results, foreign tokens, GC, cleanup, release, completed/stopped batch jobs across restore, interactive disconnect, input/EOF replay, interactive restore, unread interrupt replies, and queued/running interrupt restore. |
| `test-debugger-reconnect.lisp` | TCP disconnect, exclusive control, token rejection, unread replies, and duplicate restart submission. |
| `test-debugger-remote-restore.lisp` | Saved/absent sessions, old tokens/frames, storage retirement, and restored-stop recovery. |

Mezzano `6edf42a5` and the Slime implementation listed above passed a fresh full recompilation and CI boot on 2026-10-12.  The CI image reached desktop initialization and exited QEMU with status 3.  Logs are `debugger-current-build.log`, `debugger-current-boot.log`, and `debugger-current-serial.log` in the MBuild directory.  The journal records live tests, restore tests, and failed attempts.  ARM64, bare metal, supervisor traps, and arbitrary suspension points remain outside this evidence.

Mezzano `0381885f`, including the batch service, subsequently passed a fresh full recompilation and CI boot.  Its logs are `evaluation-current-build.log`, `evaluation-current-boot.log`, and `evaluation-current-serial.log`.  The batch user-guide example passed in `evaluation-guide-example.log`.

The interactive-input implementation passed a fresh full recompilation and CI boot.  Logs are `interactive-final-build.log`, `interactive-final-boot.log`, and `interactive-final-serial.log`.  Guest, reconnect, and partial-line restore tests passed against that source.  The journal records their commands and logs.

The interruption implementation and saved-data-register GC correction passed a fresh full recompilation and CI boot.  QEMU exited with status 3 and the serial success marker.  Logs are `interrupt-gc-corrected-build.log`, `interrupt-gc-corrected-boot.log`, and `interrupt-gc-corrected-serial.log`.

Mezzano `5c7ee5bc` includes the saved-register, interrupt-return, and GC restart-address corrections.  It passed a fresh full recompilation and CI boot.  QEMU exited with status 3 and the serial success marker.  Logs are `gc-restart-build.log`, `gc-restart-boot.log`, and `gc-restart-serial.log`.  The targeted tests cover the x86-64 states listed above.  Individual allocator instruction positions and ARM64 execution remain untested.

## Decisions and development sequence

The next design work concerns interrupt-scanner edge cases and type/scope metadata.  Restore coverage needs further tests for running commands at other instruction positions and external I/O.  Public binding mutation follows that metadata.  Lexical evaluation, frame return/reinvocation, trap entry, and stepping require their own semantics and tests before exposure through SWANK.

The approved reinvocation defaults use the frame's current argument values and, for a globally named function, its latest definition.  Original arguments will be available through an explicit option.  Invocation metadata, original argument storage, cleanup, and dynamic-binding behavior still require implementation and tests.

The approved evaluation model lets remote evaluations continue after disconnection and retains their results until explicit release.  An explicitly interactive evaluation waits for input or an explicit EOF, and reconnection restores access to its input stream.  A batch evaluation consumes supplied input and then receives EOF.  The guest batch service implements retained jobs and supplied-input EOF.  SWANK transports batch and interactive operations.  Interactive input waits across disconnect and has a tested restore case.

Breakpoint and stepping work must specify stop locations, interaction with GC and other threads, and the distinction between instruction and source operations.  Review and document each decision under the [standing procedure](../AGENTS.md) before implementing it.

Each implementation increment updates this document's guarantees, capability status, and test scope.  API changes update the protocol reference.  User-visible changes update the guide, and operational changes update the build instructions.  The journal records the decision, implementation revision, test commands, results, and unresolved failures.  A claimed capability includes its code class and entry mode as well as its test.
