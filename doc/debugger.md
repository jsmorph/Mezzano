# Debugger specification and evaluation reference

The retained debugger keeps a stopped Lisp computation in the guest while a remote client inspects its condition, frames, and local variables or invokes a restart.  Evaluation jobs retain input, output, and results across connection loss.  The guest owns both services.

The [remote client guide](../tools/swank/README.md) provides executable examples.  The [SWANK API reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) defines remote request and result formats.  The [Web Listener and Debugger](../tools/swank/web/README.md) provides a browser interface.  [Installation and operation](installation.md) describes startup, networking, and snapshots.

The implemented-service guarantees apply to x86-64 compiled Lisp functions that enter the retained service through condition handling or evaluation-job interruption.  They do not establish support for other architectures, supervisor traps, or arbitrary suspension points.

## Compatibility specification

The target is the user-visible debugger behavior in Symbolics' [Program Development Utilities, chapter 5](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Program-Development-Utilities.pdf#page=191).  The [command summary](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Program-Development-Utilities.pdf#page=246) supplies the command inventory.  Mezzano and browser differences require explicit documentation and tests.  The target includes command syntax, argument defaults, prompts, completion, help, state changes, control transfers, and equivalent keyboard and mouse operations.

This section specifies the approved development agenda.  The reference sections below describe the implemented service.  A planned command acquires supported status only after its guest implementation, transport, browser interaction, documentation, and stated tests pass.

### Execution and interaction requirements

Guest Lisp owns debugger entry, nesting, current frame, command parsing, evaluation, restart selection, and execution.  Python transports requests.  The browser renders guest state and translates input.  Command names, completion, and help come from the guest command definitions.

The owning Listener enters debugger interaction when its evaluation stops.  It displays the nesting level and directs input to the innermost stop in that evaluation.  Other Listeners retain their own input contexts.  The standalone Debugger displays the same guest operations.  Ordinary Listener input and each debugger level retain their drafts and cursor positions.  Returning from a level restores the preceding interaction.

Each debugger operation establishes an abort boundary.  An error during that operation can enter a child debugger.  The command's ABORT restart abandons that operation and returns to the enclosing debugger.  The original computation remains stopped.  The original stop retains its captured restart objects, so a subsequent abort of that stop can leave the evaluation.  Cleanup follows Lisp control-transfer rules and can itself signal another condition.

Restart invocation accepts explicit Lisp argument expressions or calls the restart's interactive argument reader.  See the Common Lisp definitions of [INVOKE-RESTART](https://www.lispworks.com/documentation/HyperSpec/Body/f_invo_1.htm) and [INVOKE-RESTART-INTERACTIVELY](https://www.lispworks.com/documentation/HyperSpec/Body/f_invo_2.htm).  A restart can return values while its stop remains active or transfer control out of the stop.  Command results and evaluation state must distinguish those outcomes.  Mezzano's default Proceed selects the first captured restart named CL:CONTINUE and invokes it interactively.  When no CONTINUE exists, the command requires an explicit restart choice.  Genera distinguishes proceed handlers from restart handlers.  Common Lisp restart objects have no corresponding classification, so this mapping differs from Genera's default-selection rule.

Evaluation in a frame must use its live lexical bindings, including shadowing, local functions, symbol macros, and shared closure cells.  Assignment changes the binding used by resumed computation.  Compiler metadata must describe scope, representation, locations, and unavailable values.  Code compiled under a reduced debugging policy must report its supported operations.  The supported debug policy must preserve the information promised by this reference.

Object inspection retains object identity and permits navigation and mutation with explicit lifetimes.  Source and compiled-code views identify the executing function version.  Redefining a function preserves the identity of an older active definition.  Argument inspection distinguishes original arguments from current argument values where the command requires them.

Frame return, reinvocation, and THROW must preserve multiple values, dynamic bindings, cleanup, and the caller's continuation.  Reinvocation uses the selected function's current definition and the specified argument policy.  Breakpoint and stepping operations require defined behavior under redefinition, GC, concurrent execution, and removal.  Monitoring must identify which accesses it observes.

A debugger operation that prints, evaluates, reads input, or invokes application code can fail or block.  The user must be able to interrupt a running debugger operation and recover through nested debugging.  The supported interruption points and deferred-delivery cases require tests.  A stopped thread retains application locks.  Shared objects can change in other threads.

Accepted operations retain their identity across transport loss.  Reconnection discovers their results and the current stop without repeating accepted effects.  Stop exit, release, and image restoration validate frame and object references before access.  Process interruption, background-thread failure, and headless startup failure need defined debugger entry and recovery.  Bare-metal FEP work remains deferred.

### Command inventory

Each row groups commands from the manual for tracking.  Partial means that the current Web service implements a narrower operation.  Planned means that the complete guest-to-browser operation remains work.  Existing internal primitives require separate integration and tests.

