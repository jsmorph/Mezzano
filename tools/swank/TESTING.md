# Remote debugger tests

These tests exercise guest compiler and debugger behavior, SWANK transport, evaluation jobs, Listener commands, and documentation operations.  [Web interface tests](web/TESTING.md) cover HTTP and browser behavior.  The [development journal](devnotes.md) records execution results, failures, and source revisions.

## Test environment

Run host commands from the Mezzano checkout.  The guest must use the corresponding compiler, runtime, and Slime contrib.  `SYS:SOURCE;` must expose this checkout, and the guest HOME directory must be writable.  The host needs SBCL, Python 3, and an IPv4 SWANK endpoint.  The retained client requires `/dev/urandom`.  `test-lispm-eval.py` invokes the checked-in executable, whose shebang requires `/usr/bin/sbcl`.

The transport scripts accept a port argument and connect to `127.0.0.1`.  A remote guest can be reached through an SSH local forward as described in the [remote client guide](README.md#connection-setup).  Choose the forwarded port:

```sh
SWANK_PORT="${SWANK_PORT:-4005}"
TEST_STATE_DIR="$(mktemp -d)"
```

Run guest tests sequentially on a dedicated test VM.  Tests define guest functions and packages, create threads and retained records, and may request full GC.  The evaluation-service fixture tracks its generated job names and checks release of those jobs, so its cleanup assertions preserve unrelated evaluations.  A failure can leave a stopped fixture for inspection.  Restore fixtures share counters and must run separately.  Their host state files must survive the VM restart.

The guest test helpers AWAIT, COMPLETED-COMMAND, and COMMAND accept an optional timeout in seconds, defaulting to 20.  The native FPU-unwind probe supplies 60 seconds for its command that performs six full collections.

Load ordinary debugger, evaluator, Command Processor, SWANK, and test files with LOAD's default allocation policy.  The image builder uses the same policy for these modules.  Explicit wired loading is reserved for supervisor/runtime code with the residency requirements below.  Forcing ordinary test code and constants into the wired area can exhaust its available blocks despite repeated full collection.

For state-preserving publication tests, compile/load `test-publication-state.lisp` with ordinary allocation.  Call LISPM-PUBLICATION-STATE-TEST:CAPTURE with the exact protected stop IDs and expected non-released job count before publication.  It retains all raw registry entries, including released job tombstones.  CHECK verifies field and table-entry identities, copied buffer contents, application functions, global cells and values, source roots, and prior command rows.  Use :AFTER-BOOT T after a saved-image boot and :ALLOW-ADDITIONAL T only while owned test records/jobs coexist with the protected baseline.  Session retirement follows the adapter’s boot semantics and requires a separate test.

Live publication must load the matching SWANK contrib after a core service change.  An older checkpoint can retain an encoder that predates a new core result field even when the checkout contains the corrected source.  Compile/load `SYS:HOME;SLIME;CONTRIB;SWANK-MEZZANO-DEBUGGER.LISP` and `SWANK-MEZZANO-TRANSIENT-TEST.LISP` with ordinary LOAD, reject warnings/failure, and call `(swank-mezzano-transient-test:run)` before browser acceptance.  That suite checks direct and monitor encoding of a closed stop's current-thread link.

The instruction-position and saved-register tests target x86-64.  Compiler tests select the policies they exercise.  The default running compiler policy is `(safety 3 debug 3 speed 1)` and the image bootstrap policy is `(safety 3 debug 1 speed 1)`.  These tests do not establish ARM64, bare-metal, supervisor-trap, or arbitrary-suspension support.

## Desktop-disabled startup

A desktop-disabled startup test uses a newly built image with `MEZZANO.INTERNALS::*DESKTOP-ENABLED*` NIL and a private source/dependency tree.  QEMU retains `-vga std -display none` because the core boot path requires a framebuffer.  After startup, check the global startup debugger value, the configuration flag, absence of the desktop variable and GUI/compositor packages, absence of loaded sound/media/USB systems, process enumeration, and arithmetic.  USB checks cover the `MEZZANO.DRIVER.USB` package and the loaded `mezzano-usb` ASDF systems.

Compile and load `test-debugger-service.lisp` with ordinary allocation.  Loading it runs its background debugger tests.  Compile and load `test-find-frame.lisp`, then call `LISPM-FIND-FRAME-TEST:RUN`.  Load the native HTTP service and test the Listener, command completion, typed Proceed/Abort, documentation topic/reload, and nonempty Peek rows in Chromium.  Repeat the native checks after normal Snapshot/restart without reloading the test modules.

The recorded x86-64 test passed desktop-disabled first boot, native tests, forty HTTP asset responses, and that bounded browser scope.  Normal Snapshot/restart and the native tests passed without fixture reload.  The same bounded Chromium scope passed after restart.  The optional desktop module initialized in that image and passed Snapshot/restart, package/thread/asset checks, and the existing native debugger tests.  Its first coordinator used an incorrect USB package name.  The preserved failed result and corrected postcondition tests have separate receipts.  Desktop dependency compilation emitted library style warnings and three optimizer-limit warnings.  Fresh default-desktop first boot, desktop rendering/application behavior, framebuffer-free boot, and ARM64 execution require separate acceptance.  The [development journal](devnotes.md#headless-browser-acceptance) preserves the evidence and fixture failures.

## Startup recovery

Compile/load `system/startup.lisp` and `test-startup-recovery.lisp` with ordinary allocation after the debugger-service fixture, rejecting warnings/failure.  The test's init-file argument is a writable source pathname containing `(lispm-startup-recovery-test::checkpoint)`.  Call `(lispm-startup-recovery-test:run :init-file pathname)` on a dedicated guest.

The ten retained-stop cases cover initialization, the init file, and early/ordinary/late hooks, each with Continue and Abort.  They check condition text, the checkpoint frame, the startup ABORT report, two restart values, exact effects, complete/incomplete status, one cleanup and release.  One parked stop undergoes full GC.  Two additional cases check return/Abort with the caller's Snapshot inhibition.  The target and coordinator use DEBUG 3/SAFETY 3/SPEED 1.

The fixture holds the worker at an event after the startup function returns and before test cleanup.  At each boundary it waits for the aggregate Snapshot count to equal the count owned by the test.  A lower count fails at once.  A persistent excess reaches the bounded test deadline.  Other device/file operations can contribute temporary counts.  The fixture restores the original hook-list identities under the existing mutex, preserves the production startup status through per-thread binding, and releases its own inhibition after checking Abort retention.  A failure retains `*CASE*` and its stops for inspection.

Before kernel integration, the fixture's `:hooks` and `:init-file-loader` arguments can receive compiled functions made from the exact candidate definition bodies.  The installed functions and active boot-worker loop then retain their identities.  Native x86-64 component acceptance used that mode.  Installed definitions also passed the component tests in a fresh x86-64 core.  Actual first-boot Abort and Continue passed as described below.  Actual restore-hook Continue/Abort, incomplete-state Snapshot inhibition, subsequent recovery from the saved image, and browser startup recovery remain pending.

### Initial startup

For actual first-boot recovery, copy `test-initial-startup-init.lisp` to the private HOME tree and set the image configuration's init-file pathname to that copy.  Boot a freshly built image and wait for Main to stop at the fixture's continuable error.  Compile/load `test-initial-startup.lisp` with ordinary allocation at SAFETY 3/DEBUG 3/SPEED 1.  Call `(lispm-initial-startup-test:run :abort)` in one independent cold-image copy and `(lispm-initial-startup-test:run :continue)` in another.

The helper checks the actual Main-thread condition, frames, restart reports, effects, startup status, thread termination and Snapshot accounting.  Abort must leave initialization incomplete, retain one inhibition and skip final warm success.  Continue must complete initialization and its automatic Snapshot, clear the fixture's error flag and leave inhibition zero.  Both independent x86-64 QEMU tests passed.  An aborted initial image is not a completed startup checkpoint.

## Stack-guard collection

Compile/load `test-gc-stack-guard.lisp` with ordinary allocation after the debugger-service fixture.  Then compile `test-gc-stack-guard-pager.lisp` at SAFETY 3/DEBUG 1/SPEED 1 and load that compiled helper with `:wired T`.  It runs on the pager's resident stack and reads block-map flags under the VM lock.  The ordinary fixture sends it a numeric page address through PAGER-RPC, then checks the returned flags outside the critical section.  Call `(lispm-gc-stack-guard-test:run)`.  It triggers two stack overflows on one thread with a 128-KiB stack and the supervisor's additional 64-KiB overflow reserve.  Each retained condition must expose the owned ABORT restart.  Minor and major collection must change words on the return-guard page and restore its read-only protection while the guard remains armed.  A full collection precedes each new overflow.  The minor phase requires young return-page references and a minor cycle with no major cycle.  Abort checks each retained cell, strictly descending cleanup indices through zero, the number of installed cleanups, thread completion and stop/controller release.  The body-entry counter can lag the installed cleanup count when overflow occurs before its increment.  A failure retains `*CASE*`.

Native x86-64 QEMU acceptance passed both after ordinary publication of SCAN-THREAD and in a fresh core containing the correction.  The corrected resident query passed in that fresh core.  Both overflows retained 370 frames and checked 351 cells and cleanups at SAFETY 3/DEBUG 3/SPEED 1.  Normal Snapshot/restart and FINISH passed without fixture reload.  ARM64 execution remains untested.

For saved-state testing, call `(lispm-gc-stack-guard-test:prepare-restore-test)`, release the preparation evaluation, and save a normal Snapshot.  Wait for Snapshot completion before stopping and restarting that same image.  Call `(lispm-gc-stack-guard-test:finish-restore-test)` without reloading the fixture or resident helper.  Preparation leaves the first overflow parked without a controller.  FINISH requires a changed boot identity, collects the saved return page with major GC, Aborts and checks its cells and cleanups, then tests the worker's second overflow with minor/major GC and Abort.  It joins the worker and releases its stop/controller state.

## Kernel compilation

The image builder compiles supervisor code with `(safety 3 debug 1 speed 1)`.  The running Lisp compiler defaults to debug level 3 for application inspection.  Live supervisor replacements require the kernel policy and `LOAD` with `:wired T`, which keeps their code and constants resident.

Before replacing resident definitions live, retain their old function objects until their running activations have ended.  The collector excludes supervisor and idle stacks because those threads can execute during collection.  Their active code therefore needs another live root.  Loading a new PAGER-THREAD definition removes the fdefinition root of its old executing loop.  A publisher must retain that old function and its constant pool through GC and snapshot, verify the new loop after boot, and then release the obsolete publication roots.

The debug-level-3 compilation of PAGER-ALLOCATE-PAGE retains calls to BYTE-POSITION and BYTE-SIZE.  Those functions occupy pageable memory.  Paging can therefore fault inside the pager after a live replacement built with the application policy.  Loading the caller into wired memory alone leaves those callees pageable.  Kernel replacement review must check generated calls as well as the replacement's allocation area.  A fresh image build and a boot under memory pressure test the compiled kernel and its callees together.

## Transport and guest tests

The variable-definition fixture is `test-variable-definitions.lisp`.  Compile/load it with ordinary allocation and call `(lispm-variable-definition-test:run source)` with a fresh writable source pathname.  It tests DEFVAR, DEFPARAMETER, and DEFGLOBAL with fresh symbols: lexical initializer scope, dynamic bindings, conditional initialization, NIL, omitted values, documentation, warning-free DEBUG 0/1/3 compilation, and serial COMPILE-FILE/load semantics.  The optional source pathname enables the file tests.  Calling RUN without it repeats the non-file cases, including after full GC.  The native tests cover x86-64 at SAFETY 3/SPEED 1.  Fresh cold-image startup and ARM64 require separate tests.

The structure file-loading fixture is `test-structure-file-load.lisp`.  Compile/load it ordinarily, then call `(lispm-structure-file-load-test:run directory)` with an existing writable pathname directory.  It generates separate source/LLF files under that directory and tests serial and parallel compilation.  Cases cover an accessor before or after its DEFSTRUCT, a pre-existing compile-time class, inherited forward references, independent layout/header constants with no defining form in the loaded file, existing class/layout/header identity after reparenting, explicit missing-class rejection, and full GC.  The fixture removes only its owned class names before fresh-load cases.  A failure retains `*CASE*` and its generated files.  Success deletes its owned packages and retains files for inspection.  Run the existing full structure-layout suite as well to test initialization, migration, read-only stores, and redefinition.

The transport scripts run in host SBCL:

```sh
python3 tools/swank/test-lispm-eval.py --port "$SWANK_PORT"
for test_name in test-debugger test-debugger-reconnect test-evaluation-reconnect \
  test-listener test-document-examiner test-private-documents test-processes
do
  sbcl --script "tools/swank/$test_name.lisp" "$SWANK_PORT" || exit "$?"
done
```

These files compile and execute inside the guest.  Run them after the corresponding compiler and runtime have been loaded:

```sh
for test_name in TEST-FOOTHOLD-GC TEST-INTERRUPT-RETURN-GC TEST-GC-RESTART \
  TEST-CONS-ALLOCATION-GC TEST-STRUCTURE-LAYOUTS TEST-FRAME-LOCALS TEST-LIVE-RANGES \
  TEST-DEBUG-METADATA TEST-SPILL-INTERFERENCE TEST-DEBUG-BINDINGS TEST-DEBUG-BINDING-WRITES TEST-DEBUG-WRITE-FLOW \
  TEST-DEBUG-CLOSURE-WRITES TEST-DEBUG-POLICY TEST-KEYWORD-LOWERING \
  TEST-JUMP-TABLE-BINDINGS TEST-DEBUGGER-SERVICE TEST-EVALUATION-SERVICE \
  TEST-EVALUATION-INTERRUPT
do
  sbcl --script tools/swank/lispm-eval --port "$SWANK_PORT" --timeout 180 \
    "(load (compile-file \"SYS:SOURCE;TOOLS;SWANK;$test_name.LISP\")) (values)" ||
    exit "$?"
done
```

The debug-metadata fixture checks binding order, locations, representations, aliases, scope changes, inserted instructions, and shared records.  It checks both target emitters and their encoded metadata while running on the host architecture.  ARM64 metadata checks do not execute ARM64 machine code.  Its RUN function can also receive the previous rebuild and emitter functions for comparison during compiler replacement.

The [binding-identity fixture](README.md#compiler-lexical-environment-tests) checks same-name stack and captured bindings, shared cells, function namespaces, copying, inlining, location deltas, native compiled-file loading, and full GC.  Its restore helpers retain closures and their descriptor through a saved-image restart.  Legacy-record acceptance requires retaining a function compiled before the descriptor change and passing it and its binding name to LISPM-BINDING-IDENTITY-TEST::CHECK-LEGACY.

The [function-constant fixture](README.md#evaluator-environment-tests) checks native compiled-file serialization of compiled, lazy, and interpreted functions, shared identities and cells, nested macro environments, source metadata, and full GC.  Reload the compiled fixture before each RUN because its expected counters describe the file's initial state.  Recursive function/environment graphs and cross-target loading remain untested.

The GC function-reference fixture is `test-gc-fref-forwarding.lisp`.  Compile/load it with ordinary allocation and reject warnings/failure.  `(lispm-gc-fref-forwarding-test::run)` tests ten normal and controlled-forwarding target cases, restoring headers before each real full collection.  `(lispm-gc-fref-forwarding-test::run-interrupted)` uses x86-64 instruction stepping to stop an owned thread at byte offset 35 of a generic function's function-reference trampoline.  Four full collections must preserve that PC, move the discriminator closure, preserve target links, and permit the original return and thread termination.  A failure retains its owned thread.  These tests use DEBUG 3, SAFETY 3, SPEED 1.  The metadata reader uses the cold compilation policy, DEBUG 1.  ARM64 execution remains untested.

The type/control-flow fixture is `TEST-TYPE-CONTROL-FLOW.LISP`.  Compile/load it with ordinary allocation, reject warnings/failure, then call `(lispm-type-control-flow-test:run)`.  It compiles twelve functions at DEBUG 0/1/3, SAFETY 3, SPEED 1 and executes both paths: RETURN-FROM with zero/one/eight values, GO through assignment, and cleanup.  The warning check detects a rewrite cycle between type propagation and control-flow simplification.

The intersection-type fixture is `TEST-SUBTYPE-INTERSECTION.LISP`.  Compile/load it with ordinary allocation, reject warnings/failure, then call `(lispm-subtype-intersection-test:run)`.  It checks 150 permutations of three-, four-, and five-operand integer intersections, nested assertions, certain true/false results, overlapping intervals, the JPEG nonnegative FIXNUM type, and compiled execution at DEBUG 0/1/3, SAFETY 3, SPEED 1.  Overlap cases reject certified false answers when the relationship is true.  Compiler acceptance also recompiles CL-JPEG's JPEG file and Babel's strings file without warnings at the existing twenty-iteration limit.  Native acceptance covers x86-64.

The compiler-result fixture is `TEST-COMPILATION-RESULTS.LISP`.  After loading the updated compiler driver and file compiler with normal allocation, compile/load the fixture without warnings or failure, then call `(lispm-compilation-results-test:run)`.  It checks clean/style/general/continuable-error results, condition identity and propagation, serial and forced-parallel file compilation, an optimizer warning in the worker phase, nested parallel propagation, concurrent invocation isolation, and installation/return values for already-compiled functions and macros.  The accepted execution target is x86-64 at DEBUG 3, SAFETY 3, SPEED 1.  Cross-build and ARM64 execution require separate tests.

The [CFG fixture](test-backend-cfg.lisp) validates block order, ordered predecessor/successor lists, duplicate branch and switch targets, nonlocal edges, cycles, unreachable blocks, empty outgoing maps, and dangling/foreign/interior target rejection.  After ordinary compilation and loading, `(lispm-backend-cfg-test:run)` tests the installed builder.  Its optional argument accepts another builder function for the same expected graphs.

The [compilation-error fixture](README.md#evaluator-environment-tests) checks compiler condition identity, single expansion on failure, lazy-function retry after ERROR and THROW, recursive forcing, completed target reuse, and rejection of serialization during compilation.  Its macros and state belong to each test invocation and are removed on exit.

The [instruction-scope fixture](README.md#compiler-lexical-environment-tests) checks scope selection at exact instruction offsets, empty versus unavailable scope, alignment, identity shared with location records, compiled-file loading, full GC, and legacy records.  Its scope objects are fixture data.  It does not establish compiler source-environment conversion or live frame evaluation.

The [source-scope fixture](README.md#compiler-lexical-environment-tests) checks compact conversion of native compiler environments, shadowing in each namespace, type and optimization declarations, macro identity/state, control-scope identities, compiled-file sharing, and full GC.  Reload its compiled file before each RUN.  The backend cases use DEBUG 0/3 and COMPILATION-SPEED 1/3 with SAFETY 3 and SPEED 1.  The target-macro fixture checks native serialization of target constants, shared identity, target/native state, defining environments, compilation failure and retry, and full GC.  Reload its compiled file before each RUN.

The emitted-scope fixture checks compiler-generated records against live x86-64 call addresses and binding storage, including nested and disjoint bindings, namespaces, local macros, scope exit, mutation, compiled-file loading, and full GC.  It exercises DEBUG 0/3 and COMPILATION-SPEED 1/3 with SAFETY 3 and SPEED 1, and checks values at DEBUG 3.  Direct emitter checks cover both architectures.  These results do not establish ARM64 execution or a host cross-build.  The [frame-evaluation fixture](README.md#frame-evaluation-tests) separately checks live bindings, writes, declarations and representations, histories, replay, nested recovery, GC, continuation, and lifetime rejection.  Load the debugger-service fixture for its helpers before compiling it.

The internal x86-64 frame-return fixture requires the debugger-service and frame-evaluation fixtures for their helpers.  Compile and load `TEST-FRAME-RETURN.LISP` after loading the corresponding `system/debug.lisp` and `debugger-service.lisp`, reject compilation warnings or failure, then call `(lispm-frame-return-test:run)`.  It tests zero/one/seven values, single-value and ignored-value callers, invalid value lists, stack arguments, caller continuation, binding restoration, cleanup order and superseding exits, retained command replay, a continuable cleanup condition, full GC, and two continuation prompts.  Guard cases use real frameless and established LAP frames and a thread foothold.  Eight concurrent full collections exercise repeated transfers with heap values.  Concurrent collection does not establish collection at every epilogue instruction.  This fixture tests an internal helper.  The Return command uses the separate fixture below.  ARM64 execution and Reinvoke require separate acceptance.

Compile/load `TEST-FRAME-RETURN-COMMAND.LISP` after the service, frame-evaluation, and internal Return fixtures.  Call `(lispm-frame-return-command-test:run)`.  It tests expression/confirmation input, zero/one/seven values, lexical versus dynamic bindings, cancellation and history, replay, reader/evaluator/EOF failures and child Abort, unavailable scope before prompting, non-NIL argument rejection, parser/completion, GC, and a cleanup condition in a new root stop.  It runs on x86-64 at DEBUG 3, SAFETY 3, SPEED 1.

`PREPARE-RESTORE` in that package leaves an owned jobless thread at Return confirmation after one expression evaluation.  After the preparation driver releases, save the image, wait for snapshot completion, and restart that image.  `FINISH-RESTORE` obtains fresh control and confirms the original command.  It checks external-handle/frame expiry, prior-boot command rejection, exact input replay, original heap/multiple values, one evaluation, one cleanup, and thread/stop/controller release.  The running command retains its old executing function after fixture recompilation.

The entry-argument fixture is `TEST-ENTRY-ARGUMENTS.LISP`.  Publish instruction/accessor and target-emitter support before enabling the converter's original-argument output.  Recompile/load ordinary `system/debug.lisp` after enabling capture, then compile/load the fixture without warnings or failure and call `(lispm-entry-arguments-test:run)`.  It checks original argument identity despite parameter/default/rest/key mutations, hidden stack storage, zero and 499 supplied arguments, distinct closures sharing code, copied spines, retained frames across observed relocation and nested prompts, DEBUG 0–3 availability, compiled-file loading, and both target emitters.  An optional RUN argument accepts a callback-taking function compiled at DEBUG 3 before publication and checks unavailable legacy entry data.  The native publication test supplies that retained function.  Native execution covers x86-64 at DEBUG 3, SAFETY 3, SPEED 1.  ARM64 emitter checks do not execute ARM64 code.  Saved activation restoration and current-argument reconstruction are covered by the fixtures below.

The current-parameter fixture is `TEST-PARAMETER-CONTEXT.LISP`.  Publish AST/copy helpers, backend metadata, special-binding lowering, and service-reader support before enabling PASS1 capture.  Compile/load the fixture after the entry-argument helper package, then call `(lispm-parameter-context-test:run)`.  It checks parameter writes and shadows, optional defaults and supplied-p writes, exact special cells before and after initialization, unbound values, rest/key mutations, closure cells, AST copying before and after lowering, hidden-cell filtering, malformed metadata, full GC, prompts, compiled-file loading, and target emission.  An optional RUN argument checks a retained function compiled before publication.  RUN binds the runtime compiler to DEBUG 3, SAFETY 3, SPEED 1, preserving its caller's policy.  Acceptance covers callers at DEBUG 1 and 3.  Native execution targets x86-64.  ARM64 emitter tests do not execute ARM64 code.  Call-list reconstruction and saved-activation acceptance are covered below.

The parameter-type fixture is `TEST-PARAMETER-TYPES.LISP`.  Publish DEBUG-PARAMETER-TYPES, DEBUG-SOURCE-SCOPE, PASS1-LAMBDA-INNER and both PERFORM-TARGET-LAP-GENERATION methods first, using compiled ordinary definitions.  Compile/load `TEST-AST-ENVIRONMENTS.LISP` for POINT and CHECK-TYPE-EQUAL and the existing service/frame/rest-argument helpers, then compile/load the new fixture without warnings or failure.  Call `(lispm-parameter-types-test:run)`.

Twelve stopped x86-64 DEBUG 3/SAFETY 3/SPEED 1 activations check lexical and explicit-special parameters through narrowing, shadowing and broader-scope restoration, AST copies before/after lowering, default/supplied optional and keyword parameters, and an empty layout.  Target-thread debugger evaluations compare current-PC type entries with exact parameter descriptors, read exact special cells, and check identity through moving full GC.  Reports retain scalar observations.  Each target returns 42/43 and runs one cleanup.  Manual environment tests distinguish T, NIL, absent entries and missing/empty context.  Both target emitters have DEBUG 0/3 metadata checks.  A failure preserves the active retained case in `LISPM-PARAMETER-TYPES-TEST::*CASE*` and `LISPM-REST-ARGUMENT-TEST::*CASE*`.  ARM64 execution, saved-image execution and writable-reference behavior require separate tests.

The rest-storage fixture is `TEST-REST-STORAGE.LISP`.  Compile/load it after the entry-argument helper package, then call `(lispm-rest-storage-test:run)`.  Six synchronous x86-64 DEBUG 3/SAFETY 3/SPEED 1 cases check the exact current rest descriptor, available NIL, EQ list identity, heap versus live-stack spine storage, and heap-element identity through observed moving full collection.  They use ordinary and explicitly dynamic-extent rest parameters with zero, one, and seven values.  Only scalar/address observations survive target return.  This fixture tests live storage.  It does not test retention of a dynamic-extent value after its allocating activation exits.

The rest-history fixture is `TEST-REST-HISTORY.LISP`.  Compile/load it after the service, frame-evaluation, hardware-breakpoint, retained-step, retained-ordinary-step, and retained-integer-step helpers, then call `(lispm-rest-history-test:run)`.  One zero-prompt x86-64 DEBUG 3/SAFETY 3/SPEED 1 case reads and writes the exact current heap rest parameter before its final body CALL, then publishes its index-two location and steps CALL, LEAVE, and RET.  It checks all nine history values including the exact + location, list and marker identity, Inspector identity through four observed moving full collections, generation changes, expired location reads/writes after each step, released-stop errors, prior Inspector-reference expiry, exact-ID replay, original values, and one cleanup.  A failed case remains in `LISPM-REST-HISTORY-TEST::*CASE*` for diagnosis.  Declared dynamic-extent values require their allocating extent and are outside this retention test.

The rest-argument display fixture is `TEST-REST-ARGUMENT.LISP`.  Compile/load it after the service and frame-evaluation helpers, then call `(lispm-rest-argument-test:run)`.  Fourteen x86-64 DEBUG 3/SAFETY 3/SPEED 1 cases check unused lexical rest with zero/nonzero arguments, writable binding identity through GC, modified/shadowed lexical rest, exact special cells, available NIL, absent rest, unbound storage, missing parameter metadata, a live declared-DX list, and printer failure with child Abort.  Full frame text also checks original supplied positions, current required/optional/rest/key/supplied-p writes, optional defaults, duplicate and permitted unknown keys, a NIL keyword name, and independently unavailable entry/callable metadata.  The missing entry/callable cases inject and restore metadata only on the owned target.  Both rest and full-frame printer failures exercise child Abort and replay without another print.  They also check parsing, completion, help, invalid arguments before acceptance, nine-slot history identity, replay, full GC, original values and one cleanup per case.  Indexed and All argument tests explicitly check required/optional/rest/key indices, exclusion of supplied-p and AUX variables, current identity, assignment of + and *, unchanged All history, independent metadata availability, shape rejection before acceptance, range-error child Abort, and replay without another child or print.  Assistance checks preserve both candidates for the ambiguous Show Arg prefix and complete Show Argl as Arglist.  Successful indexed checks restore their prior + and * values before the existing rest-assignment check.  First failures retain the observed history.  The current-parameter reader runs on the target thread through a debugger evaluation.  The DX case clears its observation, Inspector and raw history references before resuming.  A failure retains `LISPM-REST-ARGUMENT-TEST::*CASE*` for diagnosis.

The argument-location fixture is `TEST-ARGUMENT-LOCATIONS.LISP`.  Compile/load the new MEZZANO.DEBUGGER package declaration and selected service/Inspector definitions first, then compile/load the updated rest fixture and this fixture without warnings or failure.  Call `(lispm-argument-location-test:run)`.  The service and frame-evaluation helper packages must be loaded.

Four x86-64 DEBUG 3/SAFETY 3/SPEED 1 activations test exact hidden lexical/special writes, an unbound special cell, and owned missing/NIL declaration injection.  Bound cases save the exact + reference published by Show Argument.  Tests cover index/name reads and SETF in both evaluation modes, rejected types without stores, one Value-only Inspector row and modification/replay/Clear, frame-selection independence, foreign/post-exit/released access, MAKE-LOAD-FORM rejection, moving GC, and reader/result-printer/nested non-evaluation context rejection.  Each target returns 42/43 with one cleanup.  The harness runs in LISPM-REST-ARGUMENT-TEST, so argument-name strings include the new fixture's package qualification.  Failures retain the active case.  Type injection restores the owned scope through UNWIND-PROTECT.  The fixture records the actual storage representation.  Representation-specific setter rejection and ARM64 execution require separate tests.  The rest-history fixture separately checks location expiration and retained history through stepping.  The existing frame-evaluation fixture separately checks its shared getter/setter and low-level representation cases.

For parked argument-location restoration, use the same compiled fixture's `(lispm-argument-location-test:prepare-restore-test)`.  Let the preparation evaluation finish and release its job before taking the normal snapshot.  Wait for snapshot completion, restart that guest from the same image, and call `(lispm-argument-location-test:finish-restore-test)` without reloading the fixture.  No other restore fixture may be prepared.

One jobless x86-64 DEBUG 3/SAFETY 3/SPEED 1 special-parameter activation retains the exact indexed + location, all nine history identities, selection and generation.  Completion requires a changed boot ID, expired old stop/frame controls, prior-command rejection without consuming an ID, original Lisp-reference reads/writes, unchanged same-name shadow, type rejection, observed moving GC, one Value-only Inspector page, values 42/43, one cleanup, and post-exit/released errors.  It returns T and a scalar receipt of generations, GC addresses, values and cleanup.  Failure retains *RESTORE*, *CASE* and the stopped state.  The test closes its controller without automatically aborting a failed case.  Restore state clears only after success.  Executing-operation restoration and ARM64 require separate tests.

The internal Reinvoke fixture is `TEST-FRAME-REINVOKE.LISP`.  Compile/load it after the internal Return fixture and the updated ordinary `system/debug.lisp`, then call `(lispm-frame-reinvoke-test:run)`.  Native x86-64 DEBUG 3, SAFETY 3, SPEED 1 tests check zero/one/seven/nineteen arguments and values, caller continuation and bindings, heap identity, prompts, a captured closure, 499 arguments, verified stack-allocated argument-list storage, invalid callable/list rejection before cleanup, frameless/missing-scope/inactive/interrupted frame rejection, superseding cleanup, replacement error identity, and eight concurrent full collections.  It exercises the production internal transfer helper.  The retained command, current-argument reconstruction, redefinition, browser interaction, snapshots, and ARM64 need separate tests.

The caller-owned stack-object fixture is `TEST-FRAME-TRANSFER-LIFETIMES.LISP`.  Compile/load it after the entry-argument helpers and ordinary `system/debug.lisp`, then call `(lispm-frame-transfer-lifetime-test:run)`.  It requires actual DX allocation for caller-owned conses, vectors, and lexical closures, checks their identity/content after Return/Reinvoke, and runs full GC during cleanup, replacement, and caller continuation across prompt stacks.  It keeps every use inside the allocating caller's extent and returns success from that caller.  Native execution covers x86-64 DEBUG 3/SAFETY 3/SPEED 1.  It establishes surviving caller storage, not promotion of objects from an unwound scope.

The callable-provenance fixture is `TEST-REINVOKE-CALLABLE.LISP`.  For live publication, enable BASIC-MACROS' global declaration before PASS1 capture and backend emission, then load COMPILE and DEBUG support.  Compile/load the fixture after the entry-argument helpers and call `(lispm-reinvoke-callable-test:run)`.  Its optional argument accepts a function compiled before provenance publication.  It tests global/current versus exact callable identity, unavailable legacy metadata, named source compilation, local and global closures, SETF/CAS names, tracing and redefinition, compiled aliases, absent/macro definitions, invalid source/metadata, transfer cleanup, GC/prompts, and DEBUG 0–3 emission on both targets.  RUN binds the runtime compiler to DEBUG 3/SAFETY 3/SPEED 1 and restores its caller's policy.  Tests passed under caller DEBUG 1 and 3 on x86-64.  Saved-activation and retained-command acceptance are covered below.  A clean cross-build of these additions and ARM64 execution remain untested.

The current-argument fixture is `TEST-REINVOKE-ARGUMENTS.LISP`.  Compile/load it after the updated debugger service and entry-argument helpers, then call `(lispm-reinvoke-arguments-test:run)`.  It tests current required/optional/rest/key construction, defaults and supplied-p consequences, leftmost replacement/missing-key order, retained unknown and later duplicate pairs, NIL/nonkeyword names, :ALLOW-OTHER-KEYS, conflicting duplicate declared values, unavailable and malformed inputs, final-count overflow, source spine/heap identity, live special/closure bindings, private transfer cleanup, GC, and prompts.  Native execution covers x86-64 DEBUG 3/SAFETY 3/SPEED 1.  Retained-command, browser, and saved-activation acceptance are described below.  Dynamic-extent limits and the caller-owned stack-object fixture are described above.  ARM64 execution remains untested.

The retained Reinvoke fixture is `TEST-REINVOKE-COMMAND.LISP`.  Compile/load it after the updated debugger service/Command Processor and retained Return-command helpers, then call `(lispm-reinvoke-command-test:run)`.  It tests Current/Original/New calls, option validation/copy/replay/conflict without ID consumption, parser completion/defaults, lexical/dynamic expressions, history before closure, cancellation, rest/key reconstruction, supplied-p/default effects, caller bindings, cleanup/full GC, and prompt stacks.  Execution covers native x86-64 DEBUG 3/SAFETY 3/SPEED 1 with ordinary LOAD.  It also tests reader/evaluator/list/printer/confirmation child Abort, zero and thirty-one-argument indexed previews, unavailable metadata before input, captured plain and mutable traced definitions across confirmation, exact closures, and cleanup new-root identity/Proceed.  The Web Return driver also passed its six Reinvoke groups after a guest restart.  Browser commands held across an image restart remain untested.

`PREPARE-RESTORE` in that package leaves four owned jobless threads at Current, Original, New Args, and exact-local-closure confirmations.  Release the preparation driver before saving the image.  After snapshot completion and restart, `FINISH-RESTORE` obtains fresh control and confirms those retained commands.  It checks old reference/submission rejection, preserved selection/history/preview/input, exact input replay, captured callable/heap identities despite a later global definition, one New expression evaluation, default/supplied-p effects, caller bindings, multiple values, one cleanup/full GC per target, ordinary/two-prompt stacks, and owned release.  This test finishes prepared candidates.

For fresh commands reading saved metadata, use PREPARE-PARKED-RESTORE instead.  It cancels the four confirmations through their original input and leaves their application activations parked.  Release its preparation driver, save/wait, and restart the saved image.  FINISH-PARKED-RESTORE obtains fresh control, checks historical cancellation/preview/input/history and expired references, and submits fresh Current/Original/New/exact-closure commands.  Their owner-thread metadata reads, input/command replay, heap/closure identity, default/supplied-p effects, multiple values, caller bindings, cleanup/GC, prompts, and owned release passed on x86-64 DEBUG 3/SAFETY 3/SPEED 1.  New evaluates once before cancellation and once in its distinct fresh command.

The intentional x86-64 trap fixture is TEST-NATIVE-BREAKPOINT.LISP.  Use a dedicated guest with the updated resident supervisor/x86-64/interrupts.lisp module.  Its exception callback and handler require resident allocation.  Load the service, frame-evaluation, entry-argument, and retained Return-command fixture helpers, compile/load this fixture with ordinary LOAD, and call (lispm-native-breakpoint-test:run).  It checks a fixed INT3's exact saved PC, caller lexical access, child Abort, moving GC and heap identity, Continue/Abort, one cleanup, zero/two prompts, and two parked threads sharing the trap function.  It releases its owned threads, stops, and controllers.  Kernel compilation uses DEBUG 1/SAFETY 3/SPEED 1 and the fixture uses DEBUG 3/SAFETY 3/SPEED 1.  It does not install or remove breakpoints.  Cold boot, trap-stop restoration, and ARM64 execution remain untested.

The managed x86-64 fixture is `test-hardware-breakpoint.lisp`.  Use a dedicated two-CPU guest containing the matched resident CPU and interrupt modules.  Rebuild the image before testing changed kernel code.  Compile/load the fixture normally at DEBUG 3/SAFETY 3/SPEED 1 after the service, frame-evaluation, and entry-argument helpers, then call `(lispm-hardware-breakpoint-test:run)`.  It checks the decoder's resident placement and rejects direct references to pageable BYTE, BYTE-POSITION, and BYTE-SIZE.  Hardware cases test four locations, validated instruction boundaries, exact pre-instruction PCs/RF, unchanged code, repeated/concurrent parked stops, old definitions, slot exhaustion and clear/reuse, caller lexical access, moving GC, Continue/Abort, multiple values, cleanup, and zero/two prompts.  The fixture restores its function definition and releases its owned records, controllers, threads, and locations.  Public command and saved-image tests use the separate fixtures below.  The kernel installer trusts its caller's instruction-boundary check.

The instruction-boundary fixture is TEST-INSTRUCTION-BOUNDARIES.LISP.  Publish the common assembler, x86 prefix encoders, ordinary debugger accessor, and debugger-service validator.  When updating a running image, rebuild/load both assembler modules again after the new prefix encoders load.  This gives their own compiled functions final prefix metadata.  Compile/load the fixture normally at DEBUG 3/SAFETY 3/SPEED 1 and call (lispm-instruction-boundary-test:run).  It checks exact starts after branch relaxation, all standalone prefix encoders, embedded LOCK, data/alignment, mode directives, padding, record identity, native COMPILE/COMPILE-FILE loading, closures, redefinition, GC, typed location rejection, and unchanged hardware slots.  Dynamic compilation also checks DEBUG 0/1/3 and independently compares ordinary instructions with the decoder.  ARM64 checks assemble metadata without executing ARM64 code.  The scope-table fixture explicitly truncates its owned legacy record after assembly and still tests old-record reading.  After this fixture, run the scope-table, hardware, intentional INT3, and raw TF fixtures against the same loaded implementation.

The pager-publication test requires a dedicated guest with at least two CPUs.  Compile TEST-PAGER-PUBLICATION-KERNEL.LISP at DEBUG 1/SAFETY 3/SPEED 1 and load it wired because its producer runs with interrupts disabled and its observer runs on the pager thread.  Compile/load TEST-PAGER-PUBLICATION.LISP normally at DEBUG 3/SAFETY 3/SPEED 1, then call (lispm-pager-publication-test:run).  It pauses the pager after an owned RPC, publishes a second request, and holds its producer before context save.  The pager must process that request after the save.  The observer synchronizes before processing to protect the old implementation during diagnosis.  :EXPECT-EARLY T verifies the defect in an old running pager.  The test restores the handler and joins its owned thread.  Three old-pager observations and five default passes after snapshot boot establish the correction on x86-64.  Replacing PAGER-THREAD in a running image does not replace its active loop.  ARM64 execution remains untested.

The cons-header fixture is TEST-CONS-HEADER-GC.LISP.  With the updated ordinary collector, compile/load it normally at DEBUG 3/SAFETY 3/SPEED 1 and call (lispm-cons-header-gc-test:run).  It retains the allocator's temporary object-tagged cons header across full GC for both pinned and wired areas.  Header-only roots and vectors containing both header/cons pointer forms test slot updates, actual car/cdr relocation, stable header identity, and ordinary cons construction.  The fixture passed six cases and twelve full collections on x86-64.  ARM64 execution remains untested.

The raw instruction-step fixture is TEST-NATIVE-SINGLE-STEP.LISP.  Use a dedicated x86-64 guest with the debugger-service and entry-argument test helpers.  Compile/load it normally at DEBUG 3/SAFETY 3/SPEED 1 and call (lispm-native-single-step-test:run).  It tests the existing supervisor SINGLE-STEP-THREAD on an owned raw stopped thread.  Exact PCs cover stack/register changes, a taken jump, the named CALL trampoline, the callee and RET.  Moving GC verifies heap identity in saved registers and the validity of saved PCs.  Partial/full original saves and zero/two prompts return to the original continuation, preserving values, special bindings, and one cleanup.  The fixture joins its owned threads.  It enters calls and provides no retained debugger or Web stepping command.  Critical instructions, page faults during a stepped instruction, saved-step restoration, and ARM64 execution remain untested.

The standard-value fixture requires the debugger-service and frame-evaluation fixtures above.  Compile and load `TEST-STANDARD-VALUES.LISP` in the guest, rejecting compilation warnings or failure, then call `(lispm-standard-values-test:run)`.  It checks validity/defaults, bound NIL versus unbound controls, valid nondefault package/radices/float format, debugger edits and repeated validation, independent child contexts, warning printer Abort/repair, exact replay, selection/history, full GC, program binding restoration, and owned cleanup.  Its target policy is SAFETY 3, DEBUG 3, SPEED 1 on x86-64.

The selected-special-cell fixture requires the debugger-service and frame-evaluation helpers.  After loading the updated debugger service, compile and load `TEST-SELECTED-SPECIALS.LISP`, rejecting compilation warnings or failure, then call `(lispm-selected-special-test:run)`.  It checks selected inner/outer cells on ordinary stacks and at one and two nested continuation prompts, inherited bindings across stack segments, bound NIL and unbound cells, global fallback without creating a missing global cell, exact cell identity through full GC, rejection of an interrupted frame, unchanged history/selection, continuation, and owned cleanup.  It targets established x86-64 condition-stop frames at SAFETY 3, DEBUG 3, SPEED 1.  This fixture tests the internal lookup helper.  The special-evaluation fixture below tests expression execution.

The special-binding-context and special-evaluation fixtures require the updated runtime and debugger service.  Compile runtime changes at the kernel policy and load wired.  Compile the two fixtures at SAFETY 3, DEBUG 3, SPEED 1, rejecting warnings/failure.  Call LISPM-SPECIAL-BINDING-CONTEXT-TEST:RUN and LISPM-SPECIAL-EVALUATION-TEST:RUN.  The [native fixture reference](README.md#frame-evaluation-tests) describes their primitive, cache, cross-thread foothold, nested-debugger, and continuation tests.  Run these on a dedicated guest: the runtime fixture temporarily wraps its cache helper.  A synthetic interrupted frame checks explicit rejection and does not establish interrupt-frame evaluation support.

The Show Special fixture uses the same helpers and policy.  Load the updated debugger service and Command Processor, compile and load `TEST-SHOW-SPECIAL.LISP` without warnings or failure, then call `(lispm-show-special-test:run)`.  It tests Program/Debugger differences, NIL/unbound/missing cells, history and temporary -, prompt stacks, command defaults/completion and quoted arguments followed by keywords across space/tab/newline separators, invalid and unsupported options without command-ID consumption, copied arguments and replay, reader/printer child Abort and repair, package resolution, full GC, Proceed, and owned cleanup.  Streams inspection, ARM64 execution, and saved-image restoration remain untested.

The spill-interference fixture checks overlapping, adjacent, disjoint, repeated, and unused ranges, edges from every range of a spilled register, and scalar and SIMD slot assignment.  It compares with supplied previous implementations when requested and checks that dense bit-vector rows retain their identity across insertions.

## Frame search tests

Compile and load `test-find-frame.lisp` with ordinary allocation after the service, frame-evaluation, and frame-navigation helpers.  Call `(lispm-find-frame-test:run)` under DEBUG 3/SAFETY 3/SPEED 1.  Four recursive activations test parser defaults and completion, direction, duplicate names, case, misses, brief/detail output, unsupported options before acceptance, copied arguments, accepted replay/conflict, all nine history identities, full GC, active old definitions, printer child Abort, values, and cleanup.

For parked frame-search restoration, call `(lispm-find-frame-test:prepare-restore-test)` on an otherwise empty dedicated guest.  Let preparation finish, save through the normal Snapshot API, and wait for completion.  Restart the same saved image and call `(lispm-find-frame-test:finish-restore-test)` without reloading the fixture.  Completion requires a changed boot ID.  It checks the selected recursive frame, retained brief/detailed command results, nine history identities, expired controls and frame references, rejected prior-boot replay without consuming an ID, fresh searches, full GC, original values, one cleanup, and stop release.  Before the actual restart, a separate prepare/finish pair with `:require-restored nil` tests preparation and cleanup in the current boot.  No other restore fixture may be prepared.

The parked frame-search Snapshot/restart test passed on two-CPU x86-64 QEMU at the policy above, without reloading the fixture after restoration.  Restoration during a running search, browser command recovery across restoration, and ARM64 execution remain untested.

The generic-frame fixture also searches each recognized associated generic function before and after global redefinition and GC.  Run `(lispm-generic-frame-test:run)` after its existing helpers.  The HTTP API fixture tests four-element array validation and retained-command integration.  Run existing frame-navigation tests after the service update.  Browser interaction and saved-state coverage use their separate tests.

## Retained integer steps

Compile/load `test-retained-ordinary-step.lisp`, `test-retained-logical-step.lisp`, and `test-retained-argument-step.lisp` after the existing service, hardware-breakpoint, and retained-step helpers.  Use ordinary LOAD at SAFETY 3/DEBUG 3/SPEED 1 on a dedicated two-CPU x86-64 guest.  Run `(lispm-retained-argument-step-test:run)`.  Its 100 TEST32/SUB32/ADD32 cases include 48 ADD32 cases across five operand forms at zero/two prompts.  Checks cover exact PCs and defined flags, zero-extension, adjacent memory bytes, moving roots, accepted replay, expired references, unchanged code, original values, and cleanup.  Six compiled argument-count walks also run.  Browser and saved-state acceptance require their separate drivers.

## Retained CALL steps

Compile/load `test-retained-call-step.lisp` after the raw-step, hardware-breakpoint, managed-step, retained-step, and managed-call-return helpers.  Run `(lispm-retained-call-step-test:run)` in a dedicated two-CPU x86-64 guest at SAFETY 3/DEBUG 3/SPEED 1 with ordinary allocation.  Direct/indirect cases test normal and recursive returns, three values, blocked steps, replay, moving callback arguments, redefinition, other-thread filtering, public coincidence, full capacity, callee conditions, cancellation, and termination under zero/two prompts.  A later condition after Proceed must create a new record, and cleanup must release both that record and the old closed record and join the owned thread.  The LAP callers reserve a raw alignment word while retaining their RBP-8 state root in layout `#*1`.

Run the affected raw step-over, managed call-return, retained-step, and compiled ordinary-step suites with the revised helpers.  Both compiled-entry traces passed 58 instructions with full GC between steps.  Snapshot coverage for a blocked retained CALL is described below.  ARM64 execution remains untested.  Nonlocal transfers and public command integration have the separate acceptance requirements below.

Compile/load `test-retained-call-step-restore.lisp` after the retained-CALL and managed-call-return restoration helpers.  On an otherwise empty dedicated guest, call `(lispm-retained-call-step-restore-test:prepare)`, save through the normal snapshot API, and wait for completion.  Restart the same image and call `(lispm-retained-call-step-restore-test:finish)`.  This test saves a blocked retained CALL under two prompts with one private return location and an unrelated public breakpoint.  Completion checks expired controls, prior-boot replay rejection, resident descriptors and callbacks, exact landing PC, fresh stepping, moving roots, unchanged code, three values, cleanup, and empty owned-resource tables.

## Nonlocal CALL steps

Use the matched compiler, resident CPU module, runtime %CATCH, and debugger service in a dedicated two-CPU x86-64 guest.  Compile/load `test-nlx-step.lisp` ordinarily at SAFETY 3/DEBUG 3/SPEED 1 after the retained CALL helpers.  Then compile/load `test-nlx-step-resident.lisp` wired at SAFETY 3/DEBUG 1/SPEED 1.  Call `(lispm-nlx-step-test:run)`.

The fixture checks RETURN-FROM, GO, THROW, and internal callee exits with zero/two prompts and zero/one/three/eight values.  It checks exact destination PCs, returned values, one cleanup, moving GC, acceptance generation, and command replay.  Two full-table cases preserve three public locations while redirecting the private fourth slot.  The THROW case steps one further supported resident instruction.  Guard tests require the ordinary hook to remain inactive with interrupts disabled, footholds inhibited, pseudo-atomic execution, the world stopped, or the hook disabled.

Compile/load `test-nlx-step-restore.lisp` ordinarily after the nonlocal fixture and managed-call-return restoration helpers.  In an otherwise empty dedicated guest, call `(lispm-nlx-step-restore-test:prepare 0)`, complete a normal Snapshot, and restart the saved image.  Call `(lispm-nlx-step-restore-test:finish :require-restored t)`.  Repeat at depth 2.  Preparation pauses RETURN-FROM, GO, and THROW after private breakpoint replacement and before the landing trap, with one unrelated public location filling the fourth slot.

Completion checks old-control expiration, accepted-command history and replay, descriptor/thread/callback identities, measured landing PCs, moving roots, eight values, one cleanup per case, unchanged code, and a further supported instruction at THROW's runtime landing.  Same-boot preparation/completion uses FINISH without :REQUIRE-RESTORED and reports RESTORED NIL.  A failure preserves owned state for diagnosis.

Native two-CPU x86-64 acceptance passed same-boot and actual saved-image cases at both depths.  The restored kernel includes the resident hardware-breakpoint decoder correction; ordinary fixture code uses SAFETY 3/DEBUG 3/SPEED 1.  Runtime provenance separately records the four ordinary file-compiler definitions used to load forward structure layouts.  The saved-image test does not establish ARM64 support or restoration during another step state.

Repeat the forced retained CALL cancellation/termination cases and the raw step-over, managed call-return, retained-step, retained-CALL, and compiled ordinary-step suites.  Rebuild all system and dependency code before deployment.  An incremental live publication establishes only the tested paths through newly compiled destinations.

The browser fixture `test-web-single-step.lisp` uses the Listener's own evaluation thread.  Compile/load it ordinarily after the nonlocal fixture.  The browser controls blocked CALL, RET, and escaping RETURN-FROM cases, including draft preservation, reload, stale-reference actions, fresh instruction display, accepted-ID replay, Proceed, exact values, and owned-resource cleanup.  Source and isolated client tests do not establish guest/HTTP/Chromium acceptance.

## Package condition stops

Compile/load the current package-lock function and TEST-PACKAGE-LOCK-DEBUGGER.LISP ordinarily at SAFETY 3/DEBUG 3/SPEED 1, then call (lispm-package-lock-debugger-test::run).  It requires the service, frame-evaluation and managed-step helpers.  Four cases signal ERROR or STORAGE-CONDITION under the package mutex and use Continue or Abort.  A separate thread must acquire that mutex while the target remains stopped.  Continue verifies reacquisition, and both exits check one cleanup and release their owned stops.  Then run python3 tools/swank/test-package-lock-debugger.py --port PORT against the dedicated guest.  Its compiled Lisp function exhausts the stack under the package mutex.  The host client requires SLDB entry, sends its normal protocol Abort, and checks a positive unwind-cleanup count and fresh evaluation through a new connection.  It also requires empty retained stop/job tables and resets its counter.  These tests passed on x86-64 at SAFETY 3/DEBUG 3/SPEED 1.

## SWANK connection cleanup

Compile/load the matched complete SWANK core and REPL modules before `TEST-SWANK-CONNECTION-CLEANUP.LISP`.  Compile/load the fixture ordinarily at SAFETY 3/DEBUG 3/SPEED 1, reject warning/failure flags, and call `(lispm-swank-connection-cleanup-test:run)`.  Eight native Mezzano x86-64 :SPAWN cases passed: normal unregister, borrowed numeric thread survival, both constructor/closure orderings, replaced REPL/auto-flush helpers, ordered cleanup-error aggregation and later cleanup, private self-close rejection followed by asynchronous closure, and a real TCP worker stopped in SLDB before disconnect.  The last case checks one unwind, dead owned workers, and closed output/ping behavior at the flow-control limit.

Each wait has a twenty-second deadline.  Failures retain `LISPM-SWANK-CONNECTION-CLEANUP-TEST::*CASE*`.  The test allocates every shared state field before starting workers.  Publication separately passed native complete-module compilation/LOAD, old-instance migration with its connection held open and idle, a newly owned RPC on that instance, and normal closure with worker/helper exit.  Pre-publication workers are not reconstructed from activity lists.  The native scope is Mezzano x86-64 with :SPAWN.  Other backends require separate acceptance.

For saved-image closure, call `(lispm-swank-connection-cleanup-test:prepare-restore)`, release the preparation job, save normally, wait for completion, and restart the same image.  Call `finish-restore` without reloading.  Preparation parks one raw SLDB worker and its four owned threads.  Its client idle timer is disabled after bounded setup.  Completion requires a changed boot, typed CONNECTION-STALE on both TCP directions, revoked/unregistered connection ownership, four dead threads, one cleanup and completed unwind before closing fixture resources.  Native acceptance passed.  Both helpers preserve *CASE* on failure.

The retained-job compatibility fixture is `TEST-SWANK-RETAINED-DISCONNECT.LISP`.  Compile/load it ordinarily at SAFETY 3/DEBUG 3/SPEED 1 after the cleanup fixture.  Call PREPARE in LISPM-SWANK-RETAINED-DISCONNECT-TEST, create a retained SWANK job whose source calls BODY, and call CHECK-RUNNING through native HTTP.  Close the SWANK connection and call CHECK-RUNNING again through HTTP.  Resume the job's session on a fresh connection, call FINISH through HTTP, then require job state :RETURNED and values 42/:DONE before releasing its job/session.  Native x86-64 acceptance passed: one body entry, continued execution after disconnect, exclusion from every connection ownership list, and one cleanup.  Failures preserve that package's *CASE*.

## Pager reservation tests

From the Mezzano checkout, run the isolated host test:

```sh
sbcl --script tools/swank/test-pager-accounting.lisp
```

The test reads the production block-map constants and six pager functions.  Its one-page fixture replaces disk allocation, physical memory, page tables, and locking.  It checks reservation changes when releasing eager or lazy pages, realizing a lazy page during swap, rejecting a failed disk allocation, and releasing or replacing a snapshot-owned page.  Read-only and early-allocation cases check the existing paths.  These tests cover local accounting transitions.  Guest collection, paging, and snapshot tests provide separate system evidence.

## Snapshot and restore tests

Preparation saves a guest snapshot containing the fixture.  Completion runs after the VM starts from that image.  A test that has prepared a snapshot must finish before another restore fixture starts.

A raw snapshot coordinator must capture CURRENT-BOOT-ID before saving.  When it resumes under another boot ID, it must return before post-save assertions or fixture mutation.  The fresh completion call performs restored-state checks.  TEST-SNAPSHOT-COW.LISP provides this pattern.

### Queued instruction-step delivery

The queued-pager extension uses `TEST-QUEUED-STEP-RESTORE-KERNEL.LISP` and `TEST-RETAINED-STEP-RESTORE.LISP`.  Compile/load the kernel module first at DEBUG 1/SAFETY 3/SPEED 1 with resident allocation, then compile/load the ordinary module at DEBUG 3/SAFETY 3/SPEED 1 with default allocation.  The kernel observer uses SAFE-WITHOUT-INTERRUPTS with explicit captures because its caller runs on an ordinary stack.

`PREPARE-QUEUED` in LISPM-RETAINED-STEP-RESTORE-TEST accepts an optional prompt depth of zero or two, defaulting to zero.  It prepares one NOP step at that depth and requests its own normal Snapshot.  Invoke it through raw SWANK, retain that original RPC and serial evidence, and do not request another Snapshot.  It pre-arms the step before blocking the pager, uses existing snapshot inhibition around the mandatory GC and queued-state observation, and retains a genuine pager RPC for boot replay.  The resident gate has a 180-second heartbeat-clock deadline.  The host has a separate 600-second wall-clock deadline.  A failed preparation retains its state and evidence.  After successful preparation, restart the same saved image and call `FINISH-QUEUED` without reloading the fixture.  No other restore fixture may be prepared.

Native x86-64 acceptance passed with two CPUs at zero and two prompts.  The saved target was fully saved in PAGER-REQUEST/PAGER-INVOKE, queued behind the genuine pager RPC, with a linked :TRAPPED request, zero callbacks, offset 26, TF clear, IF/RF set, and exact R8/R9 roots.  Restoration checks the gate's second invocation and changed-boot return, expired old controls, prior-command rejection without ID consumption, one request removal and callback, moving roots, a fresh step to offset 30, original values, one cleanup, and empty owned tables.  In the two-prompt test, the first HTTP polling request returned 408.  The original successful native completion was subsequently recovered without reexecution.  The development journal preserves that failure and the separate HTTP observations.  ARM64 execution remains untested.

### Guest debugger stops

Load the helpers and prepare a parked stop with a completed frame-list command:

```sh
sbcl --script tools/swank/lispm-eval --port "$SWANK_PORT" --timeout 180 <<'LISP'
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE.LISP"))
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE-RESTORE.LISP"))
(lispm-service-test::prepare-restore-test)
(mezzano.supervisor:snapshot)
(mezzano.supervisor:wait-for-snapshot-completion)
(values)
LISP
```

After preparation completes, stop the VM and start it from the same saved image using the launch command in [Installation and operation](../../doc/installation.md).  Then run:

```sh
sbcl --script tools/swank/lispm-eval --port "$SWANK_PORT" --timeout 120 \
  '(lispm-service-test::finish-restore-test) (values)'
```

For a running command blocked on a Lisp event, use `prepare-running-restore-test` and `finish-running-restore-test` in place of the parked-stop functions.  To test rollback from a completed original execution to the saved running state, issue this separate evaluation after snapshot completion and before VM restart:

```sh
sbcl --script tools/swank/lispm-eval --port "$SWANK_PORT" --timeout 120 <<'LISP'
(setf (mezzano.supervisor:event-state lispm-service-test::*probe-gate*) t)
(lispm-service-test::completed-command
 lispm-service-test::*running-restore-handle*
 lispm-service-test::*running-restore-command-id*)
LISP
```

The completion phase checks the restored state before releasing the event and recovering the application.

For queued-command expiration, use `prepare-queued-restore-test` and `finish-queued-restore-test` in place of the parked-stop functions.  Preparation stops the target thread with the supervisor's thread controls, then queues a restart command.  After restore, completion resumes the thread and checks that the old command expires without invoking the restart.  It then submits a fresh restart command and recovers the application.

For standard-value restoration, load those three native fixtures and call `(lispm-standard-values-test:prepare-restore-test)` on a dedicated VM with no retained stops.  Save a snapshot and wait for completion, then stop and restart that VM from the saved image.  Call `(lispm-standard-values-test:finish-restore-test)` after boot.  It checks retained nondefault controls, four correction warnings, history/selection/mode, retained text, expired old handles, prior-boot replay rejection, fresh evaluation and full GC, original program bindings after Proceed, one cleanup, and stop release.  This fixture covers a parked raw-thread condition stop.  Restoration during an executing warning command remains untested.

For frame-backed binding restoration, compile/load the service and frame-evaluation fixtures and follow the [frame-evaluation restore procedure](README.md#frame-evaluation-tests).  The parked helpers test a retained Lisp closure while rejecting old client frame handles.  The active helpers save an expression suspended in a continuable child debugger, defaulting to two continuation prompts.  Complete one restored copy with the default Proceed outcome and another with `:outcome :abort`.  Each completion checks original binding access, fresh-client requirements, prior-boot replay rejection, selection/history, GC, shared writes, cleanup counts, and release.  These tests require a dedicated guest and SAFETY 3, DEBUG 3, SPEED 1 compilation.

### Remote session restore

The host state file must survive the VM restart:

```sh
sbcl --script tools/swank/test-debugger-remote-restore.lisp \
  prepare "$SWANK_PORT" "$TEST_STATE_DIR/debugger-client-state.sexp"
```

Restart the VM from the prepared image, then run:

```sh
sbcl --script tools/swank/test-debugger-remote-restore.lisp \
  finish "$SWANK_PORT" "$TEST_STATE_DIR/debugger-client-state.sexp"
```

### Evaluation job restore

The evaluation test uses a host state file for one completed job and one condition-stopped job with partially consumed batch input:

```sh
sbcl --script tools/swank/test-evaluation-reconnect.lisp \
  "$SWANK_PORT" prepare "$TEST_STATE_DIR/evaluation-restore-state.sexp"
```

Restart the VM from the prepared image, then run:

```sh
sbcl --script tools/swank/test-evaluation-reconnect.lisp \
  "$SWANK_PORT" finish "$TEST_STATE_DIR/evaluation-restore-state.sexp"
```

For an interactive job waiting within a partially read line, use `prepare-input` and `finish-input` in place of `prepare` and `finish`, with a separate host state file.

For queued and running evaluation interruptions, use `prepare-interrupt` and `finish-interrupt` with a separate host state file.  The queued request must expire after restore.  The running interrupt stop must continue through a fresh session with one body entry and one cleanup.

After a successful restore test, save the completed guest state:

```sh
sbcl --script tools/swank/lispm-eval --port "$SWANK_PORT" --timeout 180 \
  '(mezzano.supervisor:snapshot) (mezzano.supervisor:wait-for-snapshot-completion) (values)'
```

This replaces the saved test stop with the completed state.

## Full image build and CI boot

[Installation and operation](../../doc/installation.md) describes the MBuild layout, host dependencies, and file server.  The commands below assume the checkout is MBuild's `Mezzano` directory.  The CI image is separate from the live VM image.  Builds share the generated target cache and must run sequentially.

```sh
MBUILD_ROOT="$(cd .. && pwd)"
make -C "$MBUILD_ROOT/home/asdf"
rm -rf -- build-x86-64
CI=true sbcl --dynamic-space-size 2048 \
  --load "$MBUILD_ROOT/quicklisp/setup.lisp" \
  --script tools/build-image.lisp "$MBUILD_ROOT/mezzano-ci" \
  > "$MBUILD_ROOT/ci-build.log" 2>&1
```

The file server must remain available.  Its SBCL backend accepts concurrent clients with independent file handles.  The [host file-server tests](../../file-server/TESTING.md) specify that backend's acceptance.  Concurrent service for the non-SBCL backend remains untested.

On an x86-64 host with KVM:

```sh
ci_status=0
qemu-system-x86_64 \
  -enable-kvm -smp 2 -m 2G \
  -drive "file=$MBUILD_ROOT/mezzano-ci.image,format=raw,if=ide" \
  -vga std -display none -monitor none -serial stdio \
  -netdev user,id=net0 -device virtio-net,netdev=net0 \
  -device isa-debug-exit,iobase=0xf4,iosize=0x04 \
  -no-reboot < /dev/null > "$MBUILD_ROOT/ci-serial.log" 2>&1 || ci_status=$?
printf 'QEMU exit status: %s\n' "$ci_status"
test "$ci_status" -eq 3 || exit 1
rg --color never -F 'CI build completed successfully!' "$MBUILD_ROOT/ci-serial.log"
```

Success requires both QEMU exit status 3 and the serial marker.  This boot includes desktop initialization.

## Test catalog

| Test source | Scope |
|---|---|
| `test-lispm-eval.py` | Evaluation, encoding, output, multiple values, errors, flow control, and timeout behavior. |
| `test-cpu-printing.lisp` | Printing every live x86-64 CPU with its architecture type, APIC ID and state before/after full GC.  Compile/load ordinary and call LISPM-CPU-PRINTING-TEST:RUN. |
| `test-structure-layouts.lisp` | Load as source for sequential redefinition.  Tests inherited access, saved compiled predicates/readers/writers across slot addition and reparenting, object/hash-key identity, and moving GC. |
| `test-interpreter-source.lisp` | Absent/present interpreter source filenames, captured closures, invalid source errors, and lazy type expansion.  Compile/load and call LISPM-INTERPRETER-SOURCE-TEST:RUN. |
| `test-command-io.lisp` | Batch/jobless command streams, Unicode input replay/conflicts, output ranges, EOF isolation, nested reader Abort, expired control, closure/restoration of stream bindings, and cleanup.  Load the service fixture helpers, compile/load this fixture, and call LISPM-COMMAND-IO-TEST:RUN. |
| `test-foothold-gc.lisp` | Movable objects in eight x86-64 data registers across an injected foothold and full GC. |
| `test-interrupt-return-gc.lisp` | GC and resumption at the observed x86-64 interrupt-return instruction addresses, in full-save state and beneath another foothold. |
| `test-gc-restart.lisp` | Raw instruction-address rewriting and resumption for an x86-64 GC restart region, in full-save state and beneath a foothold. |
| `test-cons-allocation-gc.lisp` | The observed instruction addresses on the x86-64 DO-CONS success path in both saved states, with restart-address checks and relocated CAR/CDR values after resumption. |
| `test-remote-eof.lisp` | Remote OPEN recovery from stale CLOSE-WAIT and orderly EOF, safe PROBE retry limits, and unreplayed CREATE.  Checks cache eligibility, original condition identity outside the host mutex, explicit RETRY, automatic TCP retry limits, semantic server replies, multiple values/nonlocal exits, and abort-close failures.  Compile/load and call LISPM-REMOTE-EOF-TEST:RUN.  PREPARE-PARKED-FAILURE starts an owned EOF probe for fresh-client debugger inspection/Abort.  FINISH-PARKED-FAILURE checks and releases its resources afterward.  Both helpers are internal to that package. |
| `test-frame-locals.lisp` | Distinct SWANK local IDs and lookup. |
| `test-frameless-backtrace.lisp` | Deterministic x86-64 frameless interruption, adjacent debug-3 caller, unavailable callee stack slots, caller locals, moving GC, continuation, and cleanup.  Load the control fixture first, compile/load this file, and call LISPM-FRAMELESS-TEST:RUN. |
| `test-debugger.lisp` | SLDB inspection, function repair, restart values, concurrent evaluation, and cleanup on one connection. |
| `test-spill-interference.lisp` | Spill graph edges, ascending register order, scalar and SIMD slot assignments, and bit-vector reuse. |
| `test-live-ranges.lisp` | Live/debug/dead transitions, aliased debug values, empty inputs, and 800 preserved variables in register allocation. |
| `test-debug-bindings.lisp` | Preserved binding visibility and lower-debug propagation. |
| `test-debug-binding-writes.lisp` | Internal writes, independent copies, constants, loops, multiple-value bindings, and GC. |
| `test-debug-write-flow.lisp` | Type-changing internal writes after arithmetic, type, identity, and vector tests at debug 3 and safety 3. |
| `test-debug-closure-writes.lisp` | Shared captured bindings, parameter forms, escaped closures, and GC. |
| `test-debug-policy.lisp` | Local debug declarations, preserved heap roots, writes, and GC. |
| `test-keyword-lowering.lisp` | Keyword semantics and allocation at debug levels 1 and 3. |
| `test-jump-table-bindings.lisp` | Branch binding cleanup and invalid selectors. |
| `test-debugger-interrupt.lisp` | Computing-printer and restart-reader interruption, continuation, command abort, nested request restoration, nested input wait accounting, inhibited delivery, replay, busy rejection, and cleanup.  Load the control fixture first, then compile/load this file and call LISPM-DEBUGGER-INTERRUPT-TEST:RUN. |
| `test-debugger-control.lisp` | Nested command abort, parent recovery, typed command parsing, returning and interactive restarts, replay, cleanup, and Listener reuse.  Compile and load the file, then call LISPM-DEBUGGER-CONTROL-TEST:RUN. |
| `test-debugger-service.lisp` | Ownership, frames, GC, duplicate commands, child stops, repair, values, release, and cleanup. |
| `test-debugger-service-restore.lisp` | Guest handles, completed-command history, queued-command expiration, and a running restart blocked on a Lisp event across restore. |
| `test-evaluation-service.lisp` | Batch submission identity, source order, package changes, values, condition/printer recovery, GC, abort, release, and interactive stream behavior. |
| `test-evaluation-interrupt.lisp` | Computing/input-waiting interruption, locals, GC, continuation, abort, cleanup conditions/transfers, duplicate requests, existing stops, startup, inhibited delivery, and self-interruption rejection. |
| `test-evaluation-reconnect.lisp` | Unread creation reply, duplicate submission, session release during execution, fresh-session condition recovery, output/results, foreign tokens, GC, cleanup, release, completed/stopped batch jobs across restore, interactive disconnect, input/EOF replay, interactive restore, unread interrupt replies, and queued/running interrupt restore. |
| `test-debugger-reconnect.lisp` | TCP disconnect, exclusive control, token rejection, unread replies, and duplicate restart submission. |
| `test-document-examiner.lisp` | Documentation coverage, topic hierarchy, links, search modes, command assistance, and Unicode offsets through SWANK. |
| `test-private-documents.lisp` | Ordered/duplicate/empty reference files, pathname defaults and Unicode, malformed/circular/reader-eval rejection, unchanged files after invalid input, lost replies, replay without another write or catalog lookup, conflicts, and owned-fixture cleanup. |
| `test-processes.lisp` | Processes serialization, shared and repeated stop tokens, bounded handle storage, cyclic job labels, and Show Processes completion/help/output.  Loads the guest fixture. |
| `test-processes-guest.lisp` | Duplicate names, exact and nested stop associations, event/mutex waits, stale wait items, hostile printers, circular/bounded labels, recorded runtime, concurrent thread creation/exit, and release behavior.  Runs through the transport script. |
| `test-listener.lisp` | Listener commands, completion, defaults, file operations, presentations, independent Listeners, interactive input, and replay after unread replies and package changes. |
| `test-debugger-remote-restore.lisp` | Saved/absent sessions, old tokens/frames, storage retirement, and restored-stop recovery. |

## Foothold and mutex tests

On a dedicated guest built with the current foothold macros, compile and load `diagnose-mutex-termination-kernel.lisp` with the kernel policy and `:WIRED T`.  Compile and load `diagnose-mutex-termination.lisp` and `test-foothold-mutex.lisp` with ordinary allocation, then call `(lispm-foothold-mutex-test:run)`.

The suite checks nested delivery permissions, multiple values and nonlocal exits, recursive ownership, nonblocking contention, blocked cancellation, ownership handoff, repeated termination during release, the unchanged compiler worker's reply-lock release, and compiled macro continuations with explicit moving GC.  The release probe temporarily replaces the consistency-check function and restores it afterward.  The compiler-worker test reads both EXIT messages and requires both workers to reach DEAD.

For production saved-state testing, compile and load `test-foothold-restore.lisp` with ordinary allocation.  On a dedicated guest with no other restore fixture prepared, call `(lispm-foothold-restore-test:prepare)`, complete a normal Snapshot, and restart that image.  Then call `(lispm-foothold-restore-test:finish)` without reloading the fixture.  Completion requires a new boot ID.  The two cases preserve one- and two-prompt captured continuations, queued callbacks, delivery permissions, eight movable return values, and collection during callback delivery.  This fixture passed after normal Snapshot and restart on x86-64 QEMU under DEBUG 3/SAFETY 3/SPEED 1.  ARM64 execution remains untested.

The instrumented [foothold binding prototype](foothold-prototype/README.md) supplies separate forced-interleaving and saved-continuation tests.  Its transfer-boundary collection hooks are absent from production helpers.  Its results do not establish ARM64 behavior or safety of older compiled macro expansions.
