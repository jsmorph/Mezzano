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

Load ordinary debugger, evaluator, Command Processor, SWANK, and test files with LOAD's default allocation policy.  The image builder uses the same policy for these modules.  Explicit wired loading is reserved for supervisor/runtime code with the residency requirements below.  Forcing ordinary test code and constants into the wired area can exhaust its available blocks despite repeated full collection.

The instruction-position and saved-register tests target x86-64.  Compiler tests select the policies they exercise.  The default running compiler policy is `(safety 3 debug 3 speed 1)` and the image bootstrap policy is `(safety 3 debug 1 speed 1)`.  These tests do not establish ARM64, bare-metal, supervisor-trap, or arbitrary-suspension support.

## Kernel compilation

The image builder compiles supervisor code with `(safety 3 debug 1 speed 1)`.  The running Lisp compiler defaults to debug level 3 for application inspection.  Live supervisor replacements require the kernel policy and `LOAD` with `:wired T`, which keeps their code and constants resident.

The debug-level-3 compilation of PAGER-ALLOCATE-PAGE retains calls to BYTE-POSITION and BYTE-SIZE.  Those functions occupy pageable memory.  Paging can therefore fault inside the pager after a live replacement built with the application policy.  Loading the caller into wired memory alone leaves those callees pageable.  Kernel replacement review must check generated calls as well as the replacement's allocation area.  A fresh image build and a boot under memory pressure test the compiled kernel and its callees together.

## Transport and guest tests

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