| Area | Commands | Current status |
|---|---|---|
| Recovery | Abort; Proceed; Disable Aborts; Enable Aborts | Abort and Proceed are implemented.  Abort disabling remains planned. |
| Help and display | Help; Display Debugger | Help lists implemented commands.  Display Debugger command remains planned.  Separate Web view exists. |
| Frame movement | Top Of Stack; Bottom Of Stack; Next Frame; Previous Frame; Find Frame; Set Current Frame | Top, Bottom, Next, Previous, and Set Current Frame support guest-owned selection and available locals.  Find Frame, filtering, and detailed display options remain planned. |
| Frame inspection | Show Backtrace; Show Frame; Show Function; Show Arglist; Show Argument; Show Rest Argument; Show Local; Show Stack; Show Value | Show Arglist displays the selected compiled function's lambda list.  Backtrace, frame, and local inspection are partial.  Remaining commands planned. |
| Evaluation | Lisp forms in the selected frame | Implements live bindings, writes, and per-level history through ordinary debugger form input.  Tested in x86-64 compiled condition stops and Chromium. |
| Environment | Show Bindings; Show Catch Blocks; Show Condition Handlers; Show Lexical Environment; Show Special; Show Standard Value Warnings; Use Dynamic Environment; Use Lexical Environment | Show Bindings, Show Catch Blocks, and Show Condition Handlers inspect established x86-64 frames.  Remaining commands planned. |
| Recovery choices | Show Proceed Options | Partial: lists captured restart names and reports, marking the default CONTINUE. |
| Objects | Describe Last; Symeval In Last Instance | Describe Last and retained Inspector navigation and modification passed native x86-64, SWANK, and Chromium tests.  Symeval remains planned. |
| Source and code | Analyze Frame; Show Source Code; Show Compiled Code; Show Instruction | Planned. |
| Frame execution | Reinvoke; Return; Throw | Planned. |
| Call and exit traps | Set Trap On Call; Clear Trap On Call; Proceed Trap On Call; Restart Trap On Call; Set Trap On Exit; Clear Trap On Exit | Planned. |
| Conditions and monitoring | Enable Condition Tracing; Disable Condition Tracing; Monitor Variable; Unmonitor Variable; Show Monitored Locations | Planned. |
| Breakpoints and stepping | Set Breakpoint; Clear Breakpoint; Clear All Breakpoints; Show Breakpoints; Single Step | Planned.  TRACE :BREAK demonstrates a separate function-entry stop. |
| System integration | Edit Function; Mail Bug Report; Set Stack Size | Pending explicit Mezzano mappings. |

The command reference must expand each entry with its supported arguments, omitted and mentioned defaults, selection rules, prompts, confirmation behavior, errors, and tests.  Genera keyboard accelerators need a documented browser mapping.  Editor, mail, instance-model, and stack-layout differences remain open scope decisions.  They remain in this inventory until implemented or explicitly excluded.

### Delivery plan and acceptance

Implementation proceeds in bounded increments, with compilation and tests in Mezzano, headless Chromium interaction, documentation updates, review, commits, and pushes.  The sequence below orders dependencies and preserves the full remaining scope.

- [x] Establish per-command abort boundaries.  Add typed Abort and Help, exact Listener ownership/nesting, completion, prompt restoration, and equivalent button actions.
- [x] Implement interactive restart invocation, default Proceed selection, restart reports, and normal-return versus nonlocal-exit results.
- [x] Add explicit Lisp argument expressions for restart invocation.
- [x] Complete interruption of debugger operations and correct frame capture for interrupted frameless functions.  Validate caller locals, moving GC, nested interruption, and input recovery in the browser before extending frame evaluation.  Register-local inspection remains separate work.
- [x] Add guest-owned frame selection and navigation.
- [ ] Preserve lexical environments and binding identities through compiler transformations, mapping them to instruction-specific storage for frame evaluation.
- [x] Add live frame evaluation and writes, per-level evaluation history, and frame-environment lifetime checks.  Accepted on x86-64 compiled condition stops, including parked-stop restoration and Web interaction.
- [x] Add retained object inspection and mutation with explicit reference lifetimes.  Accepted on x86-64 compiled condition stops, including parked-stop restoration and Web interaction.
- [ ] Complete environment and source inspection, original/current argument handling, selected-frame control transfers, compiled breakpoints, stepping, call/exit traps, and monitoring.
- [ ] Integrate background failures, process interruption, startup recovery, and the remaining system commands.
- [ ] Complete the command inventory, product guide, compatibility reference, Document Examiner topics, and architecture-specific acceptance results.

Compiler preparation preserves lexical environments through first-pass expansion and AST copying.  Each variable or local-function read has an individual reference, and copying remaps its binding identity.  Tests cover propagated values and selected source scopes through AST optimization, inlining, and closure lowering.  Backend instructions carry source environments through conversion and tested instruction rewrites and register allocation.  Compiled location and closure records distinguish binding identities, including same-name bindings and shared captured cells.  The assembler and runtime support an instruction-address scope table.  Native scope conversion retains visible binding descriptors, declarations, macro expanders, and control-scope identities in ordinary Lisp records.  Both code generators emit converted scopes at instruction addresses.  Native x86-64 tests resolve nested and disjoint scopes from live call addresses and match their descriptors to storage records.  Target macro constants compile retained definitions through the existing file writer.  Native serialization tests cover their identity, initial state, defining environments, and retry after compilation failure.  Complete compiler scope coverage remains work.  The frame-evaluation operation below uses these scope and storage records.  Host cross-build and ARM64 execution acceptance remain untested.

