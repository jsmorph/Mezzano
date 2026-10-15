# Web interface tests

The Python tests exercise HTTP and SWANK transport behavior.  The Chromium drivers exercise browser interaction against a running Web server and Mezzano guest.  Font and layout measurements have separate tools in the [font testing guide](fonts/README.md).

## HTTP and SWANK tests

Python 3.13 or later is required.  From the Mezzano checkout:

```sh
uv run --no-python-downloads --python python3 tools/swank/web/test_server.py
```

The isolated tests create local fake peers and HTTP servers.  They exercise framing, encoding, typed arguments, request-origin checks, error classification, retained connection reuse, per-request deadlines and output, session serialization, failed-socket disposal without replay, and idle closure.  Shutdown tests cover incomplete headers and bodies with continued input, HTTP cancellation while guest dispatch completes, thread-start failure, and constructor bind failure.  They do not require a running guest.

The live suite connects to SWANK on loopback.  The port is configurable:

```sh
uv run --no-python-downloads --python python3 tools/swank/web/test_server.py \
  --live-port 4005
```

It starts a temporary HTTP server and exercises evaluation, Unicode output offsets, returned values, replay, interactive input, condition stops, frame and local inspection, restart continuation, interruption, and child stops.  It also checks reuse of one initialized SWANK connection, detached guest ownership, idle closure and resume of the same session, and immediate connection closure on session release.  Its cleanup removes the functions, classes, jobs, stops, and session it created.

## Browser tests

The drivers require Node 24 or later and Chromium.  They use Node's built-in WebSocket API and require no npm packages.  `CHROMIUM` selects the browser executable when its name is not `chromium`.

The first argument is the Web server URL.  The second is the output directory for screenshots and diagnostics.  These examples target a server on loopback:

```sh
node tools/swank/web/test-browser.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-listener-test
node tools/swank/web/test-document-examiner.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-examiner-test
node tools/swank/web/test-private-document.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-private-document-test
node tools/swank/web/test-peek.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-peek-test
```

The Listener driver covers command assistance, evaluation and input history, guest file commands, Unicode presentations, interactive input, debugger commands and restarts, retained-request recovery, and release reconciliation.  It holds an initial frame-inspection reply across native mouse-down, then checks that refresh completion preserves the Debugger button's focus and pointer target before mouse-up.  It checks initial debugger inspection, Listener ownership through reload, typed Help through the owning Listener, and successful ordinary submission after CONTINUE.  The Examiner driver covers topics, mouse operations, candidate history, search options, bookmarks, named viewers, reload, reading positions, and print dispatch.  The private-document driver covers command menus, defaults, bookmark order, Save replay, Load, Read, Hardcopy, and file cleanup.

Each driver starts a separate headless browser profile and removes that profile on exit.  Successful runs release their owned guest sessions and fixtures.  Failed interactions save session state and fixture identities for inspection and cleanup.  The Listener and private-document tests create guest files and evaluation jobs.  They require a writable guest home directory.  Other clients' retained objects must remain untouched.

Lost-reply tests discard a completed HTTP response after server dispatch.  They exercise saved-request recovery rather than every possible transport failure point.  Print tests intercept print dispatch.  They do not verify physical printer output.  Browser screenshots require separate comparison before supporting a visual-fidelity claim.

## Debugger frame evaluation

The frame-evaluation driver compiles a named DEBUG 3 target and enters forms through the inline and standalone debugger inputs.  It checks shadowed bindings, same-name variable and function namespaces, symbol and local macros, immediate shared-cell writes, multiple and zero values, and per-stop histories.  Reader and type errors must enter child stops, and typed :Abort must preserve the parent and its bindings.  The target's uniquely named caller models legacy missing scope information: the fixture saves and clears that owned function's scope table during invocation and restores it through UNWIND-PROTECT.  Evaluation in that caller must reject unavailable scope information and permit recovery to the target.  Shared system and CLOS function metadata remains unchanged.  The driver discards one accepted reply, repeats its original request, and verifies one binding increment.  Reload and stop closure must retain the printed form results.  Continuation must observe the writes, and the next Listener expression must succeed.

