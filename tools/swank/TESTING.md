# Remote debugger tests

These tests exercise guest compiler and debugger behavior, SWANK transport, evaluation jobs, Listener commands, and documentation operations.  [Web interface tests](web/TESTING.md) cover HTTP and browser behavior.  The [development journal](devnotes.md) records execution results, failures, and source revisions.

## Test environment

Run host commands from the Mezzano checkout.  The guest must use the corresponding compiler, runtime, and Slime contrib.  `SYS:SOURCE;` must expose this checkout, and the guest HOME directory must be writable.  The host needs SBCL, Python 3, and an IPv4 SWANK endpoint.  The retained client requires `/dev/urandom`.  `test-lispm-eval.py` invokes the checked-in executable, whose shebang requires `/usr/bin/sbcl`.

The transport scripts accept a port argument and connect to `127.0.0.1`.  A remote guest can be reached through an SSH local forward as described in the [remote client guide](README.md#connection-setup).  Choose the forwarded port:

```sh
SWANK_PORT="${SWANK_PORT:-4005}"
TEST_STATE_DIR="$(mktemp -d)"
```

Run guest tests sequentially on a dedicated test VM.  Tests define guest functions and packages, create threads and retained records, and may request full GC.  A failure can leave a stopped fixture for inspection.  Restore fixtures share counters and must run separately.  Their host state files must survive the VM restart.

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
| `test-structure-layouts.lisp` | Inherited structure predicates/access and redefinition. |
| `test-foothold-gc.lisp` | Movable objects in eight x86-64 data registers across an injected foothold and full GC. |
| `test-interrupt-return-gc.lisp` | GC and resumption at the observed x86-64 interrupt-return instruction addresses, in full-save state and beneath another foothold. |
| `test-gc-restart.lisp` | Raw instruction-address rewriting and resumption for an x86-64 GC restart region, in full-save state and beneath a foothold. |
| `test-cons-allocation-gc.lisp` | The observed instruction addresses on the x86-64 DO-CONS success path in both saved states, with restart-address checks and relocated CAR/CDR values after resumption. |
| `test-frame-locals.lisp` | Distinct SWANK local IDs and lookup. |
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