The first browser sequence passes: stop an evaluation, cause an error in a debugger operation, type :Abort in the child, inspect the still-stopped parent, continue the original evaluation, and verify its result and cleanup.  Tests also cover parent draft restoration across reload, default and indexed Proceed, missing-default rejection followed by explicit selection, interactive argument input, and normally returning restarts.

Additional acceptance cases include interactive replacement values, arguments with required parameters, normally returning restarts, mutations observed after continuation, shared closure bindings, nested scopes, local functions, multiple values, cleanup conditions and superseding transfers, redefinition, GC, and supported optimization policies.  Breakpoint tests cover repeated hits, concurrent callers, conditions/actions, removal, and continuation.  Interruption tests cover computation, input waits, printers, and pending delivery.

Browser tests must exercise command entry, completion, contextual help, mouse actions, draft/focus restoration, multiple Listeners, recursive errors, and successful ordinary input after recovery.  Lost replies, reloads, disconnection, stale references, and supported image-restoration states must preserve the stated execution rules.  Tests use owned fixtures and preserve unrelated user evaluations.

A completed capability requires its specified semantics and tests to pass on the stated architecture, compilation policy, and stopping states.  Source inspection, compiled implementation, guest tests, browser tests, and restore tests are distinct evidence.  The development journal records failures, results, and revisions.  Remaining items retain their unchecked status.

### Product documentation

The user guide will contain executable sessions for finding an error, inspecting and changing state, continuing, aborting nested operations, redefining and reinvoking a function, using breakpoints, and recovering after connection loss.  The command reference will give exact syntax and behavior.  The implementation reference will specify compiler guarantees, stopping states, ownership, object lifetimes, and transport behavior.

Document Examiner will display these checked-in documents.  Interactive help will use guest command definitions.  Product documentation will describe supported behavior and explicit differences.  Research notes and chronological evidence belong in the development journal.

## Object inspection

Each debugger stop retains inspected objects by EQ identity.  `:Inspect` displays the primary value from that stop's evaluation history.  Evaluating a local variable and then entering `:Inspect` opens its value.  `:Describe Last` calls DESCRIBE on that value without changing the history.  `:Clear Inspector` releases that stop's inspection references.

Inspection returns a page of printed components and opaque references to their values and writable places.  A bound NIL has a value reference.  An unbound slot has no value reference and can still have a writable place.  Repeated navigation to an EQ object returns the same object reference within a stop and boot.  Shared and cyclic objects preserve their identity.  Each component observation creates its own place reference.

| Object | Components | Writable places |
|---|---|---|
| Cons | CAR and CDR | Both cells |
| Array | Row-major elements, including elements beyond a fill pointer | Elements, subject to array element type |
| Symbol | Name, package, value, function or macro, and plist | Value, ordinary function cell, and plist.  Constant values and macro/special-operator function cells are read-only. |
| Hash table | Alternating key and value rows in table iteration order | Existing values, identified by the retained key |
| CLOS instance | Effective slots, including unbound slots | Slots, subject to declared type |
| Structure | Slots, with each fixed-vector element shown separately | Slots and fixed-vector elements, except read-only fields |
| Other objects | Printed value and type | No component places |

Modify reads a replacement expression through QUERY-IO and evaluates it in the selected frame using the same lexical environment and history as ordinary debugger evaluation.  It stores the primary value, or NIL for zero values, then inspects the containing object again.  A successful expression updates evaluation history even when the subsequent store or printer fails.  A completed store remains effective after a printing failure.  Repeating the accepted command ID retrieves its recorded outcome.

Reader evaluation is disabled while reading the expression.  Reader, evaluation, type, and printer errors can enter a child debugger.  `:Abort` returns to the parent.  When a read unwinds, cleanup clears any input already buffered on QUERY-IO.  The retained input record and its offsets remain available for replay.  The next read waits for fresh input.

Page sizes range from 1 through 64, defaulting to 32.  Positions are zero-based, and the end position is exclusive.  Refreshing after a container shrinks clamps the start to its current total.  A write rejects an out-of-range array index, removed hash key, changed class, or replaced effective slot.  Ordinary Lisp accessors check storage representation and declared types.  Shared objects can change in other threads.  Accessors retain their normal locking behavior.

Clear and stop exit empty the inspection retention tables.  Clear preserves the increasing ID counter, so an old reference cannot name a newly retained value.  Evaluation history and application bindings can retain the same objects independently.  Old references expire on image restoration.  Native x86-64 tests cover restoring a parked condition stop with retained pages and writable components: historical results remain readable, old references and command replay expire, fresh references preserve object identity through GC, and Modify and Proceed succeed.  Restoration during an executing Inspector command remains untested.

The current Inspector attaches to an active debugger stop.  Standalone inspection, compiled-function internals, and Genera locatives remain planned.  The [SWANK API reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) specifies page fields, token types, and errors.

## Architecture and ownership