```sh
node tools/swank/web/test-frame-evaluation.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-frame-evaluation-test
```

The target has required, optional, and keyword parameters.  :Show Arglist completion and typed/menu actions must display its active compiled signature after a second owned evaluation replaces the global function definition.  Frame selection and evaluation histories must remain unchanged, and reload must retain the signature text.

The same stopped target exercises :Show Function, :Show Compiled Code, and :Show Instruction after global redefinition.  Completion and menu actions must preserve selected-frame state.  Code captured before redefinition must remain identical afterward, and code inspection must preserve all nine history slots.  Show Function must assign the old active function only to *, leave the other eight slots unchanged, and make that function available to :Inspect.  The established caller must report Saved caller location.  A narrow viewport must preserve code columns and scroll long lines horizontally.  Reload must retain printed output without another command, and stop closure must preserve the text.  A second named function embeds an owned description probe as a compiled constant.  Its printer error must enter a child during disassembly.  Typed Abort, repair, another display, and Proceed must succeed.  Branch labels must have definitions in the code output.  A large owned function makes 1000 calls to an owned sink after its stop.  Its disassembly must exceed 64 KiB, retain every decoded row and the terminal instruction, match the displayed text before and after reload, and preserve history and selection.  Proceed must return 42/43 after recording the final sink argument 999.  Exact decoded bytes, interruption PCs, and unsupported code locations require the native fixtures.

The target and its caller establish special bindings with repeated shadowed values, bound NIL, and an unbound cell.  :Show Bindings tests typed completion and menu entry, selected/all-frame output, explicit keyword defaults, literal case-sensitive filtering, unchanged selection/history, and retained results across reload.  A binding with a failing printer must enter a child debugger.  Typed :Abort must return to the parent, and replacing that value with NIL must permit another inspection.

The driver compiles and loads the checked-in description fixture.  It checks that object and slot-value printer failures in DESCRIBE enter child debuggers, typed :Abort returns to the parent, and a subsequent description prints its slot value and returns zero values.  The reusable native fixture definitions remain loaded.

A separate named target stops inside an application HANDLER-CASE and UNWIND-PROTECT.  Errors from debugger evaluation and description printing must enter children, and typed :Abort must leave the application handler and cleanup counters at zero.  A handler established inside an evaluated form must remain effective.  Proceed raises an application error, which must invoke the restored handler once after one cleanup.

A handler-display target stops first inside nested handler bindings and then inside the invoked inner handler.  :Show Condition Handlers tests completion, menu entry, :All defaults, actual runtime owner-frame selection, active and inactive status, empty-frame output, unchanged selection/history, and retained strings across reload.  Proceed must invoke the remaining outer handler once and return the expected values after one cleanup.

A catch-display target nests two catches with the same tag and an outer catch with a printable object tag.  :Show Catch Blocks tests completion, menu entry, :All defaults, selected runtime owners, repeated tags, destination function names and byte offsets, empty-frame output, unchanged selection/history, and retained strings across reload.  A tag-printer failure must enter a child.  Typed :Abort and repair must permit another inspection.  Proceed must return two values through the inner repeated tag, with one cleanup and one execution after that catch.

The driver releases its jobs, stops, session, named functions, and special symbols.  It creates fresh stopped frames in the running guest.  Saved-frame restoration and other compiler policies require separate native tests.

## Object Inspector

The Inspector driver compiles a named DEBUG 3 target and navigates its arrays, cyclic cons cells, and instance slots through the browser.  It tests command completion, three retained panes, pagination and partial pages, history, reload, lexical replacement expressions, unbound slots, type and reader errors, interrupted input, and typed Abort.  Lost submission and input replies must replay once.  A completed store followed by a printer failure must remain effective without repeating its expression.  Refresh after an array shrinks must permit backward navigation.  Clear must expire old references while preserving the session and command ID, and a closed stop must retain disabled recorded panes.  Proceed and the following Listener expression must return the expected values.  Layout assertions require full local and component labels to fit on one line while long values wrap.  Disabled recorded values retain their readable text without action-button strike-through.