The [compilation-error fixture](README.md#evaluator-environment-tests) checks compiler condition identity, single expansion on failure, lazy-function retry after ERROR and THROW, recursive forcing, completed target reuse, and rejection of serialization during compilation.  Its macros and state belong to each test invocation and are removed on exit.

The [instruction-scope fixture](README.md#compiler-lexical-environment-tests) checks scope selection at exact instruction offsets, empty versus unavailable scope, alignment, identity shared with location records, compiled-file loading, full GC, and legacy records.  Its scope objects are fixture data.  It does not establish compiler source-environment conversion or live frame evaluation.

The [source-scope fixture](README.md#compiler-lexical-environment-tests) checks compact conversion of native compiler environments, shadowing in each namespace, type and optimization declarations, macro identity/state, control-scope identities, compiled-file sharing, and full GC.  Reload its compiled file before each RUN.  The backend cases use DEBUG 0/3 and COMPILATION-SPEED 1/3 with SAFETY 3 and SPEED 1.  The target-macro fixture checks native serialization of target constants, shared identity, target/native state, defining environments, compilation failure and retry, and full GC.  Reload its compiled file before each RUN.

The emitted-scope fixture checks compiler-generated records against live x86-64 call addresses and binding storage, including nested and disjoint bindings, namespaces, local macros, scope exit, mutation, compiled-file loading, and full GC.  It exercises DEBUG 0/3 and COMPILATION-SPEED 1/3 with SAFETY 3 and SPEED 1, and checks values at DEBUG 3.  Direct emitter checks cover both architectures.  These results do not establish ARM64 execution or a host cross-build.  The [frame-evaluation fixture](README.md#frame-evaluation-tests) separately checks live bindings, writes, declarations and representations, histories, replay, nested recovery, GC, continuation, and lifetime rejection.  Load the debugger-service fixture for its helpers before compiling it.

The internal x86-64 frame-return fixture requires the debugger-service and frame-evaluation fixtures for their helpers.  Compile and load `TEST-FRAME-RETURN.LISP` after loading the corresponding `system/debug.lisp` and `debugger-service.lisp`, reject compilation warnings or failure, then call `(lispm-frame-return-test:run)`.  It tests zero/one/seven values, single-value and ignored-value callers, invalid value lists, stack arguments, caller continuation, binding restoration, cleanup order and superseding exits, retained command replay, a continuable cleanup condition, full GC, and two continuation prompts.  Guard cases use real frameless and established LAP frames and a thread foothold.  Eight concurrent full collections exercise repeated transfers with heap values.  Concurrent collection does not establish collection at every epilogue instruction.  This fixture tests an internal helper.  The Return command uses the separate fixture below.  ARM64 execution and Reinvoke require separate acceptance.

Compile/load `TEST-FRAME-RETURN-COMMAND.LISP` after the service, frame-evaluation, and internal Return fixtures.  Call `(lispm-frame-return-command-test:run)`.  It tests expression/confirmation input, zero/one/seven values, lexical versus dynamic bindings, cancellation and history, replay, reader/evaluator/EOF failures and child Abort, unavailable scope before prompting, non-NIL argument rejection, parser/completion, GC, and a cleanup condition in a new root stop.  It runs on x86-64 at DEBUG 3, SAFETY 3, SPEED 1.

`PREPARE-RESTORE` in that package leaves an owned jobless thread at Return confirmation after one expression evaluation.  After the preparation driver releases, save the image, wait for snapshot completion, and restart that image.  `FINISH-RESTORE` obtains fresh control and confirms the original command.  It checks external-handle/frame expiry, prior-boot command rejection, exact input replay, original heap/multiple values, one evaluation, one cleanup, and thread/stop/controller release.  The running command retains its old executing function after fixture recompilation.

The standard-value fixture requires the debugger-service and frame-evaluation fixtures above.  Compile and load `TEST-STANDARD-VALUES.LISP` in the guest, rejecting compilation warnings or failure, then call `(lispm-standard-values-test:run)`.  It checks validity/defaults, bound NIL versus unbound controls, valid nondefault package/radices/float format, debugger edits and repeated validation, independent child contexts, warning printer Abort/repair, exact replay, selection/history, full GC, program binding restoration, and owned cleanup.  Its target policy is SAFETY 3, DEBUG 3, SPEED 1 on x86-64.

The selected-special-cell fixture requires the debugger-service and frame-evaluation helpers.  After loading the updated debugger service, compile and load `TEST-SELECTED-SPECIALS.LISP`, rejecting compilation warnings or failure, then call `(lispm-selected-special-test:run)`.  It checks selected inner/outer cells on ordinary stacks and at one and two nested continuation prompts, inherited bindings across stack segments, bound NIL and unbound cells, global fallback without creating a missing global cell, exact cell identity through full GC, rejection of an interrupted frame, unchanged history/selection, continuation, and owned cleanup.  It targets established x86-64 condition-stop frames at SAFETY 3, DEBUG 3, SPEED 1.  This fixture tests the internal lookup helper.  The special-evaluation fixture below tests expression execution.

The special-binding-context and special-evaluation fixtures require the updated runtime and debugger service.  Compile runtime changes at the kernel policy and load wired.  Compile the two fixtures at SAFETY 3, DEBUG 3, SPEED 1, rejecting warnings/failure.  Call LISPM-SPECIAL-BINDING-CONTEXT-TEST:RUN and LISPM-SPECIAL-EVALUATION-TEST:RUN.  The [native fixture reference](README.md#frame-evaluation-tests) describes their primitive, cache, cross-thread foothold, nested-debugger, and continuation tests.  Run these on a dedicated guest: the runtime fixture temporarily wraps its cache helper.  A synthetic interrupted frame checks explicit rejection and does not establish interrupt-frame evaluation support.

The Show Special fixture uses the same helpers and policy.  Load the updated debugger service and Command Processor, compile and load `TEST-SHOW-SPECIAL.LISP` without warnings or failure, then call `(lispm-show-special-test:run)`.  It tests Program/Debugger differences, NIL/unbound/missing cells, history and temporary -, prompt stacks, command defaults/completion and quoted arguments followed by keywords across space/tab/newline separators, invalid and unsupported options without command-ID consumption, copied arguments and replay, reader/printer child Abort and repair, package resolution, full GC, Proceed, and owned cleanup.  Streams inspection, ARM64 execution, and saved-image restoration remain untested.

The spill-interference fixture checks overlapping, adjacent, disjoint, repeated, and unused ranges, edges from every range of a spilled register, and scalar and SIMD slot assignment.  It compares with supplied previous implementations when requested and checks that dense bit-vector rows retain their identity across insertions.

## Pager reservation tests

From the Mezzano checkout, run the isolated host test:

```sh
sbcl --script tools/swank/test-pager-accounting.lisp
```

The test reads the production block-map constants and six pager functions.  Its one-page fixture replaces disk allocation, physical memory, page tables, and locking.  It checks reservation changes when releasing eager or lazy pages, realizing a lazy page during swap, rejecting a failed disk allocation, and releasing or replacing a snapshot-owned page.  Read-only and early-allocation cases check the existing paths.  These tests cover local accounting transitions.  Guest collection, paging, and snapshot tests provide separate system evidence.

## Snapshot and restore tests

Preparation saves a guest snapshot containing the fixture.  Completion runs after the VM starts from that image.  A test that has prepared a snapshot must finish before another restore fixture starts.

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

The file server must remain available.  It serves one VM connection at a time.  Pause the Web server and other development SWANK traffic during CI boot so another guest cannot retain that connection.  Resume those clients after the CI VM exits, including after a failed boot.

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
| `test-structure-layouts.lisp` | Load as source for sequential redefinition.  Tests inherited access, saved compiled predicates/readers/writers across slot addition and reparenting, object/hash-key identity, and moving GC. |
| `test-interpreter-source.lisp` | Absent/present interpreter source filenames, captured closures, invalid source errors, and lazy type expansion.  Compile/load and call LISPM-INTERPRETER-SOURCE-TEST:RUN. |
| `test-command-io.lisp` | Batch/jobless command streams, Unicode input replay/conflicts, output ranges, EOF isolation, nested reader Abort, expired control, closure/restoration of stream bindings, and cleanup.  Load the service fixture helpers, compile/load this fixture, and call LISPM-COMMAND-IO-TEST:RUN. |
| `test-foothold-gc.lisp` | Movable objects in eight x86-64 data registers across an injected foothold and full GC. |
| `test-interrupt-return-gc.lisp` | GC and resumption at the observed x86-64 interrupt-return instruction addresses, in full-save state and beneath another foothold. |
| `test-gc-restart.lisp` | Raw instruction-address rewriting and resumption for an x86-64 GC restart region, in full-save state and beneath a foothold. |
| `test-cons-allocation-gc.lisp` | The observed instruction addresses on the x86-64 DO-CONS success path in both saved states, with restart-address checks and relocated CAR/CDR values after resumption. |
| `test-remote-eof.lisp` | Remote OPEN recovery after orderly TCP EOF during its initial probe, the one-retry limit, and EOF after CREATE without replay.  Compile/load the fixture and call LISPM-REMOTE-EOF-TEST:RUN.  Uses a test-owned loopback peer. |
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