A stop retains the condition, applicable restart objects, captured frames, and the target thread's dynamic environment.  The target thread waits in a command loop and executes inspection, printing, and restart functions.  Other threads continue running.

The SWANK contrib owns sessions, connection associations, and token tables.  The host client creates session names, transports requests, and decodes replies.  Closing a connection releases control through SWANK's connection-closed hook.  It leaves the stop and accepted commands in the guest service.

Entry is explicit:

```lisp
(mezzano.debug:call-with-debugger-service function)
```

The wrapper binds the condition debugger hooks for the function's dynamic extent.  A background thread needs its own wrapper.  The retained evaluation API establishes the wrapper in each worker.  Ordinary SWANK evaluation uses SLDB.

A service mutex protects the registry, ownership, command acceptance, and results.  Commands that inspect frames, print objects, or invoke restarts execute outside that mutex on the stopped thread.  Registry operations inhibit footholds while holding the mutex and re-signal errors after releasing it.

A stopped thread retains any application locks it holds.  Another thread can change shared objects reachable through its locals.  A stop therefore preserves an activation without freezing the heap.  An inspection that depends on another held lock can block.  The service does not resolve application deadlocks.

Method changes and dispatch-cache construction use one mutex per generic function.  A concurrent invocation may finish a method selected before replacement.  A cache miss waits for an in-progress replacement to finish.  Ordinary dispatch releases its lookup mutex before invoking the selected method.  Applicability and method-combination callbacks can replace a method on the same generic function.  An in-progress call may complete its selected old method, while subsequent calls use the replacement.  A stop inside a method-update or lookup MOP callback retains its enclosing mutex, so another thread's cache miss on the same generic function can wait for that stop to proceed.  This synchronization covers calls overlapping method changes on one generic function.  Class-layout changes and shared metadata affected by concurrent updates to different generic functions require separate synchronization.

## Stop and command lifetimes

### Handles and control

Guest handles are opaque Lisp objects.  Stop handles and controllers carry the boot-event object from the supervisor.  Validation compares that object with the current boot event using `EQ`.  Numeric stop IDs describe records.  The service validates handles before accessing retained frames.

| Object | Lifetime and authority |
|---|---|
| Stop record | Registered on debugger entry.  State is `:stopped`, then `:closed` when control leaves the service.  Explicit release removes a closed record. |
| Stop handle | Identifies a registered record in one boot.  A closed record remains queryable. |
| Controller | Groups control leases.  Closing it releases ownership of its stops. |
| Control lease | Grants one controller exclusive command submission and closed-stop release.  Closing the controller invalidates its leases. |
| Frame reference | Identifies one frame in one stop generation.  It expires on stop exit or boot change. |
| Command record | Retains acceptance, state, operation, boot identity, and result until explicit stop release. |
| Remote session | Associates a client name and token table with one guest boot.  Reconnection creates a new controller. |

Frame capture excludes the retained service's command loop and stack-walking calls, beginning with the caller of SERVICE-DEBUGGER and continuing toward older callers.  Closing a stop increments its generation and clears live condition, frame, and restart references.  A child retains its parent's descriptive ID after parent release, but information returns a parent handle only while the parent remains registered.

The public functions are exported from `MEZZANO.DEBUG`:

| Function | Purpose |
|---|---|
| `call-with-debugger-service function` | Establishes condition-stop entry for a dynamic extent. |
| `debugger-stops &key include-closed` | Returns current-boot handles for registered stops. |
| `debugger-stop-information handle` | Returns identity, state, thread display label, parent/child, generation, current frame index, and next command ID. |
| `make-debugger-controller` | Creates a controller. |
| `close-debugger-controller controller` | Closes a controller and releases its leases. |
| `attach-debugger-stop handle controller` | Acquires exclusive control, including for a closed record. |
| `submit-debugger-command lease id operation &optional argument` | Accepts a new command or recognizes an identical accepted submission. |
| `debugger-command-result handle id` | Queries a recorded command without requiring control. |
| `release-debugger-stop lease` | Removes a closed stop and its command records. |

The `:thread` field in stop and evaluation-job information is a display string of at most 160 characters.  Its formatter accepts bounded primitive names without invoking user printers.  ASCII control characters become spaces, unsupported objects appear as `[object]`, and truncated names end with `[truncated]`.  [Peek](peek.md) uses the same label rules.

### Current frame

Each stop owns a zero-based current-frame index, initially zero.  Increasing indices lead toward older callers.  A child debugger has its own index.  Closing a controller leaves selection intact.  Closing the stop clears it to NIL.

:CURRENT-FRAME returns the selected index, printed function, and available local records.  :SELECT-FRAME takes an absolute index.  :NEXT-FRAME and :PREVIOUS-FRAME take a nonnegative count.  :TOP-FRAME and :BOTTOM-FRAME select the newest and oldest retained frames.  Each movement returns the same inspection result.  A zero count inspects the current frame.  An invalid count or target reports :INVALID-FRAME before acceptance, preserving selection and the next command ID.

The stopped thread changes selection before printing the frame.  A printer error can enter a child debugger.  Aborting that command preserves the parent's selected index.  Accepted relative movement uses ordinary command replay and executes once.  Selection survives image restoration, while old handles and prior-boot command replay expire under the existing rules.