```sh
node tools/swank/web/test-inspector.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-inspector-test
```

The driver releases its named function and class, jobs, stops, and session.  It loads the checked-in description fixture for its failing printer.  Those shared fixture definitions remain loaded.  It creates fresh stops.  Saved-stop reference expiry requires the native restoration tests.

## Listener debugger input

The focused debugger driver tests inline and standalone Help, completion and contextual help, guest nesting prompts, ordinary and nested Abort, and interactive restart arguments through retained evaluation input.  It tests SPACE completion of :Proceed, omitted and explicit Default selection, the Proceed button, restart indices and the default marker, and missing-default rejection followed by explicit interactive selection in the same session.  It distinguishes a restart that exits the stop from one that returns a command result while the stop remains active, including visible values, zero values, and normally returning Proceed and typed Abort operations.  Native mouse clicks spanning a monitor refresh check that unchanged Debugger and restart actions retain their DOM elements and receive the click.  The restart test also renders a pending replacement query and changes an unrelated stop row while the mouse button is pressed.  A held action queue tests immediate debugger-menu dismissal.  Its nested operation-error case reloads at the child stop, aborts that command, verifies the restored outer draft and selection, and continues the original computation.  It interrupts blocked restart argument readers from a condition stop and from an earlier interruption stop, aborts each child, and completes the original computation.  It checks that invalid no-argument and restart-index requests return HTTP 400 without advancing the stop's command ID.

```sh
node tools/swank/web/test-listener-debugger.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-listener-debugger-test
```

Explicit-argument tests invoke a restart with required parameters and no interactive function, reload during its input wait, interrupt that reader, abort an expression error, and complete the original evaluation.  A separate fixture evaluates a dynamically bound expression, returns multiple values, and counts argument evaluation and restart invocation across a discarded accepted submission reply and exact-request replay.  Both counts must remain one.  The driver also checks Arguments completion, default selection, the per-restart button, and subsequent Listener evaluation.

`REPLAY_ITERATIONS` repeats the lost-reply argument restart, FINISH, and following Listener evaluation sequence.  It defaults to one.  Each repetition retains its request receipt and job identities in the result.

Frame tests check completion, typed and mouse selection, Next/Previous/Top/Bottom, zero movement, rejected targets without command-ID consumption, once-only relative motion after reply loss, and selection across reconnect and reload.  Parent and child selections remain independent.  External selection updates the highlight without executing another inspection.  A frame containing a local whose printer signals an error tests child Abort after mouse and external-controller selection, absence of automatic printing retries, suppression of results for a different frame, and recovery through an explicit frame command.  The broad Listener suite checks Show Frame, individual and all locals, unavailable-local rendering, and labelled recorded locals after a stop closes and its selection clears.

A compiled debug-3 fixture captures NIL and :$INACCESSIBLE-VALUE$ arguments in a reader closure.  Mouse selection checks that both bindings have true availability flags and display their values.  Continuation calls the closure, and another Listener form verifies reuse after the stop closes.

A second named debug-3 fixture contains an unused FLET function HELPER that captures an argument and an ordinary variable HELPER holding 41.  Mouse selection checks separate `(FUNCTION HELPER)` and `HELPER` records, true availability flags, and the displayed closure and integer.  Continuation and another Listener form both return 42.

A named, no-argument debug-3 target calls a NOTINLINE helper inside and after separate LET scopes for X=37 and Y=41.  Four condition stops and mouse frame selections check that each binding appears only inside its scope.  Proceed continues each stop, and both the target and the next Listener evaluation return 42.

The driver tests both typed Proceed and the CONTINUE button for continuation.  `PROTECTED_STOP` optionally names a numeric stop ID whose state and next command ID must remain unchanged.  The result records browser errors and failed HTTP requests and response bodies, including across page reloads.  The driver records its session and releases its owned evaluations, stops, and session.

## Expired sessions

The session-recovery driver releases its own guest session to test expiration during startup, evaluation submission, command completion, documentation lookup, and process sampling.  It checks request and debugger-command archives, input and viewer history, renewed tokens, and a Lisp counter that detects repeated evaluation.  It also checks that recovery from a transport failure resumes the same session and that other rejected requests preserve the session.