The separate :LOCALS operation inspects an opaque frame reference without changing selection.  Selected-frame inspection reports the current available lexical values.  Original argument values, frame filtering, and detailed disassembly remain unavailable through these commands.

`:Show Arglist` prints the lambda list stored with the selected frame's executing compiled function.  It preserves frame selection and evaluation history.  Redefining the function's name leaves the active frame's reported lambda list unchanged.  A function with no parameters reports NIL.  A frame without lambda-list metadata reports that the argument list is unavailable.  The command uses the same bounded printer as other debugger values.  It reports parameter syntax.  Dedicated argument-value commands remain planned.

### Special bindings

`:Show Bindings` prints the special bindings established by the selected frame.  `:All` includes all retained frames, from newer to older.  Its omitted default is No, and its mentioned default is Yes.  `:Matching "text"` restricts output to symbol names containing that case-sensitive literal substring.  The default empty string matches every name.  Unbound cells print `[unbound]`, distinct from a bound NIL.  Repeated bindings within a frame appear from inner to outer, including shadowed values.  A binding established by a runtime function such as PROGV appears under that runtime frame.

The command reads the existing live binding cells on the stopped thread and preserves frame selection and expression/value history.  It copies each frame's observations before invoking printers.  A printer condition enters a child debugger.  Abort there returns to the original stop.  The command supports established x86-64 condition-stop frames.  Unsupported frame layouts, including direct interrupted activations, report that binding locations are unavailable.  ARM64 binding inspection and Genera's frame-visibility filtering remain unsupported.  Selecting an older frame does not change the dynamic environment used for evaluation.

The retained operation `:bindings` accepts NIL for the selected frame with no filter, or `(all-p matching-string)`, where all-p is NIL or T.  Acceptance copies the string and rejects malformed options with `:invalid-binding-options` without consuming a command ID.  Its result is a formatted string.  With `:All`, empty matching frames are omitted.  Unsupported frames retain an explicit unavailable entry.

### Catch blocks

`:Show Catch Blocks` prints the active catch records established by the selected frame.  `:All` selects all retained frames, omitting frames with no catches.  Its omitted default is No, and its mentioned default is Yes.  Repeated tags retain inner-to-outer order.

Each available destination gives the compiled function name and a hexadecimal byte offset from the function object's start.  Code starts at offset 16.  Mezzano implements CATCH through the runtime %CATCH function: THROW enters that function's nonlocal exit destination, and %CATCH returns the supplied values to its caller.  The display reports that runtime destination.  It preserves the executing function version through GC and redefinition.

The command copies live observations on the stopped thread before printing and preserves frame selection and expression/value history.  A tag printer condition enters a child debugger.  Abort there abandons the command and returns to the original stop.  Established x86-64 condition-stop frames are supported.  Interrupted frames and ARM64 report unavailable catch locations.  Earlier compiled closure layouts with missing control identities preserve the tag and report Destination unavailable.

The retained operation `:catches` accepts NIL for the selected frame or T for all frames and returns one formatted string.  Invalid options report `:invalid-catch-options` before acceptance.  Replay compares the Boolean argument with EQL.

### Condition handlers

`:Show Condition Handlers` prints the handlers established by the selected frame.  `:All` selects all retained frames, omitting frames with no handlers.  Its omitted default is No, and its mentioned default is Yes.  Each row gives a condition type, handler function, and active or inactive state in the program at debugger entry.  A handler may belong to a runtime %HANDLER-BIND frame.

Handlers established together form a cluster.  When SIGNAL invokes one handler, every handler in that cluster becomes inactive for that signaling process.  The display distinguishes that temporary change from a new cluster.  A break within the selected handler therefore reports its cluster as inactive while showing still-active older clusters.

The command reads the existing live binding records on the stopped thread and preserves frame selection and expression/value history.  It copies observations before printing.  Printer conditions enter a child debugger.  Abort there abandons the inspection and returns to the original stop.  Established x86-64 frames are supported.  Unsupported layouts report unavailable handler locations.  ARM64 reports unavailable handler locations.

The retained operation `:handlers` accepts NIL for the selected frame or T for all frames and returns one formatted string.  Invalid options report `:invalid-handler-options` before acceptance, preserving the next command ID.  Accepted replay compares the Boolean argument with EQL.

### Acceptance and execution

Command IDs start at zero and increase within each stop.  Acceptance occurs under the service mutex when the command is recorded, queued, and the next ID advances.  A transport reply can be lost after this transition.

A duplicate ID succeeds only when the operation is `EQ`, the argument matches, and the recorded command belongs to the current boot.  Evaluation compares source strings with `EQUAL`.  Inspect, Modify, and Bindings compare copied argument lists with `EQUAL`; other operations compare arguments with `EQL`.  For a local-inspection command, argument identity means the same opaque frame reference.  A new frame-list command creates new references.  Duplicate recognition precedes the closed/busy checks but still requires a valid control lease.

A stop accepts one outstanding command.  A pending command, running command, or child stop causes new submissions to receive `:stop-busy`.  The accepted command may remain pending after its controller closes.  A returning restart leaves the stop active.  A restart that transfers control out of the debugger closes it.

| Command state | Meaning |
|---|---|
| `:pending` | Accepted and awaiting execution. |
| `:running` | Selected by the target thread. |
| `:returned` | The operation returned and its result was recorded. |
| `:unwound` | Control left command execution.  Application completion requires a separate observation. |
| `:cancelled` | The stop closed while the command was pending. |
| `:expired` | The command loop selected a queued command from an earlier boot. |

Each command binds the condition-handler list to NIL during execution.  Application handlers therefore remain inactive during debugger evaluation, printing, input, and restart invocation.  Handlers established within those operations work normally.  A transfer out of the debugger restores the application's handler list before older application cleanup runs.  A normally returning restart function executes within the command's handler scope, so its unhandled errors enter a child debugger.

A failure during command execution can enter a child stop.  The parent command remains running, and new parent commands are rejected until the child resolves.  Each command establishes an ABORT restart with report "Abort this debugger command."  Invoking that captured restart in a child unwinds the parent command, records :unwound, and resumes the parent's command loop.  Its original computation stays stopped.  Client polling needs a deadline and a way to inspect child stops.  The API provides no remote command-cancellation operation.

The operation set is `:inspect`, `:modify`, `:describe-object`, `:clear-inspection`, `:arglist`, `:bindings`, `:catches`, `:handlers`, `:evaluate`, `:condition`, `:restarts`, `:frames`, `:locals`, `:current-frame`, `:select-frame`, `:next-frame`, `:previous-frame`, `:top-frame`, `:bottom-frame`, `:abort`, `:proceed`, `:help`, `:invoke-restart`, `:invoke-restart-interactively`, and `:invoke-restart-with-arguments`.  Abort invokes the innermost captured restart named CL:ABORT.  Proceed invokes the innermost captured CL:CONTINUE restart interactively.  If none exists, acceptance rejects :NO-CONTINUE-RESTART without consuming a command ID or entering a child debugger.  The restart listing marks its selected default with :DEFAULT-P.  Help returns the guest command descriptions.  INVOKE-RESTART supplies zero arguments.  INVOKE-RESTART-INTERACTIVELY uses the selected restart's interactive function to obtain arguments.  INVOKE-RESTART-WITH-ARGUMENTS reads and evaluates one expression through QUERY-IO, then applies INVOKE-RESTART to its primary value, a finite proper list.  NIL selects zero arguments.  This operation accepts a restart index or NIL for the default CONTINUE.  The [protocol reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md#command-results) specifies result fields.

Values are printed on the stopped thread with `*print-readably* NIL`, `*print-circle* T`, `*print-level* 5`, and `*print-length* 20`.  User printers can allocate, block, signal conditions, or enter another stop.  Those bindings do not bound a custom printer's runtime or output.  Frame-local and evaluation results contain printed representations.  The [Inspector operations](#object-inspection) retain object and component references for navigation and modification.

### Disconnect and restore

Within one boot, an accepted command executes at most once under its recorded ID.  After reconnecting, a client reacquires control, queries that ID, and can repeat the identical submission.  Releasing the stop discards this record.

An image restore resumes the saved guest state and establishes a new boot event.  Old handles, controllers, leases, frames, and remote sessions expire.  A fresh session can discover a restored stop and read retained command history.  Each result reports whether its command belongs to the current boot.  A historical frame result can receive a new session token while its guest frame reference remains expired.

A queued command expires without execution when selected after restore.  A running command blocked on a Lisp event can resume its saved invocation, retain its prior-boot identity, reject resubmission, and record its result.  Restore support covers parked stops, completed-command history, and this event-waiting state.  Other running-command positions and external I/O have no restore guarantee.  Restoring an earlier image restores an earlier command history.  At-most-once execution within a boot does not prevent repetition of external effects across image rollback.

## Retained evaluation

The evaluation service creates a guest worker for each named source submission.  It establishes retained debugging, reads and evaluates forms in order, and preserves the final form's multiple values.  The initial package is explicit, and package changes affect later forms within that job.  Each job starts with a fresh standard readtable.  Batch input is a supplied string followed by EOF.  `:interactive T` selects input that waits for supplied text or explicit EOF.

The optional `listener` argument selects the guest Command Processor.  Its [guide](command-processor.md) describes per-Listener package and pathname state, serialized submissions, and replay after package changes.

The worker binds its own standard streams.  Standard, error, and trace output share synchronized character storage.  Query, debug, and terminal I/O combine the job's input and retained output.  Output reads use character offsets and copy storage without consuming it.  Both job streams close when the job completes.  Input, output, and result objects remain until release, with no storage quota.

These functions are exported from `MEZZANO.DEBUG`:

| Guest API | Meaning |
|---|---|
| `start-evaluation-job name source &key package input interactive listener` | Creates a batch job by default, or an interactive job when requested.  Package defaults to `"CL-USER"`, and input defaults to an empty string. |
| `evaluation-jobs` | Returns current-boot handles for unreleased jobs. |
| `evaluation-job-information handle` | Returns name, state, thread display label, acceptance-boot comparison, active stop handles, printed values, and output length. |
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