```sh
node tools/swank/web/test-session-recovery.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-session-recovery-test
```

The test creates and removes its own Lisp counter, retained evaluations, debugger stop, and sessions.  It saves failed-run identities for cleanup.  Expiration uses the live guest's release operation.  Constructed failures cover a lost successful reply, a transport failure, and another typed rejection.

## Peek and activity navigation

The Peek driver tests SELECT navigation, input preservation, product-guide links, live process fields, 980-pixel column bounds with a 160-character name, Describe, retained-stop selection, Show Processes, and continuation/cleanup of its own condition fixture.  It creates one named worker and two retained evaluations, then releases their objects and its session.  The `--navigation-only` option exercises activity selection and product documentation without creating guest jobs.

The separate fixture driver replaces every API response before the application loads, so it requires the static Web files but no guest.  It exercises duplicate names, text rendering, expired-session stop links, delayed nonoverlapping requests, failed-sample retention, automatic retry after a released-stop error, and reconnection after a transport error.  It also verifies polling suppression in Help mode, another activity, and a simulated hidden-tab event.  The latter does not establish scheduling behavior for every browser's background-tab throttling.

```sh
node tools/swank/web/test-peek-fixtures.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-peek-fixtures
```

The fixture capture includes original process strings for selected font and position comparisons.  It labels its results as fixture-only and records zero guest requests.  The [Peek layout comparison](fonts/compare-peek-layout.py) measures those selected rectangles against the recorded source font rasters and original positions.

## Missing documentation references

The focused test retains an absent document, an absent child heading, and a valid document in one viewer.  It checks unavailable entries, the valid content, bookmark preservation, and reload.  Separate constructed responses verify that a transport failure remains a connection error and that a later successful lookup replaces an unavailable entry.

```sh
node tools/swank/web/test-missing-document.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-missing-document-test
```

The test creates no guest jobs or files and releases its session.  Its four live missing-topic requests must produce HTTP 409 responses.  Constructed error responses do not generate browser network errors.  The driver rejects unexpected browser errors and preserves its session record on failure.

## Listener herald

The focused herald driver tests the initial system display with existing retained jobs, plain and detailed Show Herald commands, original-request replay after a discarded reply, Unicode presentation ranges, untrusted text, activity switching, narrow layout, and Clear Output History across reply loss and reload.  It verifies that ordinary output containing the command name remains ordinary text.  It releases only the jobs and session it creates.

```sh
node tools/swank/web/test-herald.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-herald-test
```

The test records command identities before replay and preserves failed-run state for cleanup.  The isolated HTTP suite also verifies both herald font routes.  Recovered-glyph and historical-position comparisons remain separate from command and recovery tests.

## Clearing retained state

The Clear All tests delete retained evaluations across every Listener.  Run them only on a guest whose retained evaluation state may be discarded.