Snapshot restore preserves retained job records and character-stream positions.  The supported restore states are a completed batch job, a condition-stopped batch job after partial input consumption, and an interactive job waiting within a partially read line.  A fresh session obtains current-boot handles for those jobs.  Replaying the original creation request from an earlier boot is rejected.

Interactive input counts active waiting reads.  A debugger's interactive restart reader can wait within an interrupted application read on the same stream.  Aborting that nested reader preserves the application's input-wait state.

### Interruption

A numbered interrupt request uses the supervisor's existing thread foothold mechanism.  Delivery respects `without-footholds` and enters the retained debugger on the evaluation worker.  CONTINUE resumes the interrupted computation.  The job's ABORT restart follows normal Common Lisp unwinding and cleanup rules.

Interrupt IDs start at zero and increase per job.  The job retains their records until release.  Repeating an accepted ID in the same boot returns that ID without another delivery.  Prior-boot requests reject replay.  One request may be pending per job.  A running request permits a nested request while its debugger executes a command.  Job information reports `:next-interrupt-id`, the innermost outstanding `:interrupt-id`, and `:interruptible-p`.  The availability flag describes the sampled state.  Delivery validates that state again on the target thread.

| Interrupt state | Meaning |
|---|---|
| `:pending` | Accepted and awaiting delivery. |
| `:running` | The worker entered interruption handling.  Job information reports its stop once debugger entry registers it. |
| `:returned` | Control returned through CONTINUE. |
| `:unwound` | Control left interruption handling through a nonlocal exit.  The job outcome is separate. |
| `:cancelled` | Delivery found a debugger waiting for a command or a completed job.  The result is `:already-stopped` or `:job-complete`. |
| `:expired` | Delivery selected a request accepted before the current boot. |

The worker arms delivery inside its stream bindings and ABORT restart, and disarms before leaving that restart's scope.  Early requests wait until it arms.  Completion cancels an undelivered request.  A target waiting in a retained debugger records `:already-stopped`.  During command execution, delivery enters a child stop only inside the command's established ABORT boundary.  CONTINUE resumes that operation.  The child stop's command ABORT abandons it and returns to the original debugger.  If the original stop came from an interruption, its interrupt record remains running and becomes the reported `:interrupt-id` again when the child request finishes.

Any attached session can request interruption or read its history.  Stop commands retain exclusive controller ownership.  Request publication and scheduling use the service mutex with caller footholds inhibited.  A new request targeting its calling thread reports `:self-interrupt`.

A queued interrupt selected after restore expires without delivery.  A running interrupt stop can continue through a fresh session.  Its interrupt record keeps its original acceptance boot.  Nested debugger-command interruptions have no restore test yet.  Other instruction positions and external I/O have no restore guarantee.

## Function-entry stops

Mezzano's TRACE accepts a :BREAK condition before a function name.  When that condition evaluates true, the trace wrapper calls BREAK before entering the function body.  Calls from Web Listener evaluations enter the retained debugger.  CONTINUE enters the function body.  The evaluation's ABORT restart aborts the evaluation.

For example, after loading the HTTPS libraries:

```lisp
(trace :break t drakma::default-port)
(complete "Say hello." :timeout 600)
```

This stops in Drakma's HTTP request path before it opens the connection.  The Web evaluation's Debugger action opens the stop.  `:Show Backtrace` lists its frames, `:Set Current Frame N` displays a frame's available locals, and `:Show Proceed Options` lists its restarts.  Clicking CONTINUE resumes the call.  The request deadline includes time spent in the debugger.

Tracing applies to calls through the named function's reference in every thread.  Each call prints its arguments and return values.  DEFAULT-PORT takes the URI as its argument.  The trace remains active until removed:

```lisp
(untrace drakma::default-port)
```

## Frame evaluation

The `:evaluate` debugger operation reads one Lisp form and evaluates it in the selected frame's lexical environment.  Its argument is a source string.  Its result is a list of printed values, including an empty list for zero values.  Reading disables reader evaluation.  Execution uses the stopped thread's package, dynamic bindings, and retained streams, with application condition handlers disabled during debugger operations.

Lexical variables and local functions resolve by binding identity in the selected instruction's scope.  Symbol macros and local macro definitions retain their source meaning.  SETQ and SETF write the live binding immediately, including a cell shared with compiled closures.  The setter checks the binding's source declaration and storage representation before writing.  A resumed computation observes the changed binding.

A scope with unavailable metadata rejects evaluation.  A known binding with unavailable storage rejects access to that binding, while other expressions in the same scope can run.  Constant and unsupported locations reject writes.  These conditions enter a child debugger, where :Abort abandons the expression and restores the enclosing stop.  Reader, evaluator, and result-printer conditions use the same command boundary.  DESCRIBE propagates errors from an object's printer or its slot-value printers through that boundary.

Each debugger level has separate `+`, `++`, `+++`, `*`, `**`, `***`, `/`, `//`, and `///` histories, initially NIL.  The variable `-` holds the current form.  A normally returning evaluation updates the histories before printing.  An aborted evaluation leaves automatic value history unchanged.  Nested debugging preserves its parent's history.