Compile and load the guest test, then invoke it from a retained evaluation:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-CLEAR-ALL.LISP"))
(lispm-clear-all-test:run :allow-global-clear t)
```

The test checks returned jobs, running evaluations, interactive input waits, debugger stops, cancellation before evaluation entry, a waiting concurrent clear, unwind cleanup, Listener package/pathname preservation, and preservation of a submission created after target capture.  Its invoking evaluation survives.

The browser driver tests same-Listener input waiting, guest release, this-tab histories, retained command receipts, document-viewer preservation, reload, and replay after a lost reply:

```sh
node tools/swank/web/test-clear-all.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-clear-all-test --allow-global-clear
node tools/swank/web/test-clear-all-fixtures.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-clear-all-fixtures
```

The second driver supplies every API reply locally and makes no guest requests.  It checks captured history boundaries, foreign command receipts, lost-reply reconciliation, and preservation of later records.  The live driver releases its surviving receipts, later evaluation, and session.

## Bounded output

The live driver creates a 524,800-character Unicode output job and a short output job.  It checks progress for both jobs, the aggregate response limit, contiguous offsets, exact final text, and command completion and documentation lookup while unread output remains.  It releases its two jobs and session.

```sh
node tools/swank/web/test-large-output.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-large-output-test
node tools/swank/web/test-output-fixtures.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-output-fixtures
```

The second driver supplies API replies locally and makes no guest requests.  It splits Unicode output across pathname and herald presentation boundaries, checks transfer status and exact accumulation, and rejects invalid ranges and unknown presentation types.

## Inline topic references

The focused inline-reference test checks that a wrapped topic reference and its following punctuation share the final text baseline.  It exercises focus, Enter and SPACE activation, mouse reading, overview, and the topic menu against a live catalog.  It creates no guest jobs or files and releases its session.

```sh
node tools/swank/web/test-document-inline.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-inline-reference-test
```

## Documentation commands and private-file errors

The focused command driver submits Show Documentation, Show Table of Contents, and Show Overview through the Examiner command input.  It selects Exact, Initial, and Substring searches through the right-click options menu and checks all-term matching, word order, and adjacency.  It tests empty-pathname parsing and second-SPACE acceptance without accessing the default private file.

```sh
node tools/swank/web/test-document-commands.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-document-commands-test
```

The driver saves and reads one unique private file through a relative logical pathname.  It then replaces that owned file with malformed records, improper and circular lists, truncated input, and reader-evaluation syntax.  It checks distinct errors for invalid contents, a missing topic, and a missing file, with unchanged viewer state and successful subsequent queries.  Its cleanup removes the owned file and releases its jobs and session, including after failed assertions.  Expected HTTP 409 responses are counted separately from unexpected browser errors.

## Saved images

The x86-64 CPU observer and native waiter fixture test snapshot exclusion and restoration.  Compile both guest test files and load their output into wired memory:

```lisp
(dolist (source '("SYS:SOURCE;TOOLS;SWANK;TEST-SNAPSHOT-CPU.LISP"
                  "SYS:SOURCE;TOOLS;SWANK;TEST-SNAPSHOT-SYNC.LISP"))
  (multiple-value-bind (output warnings failure) (compile-file source)
    (declare (ignore warnings))
    (assert (not failure))
    (load output :wired t)))
```

Prepare the two native waiters and install the CPU observer before saving:

```lisp
(lispm-snapshot-sync-test:prepare)
(lispm-snapshot-cpu-test:install)
(mezzano.supervisor:snapshot)
(mezzano.supervisor:wait-for-snapshot-completion)
(lispm-snapshot-cpu-test:observation)
(lispm-snapshot-cpu-test:check)
```

CHECK requires copying on a CPU other than the timer's BSP, with unchanged PIT and runtime counts for at least 10 milliseconds and completed peer acknowledgments.  OBSERVATION identifies the CPU and measurements.  A BSP-only run requires another attempt to exercise peer exclusion.  Record the complete observation before restart: the saved observer record represents an intermediate point in copying.

After restarting the saved image, remove the temporary observers and finish the waiter tests:

```lisp
(lispm-snapshot-cpu-test:uninstall)
(lispm-snapshot-sync-test:finish)
```

FINISH requires a new boot.  It checks saved sleeping-state and queue relationships, notification, timer expiration, mutex reacquisition, and cleanup.  FINISH with :RESTORED NIL tests the same native operations without restarting.  CLEANUP cancels and joins only the fixture's waiters.  Remove the CPU observers before saving the final operating image.

### Browser restoration

The browser driver retains a session, a completed counter evaluation, and input history while the operator saves and restarts the VM.  Use a fresh output directory:

```sh
node tools/swank/web/test-image-restore.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-image-restore-test
```

After READY appears, save the guest, wait for snapshot completion, stop QEMU, and restart the saved image.  Once SWANK responds, signal the driver from another terminal:

```sh
touch /tmp/mezzano-image-restore-test/restored
```

The driver reloads the browser and checks session replacement, retained result/history, an unchanged counter value, current documentation, and live Processes data.  It removes its counter symbol, jobs, and session.  Expected HTTP errors during the deliberate outage and expired-session recovery are recorded separately from subsequent browser operations.  The driver requires restart confirmation within 15 minutes.