A closure created by frame evaluation can access the captured live bindings while its stop remains active on the owning thread.  Stop exit, release, or image restoration invalidates that frame reference.  Another thread cannot use it.  Compiled-file serialization rejects frame-backed bindings.  Ordinary program closures continue using their own captured cells after continuation.

Special variables use the stopped thread's current dynamic bindings.  Selecting an older frame does not reconstruct its earlier special bindings.  Source BLOCK and GO targets currently reject control transfer.  BLOCK and TAGBODY forms created within the evaluated expression work through the interpreter.  Supported runtime tests cover x86-64 debug-3 compiled frames, unavailable debug-0 bindings, compiled-file loading, full GC, nested recovery, and continuation.  Saved parked condition stops retain their selection, history, and live bindings for fresh evaluation after restoration.  Old references expire.  Executing frame-evaluation restore, interrupted frameless restore, host cold-build, and ARM64 acceptance remain untested.

## Compiler guarantees

The image bootstrap policy is `(safety 3 debug 1 speed 1)`.  The running compiler defaults to `(safety 3 debug 3 speed 1)`.  Code already in an image retains the policy and debugger metadata from its compilation.

Evaluation propagates errors raised during compilation to the caller's handlers or debugger.  Aborting compilation leaves a lazy function available for retry.  A later call compiles the same function again, and successful calls thereafter use its compiled target.  Recursive compiler entry retains its existing interpreter path.

At debug level 3, the compiler preserves lexical bindings for inspection, including unused bindings.  A binding follows the policy at its introduction.  A local debug-3 declaration preserves a binding inside a function compiled at debug levels 0, 1, or 2.  Entering a lower-debug region afterward does not remove that preservation.  Captured preserved bindings share one environment cell between the defining function and its closures.

At debug level 3, FLET and LABELS bindings retain their function objects, including unused functions.  Local-function names appear as (FUNCTION name), or (FUNCTION (SETF name)) for a SETF function.  A variable and function with the same symbol have separate records.  Function bindings use the policy at their introduction and retain captured cells shared with their closures.  Instruction scope records identify the innermost visible variable and function bindings by their shared descriptors.  The remote API uses these identities for local inspection and selected-frame lexical evaluation.

Captured BLOCK and TAGBODY bindings have separate entries in the closure layout: #(:block binding) and #(:tagbody binding).  The binding descriptor is shared with the source-scope record.  These entries identify control contexts and do not appear among local variables.  DEBUG 1 and 3 retain captured control identities.  DEBUG 0 follows the existing binding-preservation policy.  Earlier NIL layout entries mean unavailable metadata.  Reading a control context requires its live owning activation.  The internal x86-64 reader resolves a control context's first jump-table entry to the compiled function and an object-relative byte offset; ARM64 destination lookup remains unavailable.

Local records describe names, locations, and representations.  An empty binding layout ends the preceding local-variable records.  Availability is independent of the Lisp value, including NIL and keywords.  Missing storage reports an unavailable value.  Errors reading accessible storage enter the debugger.  The service does not reconstruct every source-level activation lost to inlining or tail calls, and it does not provide separate original and current argument records.

## Operation limits

The x86-64 frame walker uses existing GC metadata to traverse framed calls, frameless calls, and framed interrupt saves.  Captured frames retain saved-PC locations, so later inspection reads GC-updated code references.  Interrupted instructions retain their exact offsets.  Call return addresses identify the preceding call instruction.  A deterministic interruption test verifies a frameless callee, its caller's debug-3 stack locals, moving GC, and continuation.

An activation without an established frame reports stack-slot values unavailable and rejects stack-slot writes.  Saved-register local inspection and traversal through frameless interrupt-return phases remain unsupported.  The frame walker has no ARM64 execution test.  Restoring an interrupted frameless activation remains untested.

The retained service lists applicable restarts, supports zero-argument calls, invokes their interactive argument readers, and reads explicit argument expressions.  The Web restart controls offer interactive invocation or :Arguments input.  An interactive evaluation supplies QUERY-IO through its retained input and output streams.  The :Arguments operation supports required parameters even when a restart has no interactive function.  It reads with `*READ-EVAL*` NIL and evaluates in the stopped thread's current dynamic environment and a null lexical environment.  It does not expose selected-frame lexical bindings.  Reader, evaluation, argument-list, and invocation errors enter a child debugger.  Aborting that command restores the enclosing stop.  Accepted-command and input replay preserve the original execution.  A nonlocal restart exit follows Common Lisp unwinding rules.  It does not provide arbitrary frame return, frame reinvocation, or a selected-frame THROW operation.

The API does not reconstruct historical special bindings or provide catch enumeration, breakpoint management, call/exit traps, instruction or source stepping, location monitoring, or raw-stack modification.  Function-level source information and the separate Lisp disassembler do not provide source display tied to the executing function version through this API.

Condition entry requires the explicit wrapper or a retained evaluation job.  The service does not install a system-wide condition policy or provide startup-failure handling.  The Web interface displays the remote service's conditions, frames, locals, and restart choices.
