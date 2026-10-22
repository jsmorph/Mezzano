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

## Frame and rest arguments

The intercepted fixture serves the Web files locally and replaces every API request:

```sh
node tools/swank/web/test-rest-argument-fixtures.mjs \
  http://127.0.0.1:8786/ /tmp/mezzano-rest-argument-fixtures
```

It checks typed and menu parsing, null operands, opaque guest text for available NIL/absent/unavailable states, canonical captions, same-ID replay after a lost accepted reply, both editors, reload, and closed/prior-boot history.  The same fixture checks full-frame argument text as an opaque multiline Unicode string, local-only filtering, frame movement, active/closed reload without resubmission, and historical results lacking the field.  Seven indexed-argument display cases cover default/All/index input, both editors and menu, exact operands, opaque Unicode and markup-looking text, available NIL and synthetic unavailable text, canonical recovery captions, accepted-ID replay, and active/closed reload without another execution.  It requires zero API HTTP requests.

One native headless Chromium case compiled a named DEBUG 3/SAFETY 3/SPEED 1 rest target in the Listener.  Typed Show Rest Argument displayed the current list, assigned only * with all nine history identities checked, and preserved selected frame/generation.  Proceed returned the original values and ran one cleanup.  The test released its stop, four helper jobs, Listener job, symbols/function and session.  Node, Chromium, wrapper and execution observer exited zero.  Native unavailable-value, printer-error and declared-DX semantics belong to the [guest fixture](../TESTING.md), which passed twelve cases.  Restoration of this command across a saved-image boot remains untested.

A separate native headless Chromium case compiled a named DEBUG 3/SAFETY 3/SPEED 1 target, changed its required and rest parameters, and typed Show Frame in its owning Listener.  The displayed argument string exactly matched the guest result, separating original :FRAME-DONE/11/22 from current :CURRENT-MARKER/(:CURRENT-TAIL).  Replaying the accepted command preserved the full result, next ID, generation, selection, and all nine history-cell identities.  Proceed returned the original values after one cleanup.  The target, stop, four helper jobs, symbols/function, and browser session were released.  Node, Chromium, wrapper, and observer exited zero.

The native indexed-argument case used the same named required/rest target and saved the exact modified rest list.  Typed Show Frame displayed source indices 0/1.  Show Argument All preserved all nine history identities.  Show Argument 1 assigned only * and Inspect returned the same object by native EQ identity.  Accepted argument/1 replay preserved the result, next ID, frame and generation.  Proceed returned the original values after one cleanup.  The closed stop, target, five helper jobs, two symbols/function, session and browser profile released.  All six bracketing guards passed, with no browser errors and separate zero Node, Chromium, wrapper and observer exits.

The native argument-location case used a declared LIST rest parameter.  Indexed Show Argument assigned its exact checked location to + and current value to *, preserving the other seven history values.  Evaluating + rotated history normally and made the location available to Inspector, whose single Value row supported modification.  Named CL:REST and indexed DBG:ARG reads/writes agreed with DBG:LOCATION-VALUE.  Inspector input 42 entered a TYPE-ERROR child with expected type LIST and retained its one normal input-history rotation.  Typed Abort abandoned the store.  Readback verified the parameter retained its prior identity.  Replaying the original indexed command preserved all current history identities and did not republish its older values.  Proceed returned original values after one cleanup.  The target, nine helper jobs, two stops, symbols/function, session and profile released.  Six guards passed, with 177 completed browser requests, no errors, and separate zero process exits.

## Debugger frame evaluation

The frame-evaluation driver compiles a named DEBUG 3 target and enters forms through the inline and standalone debugger inputs.  It checks shadowed bindings, same-name variable and function namespaces, symbol and local macros, immediate shared-cell writes, multiple and zero values, and per-stop histories.  Reader and type errors must enter child stops, and typed :Abort must preserve the parent and its bindings.  The target's uniquely named caller models legacy missing scope information: the fixture saves and clears that owned function's scope table during invocation and restores it through UNWIND-PROTECT.  Evaluation in that caller must reject unavailable scope information and permit recovery to the target.  Shared system and CLOS function metadata remains unchanged.  The driver discards one accepted reply, repeats its original request, and verifies one binding increment.  Reload and stop closure must retain the printed form results.  Continuation must observe the writes, and the next Listener expression must succeed.

```sh
node tools/swank/web/test-frame-evaluation.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-frame-evaluation-test
```

The target has required, optional, and keyword parameters.  :Show Arglist completion and typed/menu actions must display its active compiled signature after a second owned evaluation replaces the global function definition.  Frame selection and evaluation histories must remain unchanged, and reload must retain the signature text.

The same stopped target exercises :Show Function, :Show Compiled Code, and :Show Instruction after global redefinition.  Completion and menu actions must preserve selected-frame state.  Code captured before redefinition must remain identical afterward, and code inspection must preserve all nine history slots.  Show Function must assign the old active function only to *, leave the other eight slots unchanged, and make that function available to :Inspect.  The established caller must report Saved caller location.  A narrow viewport must preserve code columns and scroll long lines horizontally.  Reload must retain printed output without another command, and stop closure must preserve the text.  A second named function embeds an owned description probe as a compiled constant.  Its printer error must enter a child during disassembly.  Typed Abort, repair, another display, and Proceed must succeed.  Branch labels must have definitions in the code output.  A large owned function makes 1000 calls to an owned sink after its stop.  Its disassembly must exceed 64 KiB, retain every decoded row and the terminal instruction, match the displayed text before and after reload, and preserve history and selection.  Proceed must return 42/43 after recording the final sink argument 999.  Exact decoded bytes, interruption PCs, and unsupported code locations require the native fixtures.

The source-display case writes one uniquely named source file, compiles it, and stops its DEBUG 3 function.  Typed SPACE completion, help, and menu commands in both views must show the exact input, including Unicode, a tab, markup-looking comments, and a long line.  Horizontal/page reading position must survive refresh.  A second tracked job rewrites and recompiles that file.  Default display must retain the old executing input, while an explicit name shows the current definition.  A COMPILE-only function must report missing text.  Discarded accepted replies, exact-ID replay, descriptor-loss reload, unchanged selection/mode/Inspector/nine histories, closed-stop output, original continuation, owned-file/definition cleanup, and the next Listener expression must pass.  The driver retains the first assertion failure and records capture or cleanup failures separately.

An owned DEBUG 3 maker returns a closure with an inherited variable, function binding, and printer probe.  Its current parameter is captured by a mutating inner reader.  :Show Lexical Environment completion and menu actions must show the inherited bindings and exclude the current captured parameter.  Selection and all nine history slots must remain unchanged.  Reload must retain output without another command.  Arming the inherited probe after initial frame inspection must produce a child printer error.  Typed :Abort preserves the parent and selected frame, repair permits another display, and Proceed must return the expected captured values after one cleanup.  The next Listener form verifies definition cleanup and reuse.  This case uses ancestor bindings retained for subsequent execution.

The target and its caller establish special bindings with repeated shadowed values, bound NIL, and an unbound cell.  :Show Bindings tests typed completion and menu entry, selected/all-frame output, explicit keyword defaults, literal case-sensitive filtering, unchanged selection/history, and retained results across reload.  A binding with a failing printer must enter a child debugger.  Typed :Abort must return to the parent, and replacing that value with NIL must permit another inspection.

The driver compiles and loads the checked-in description fixture.  It checks that object and slot-value printer failures in DESCRIBE enter child debuggers, typed :Abort returns to the parent, and a subsequent description prints its slot value and returns zero values.  The reusable native fixture definitions remain loaded.

A separate named target stops inside an application HANDLER-CASE and UNWIND-PROTECT.  Errors from debugger evaluation and description printing must enter children, and typed :Abort must leave the application handler and cleanup counters at zero.  A handler established inside an evaluated form must remain effective.  Proceed raises an application error, which must invoke the restored handler once after one cleanup.

A handler-display target stops first inside nested handler bindings and then inside the invoked inner handler.  :Show Condition Handlers tests completion, menu entry, :All defaults, actual runtime owner-frame selection, active and inactive status, empty-frame output, unchanged selection/history, and retained strings across reload.  Proceed must invoke the remaining outer handler once and return the expected values after one cleanup.

A catch-display target nests two catches with the same tag and an outer catch with a printable object tag.  :Show Catch Blocks tests completion, menu entry, :All defaults, selected runtime owners, repeated tags, destination function names and byte offsets, empty-frame output, unchanged selection/history, and retained strings across reload.  A tag-printer failure must enter a child.  Typed :Abort and repair must permit another inspection.  Proceed must return two values through the inner repeated tag, with one cleanup and one execution after that catch.

The driver releases its jobs, stops, session, named functions, and special symbols.  It creates fresh stopped frames in the running guest.  Saved-frame restoration and other compiler policies require separate native tests.

The Listener debugger, jobless command-I/O, Return, frame-evaluation, evaluation-environment, standard-value-warning, Show Special, Inspector, and HTTPS drivers accept PROTECTED_STOPS as a comma-separated list of existing stop IDs.  They require each stop to exist at startup and retain its state, generation, and next command counter through cleanup.  PROTECTED_STOP remains available for one ID.  PROTECTED_STOPS takes precedence when both are set.  The drivers select and release only their recorded jobs and owned stops.

The evaluation-environment driver first compiles one owned DEBUG 3 function whose lexical argument shadows a separately established global value.  It tests typed commands and SPACE completion, distinct lexical/global reads and writes, Control-X I in both debugger editors, draft/cursor retention, arrows and editing prompts, history/selection/reload, child inheritance and independent mode changes, typed Abort, and exact-ID replay after a discarded accepted toggle reply.  Proceed must observe both writes, cleanup must remove the fixture definitions and symbols, and the next Listener must return 42.

Four additional groups use a second owned DEBUG 3, SAFETY 3, SPEED 1 fixture with nested special bindings and compiled reader/writer helpers.  Lexical direct and compiled accesses must use the selected original outer or inner cell, while dynamic evaluation uses the point-of-error cell.  Show Special Program/Debugger verifies the distinct writes.  LET and PROGV must shadow those cells, including a fresh unbound binding.  Bound NIL, original-cell unbinding/restoration, global fallback, and typed Abort after an unbound compiled read are checked separately.

A child entered during evaluation must see its new binding and permit selection of the original program frames.  Independent child mode/control edits and typed Abort must restore the parent's selection, nine history values, controls, and mode.  The accepted mutation replay test discards one reply, resumes the same session, and verifies one increment of both the original cell and a compiled-writer counter.  Reload must preserve visible source/results and command order without another write.  Proceed checks the final inner/outer/global values and one cleanup.  The next Listener returns 42.  Both fixtures remove their owned functions and symbols.  The existing cleanup releases only their recorded jobs/stops/session and checks protected records.  Browser coverage uses fresh x86-64 condition stops and same-boot reload/replay.  Native tests cover unavailable environments, cell identity, continuation-stack boundaries, cache collisions, and moving GC.

```sh
node tools/swank/web/test-evaluation-environments.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-evaluation-environments
```

The separate intercepted-response fixture makes no guest requests.  It holds a completed automatic inspection's HTTP reply while the enabled editor receives the shortcut, then requires exactly one queued toggle and unchanged draft/cursor after release.  It also tests a completed chord across an activity change, repeated keys, unfinished-prefix cancellation, nested arrows, reload, and an older backend without evaluation-prompt.  A long backtrace must keep the focused standalone editor visible after toggle output.  Refresh must preserve manual scrolling when that editor is unfocused or already outside the viewport.  Held automatic-assistance replies test those same two conditions.

```sh
node tools/swank/web/test-evaluation-environment-fixtures.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-environment-fixtures
```

## Standard-value warnings

The standard-value-warning driver compiles one owned DEBUG 3 target.  Ordinary PROGV binds `*PACKAGE*` to NIL and leaves `*READ-BASE*`, `*PRINT-BASE*`, and `*READ-DEFAULT-FLOAT-FORMAT*` unbound.  The debugger must supply valid controls and report the original bound NIL separately from unbound cells.  Typed SPACE completion and the menu must produce the same retained warning text without changing frame selection or the nine evaluation histories.  A debugger edit assigns an owned lexical probe to `*PACKAGE*`.  The next command must correct that value and record another warning.  Reload and replay after a discarded accepted reply must retain the text without another printer invocation.  Arming the probe must enter a child during warning printing.  Typed `:Abort`, repair, a fresh display, Proceed, and subsequent Listener 42 must succeed.  The target checks that continuation sees its original program bindings and one cleanup.

```sh
node tools/swank/web/test-standard-value-warnings.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-standard-value-warnings
```

The driver removes its class, printer method, named target, and symbols, then releases its jobs, stops, and session.  It creates a fresh condition stop.  Migration of an existing stop, other valid nondefault controls, and saved-stop restoration require the native fixtures.

## Show Special

The Show Special driver compiles owned DEBUG 3 inner and outer functions with repeated special bindings, bound NIL, an unbound cell, a global value, and a printable object.  It tests SPACE completion, a menu action that requests the required symbol argument without submitting, omitted and mentioned Program defaults, selected-frame versus Debugger observations, and independence from evaluation mode.  Nine retained histories and the current dynamic minus binding must remain distinct.  A changed debugger package, a qualified name, escaped Unicode spelling, NIL, T, and a keyword exercise symbol-source transport.  Streams must reject without accepting a command ID or replacing the session.

Reload must retain printed results and command order.  Replaying a discarded accepted reply must print the object once.  Read-time evaluation must fail without its proposed side effect.  Reader and printer children must recover through typed Abort.  A child entered during evaluation must report the enclosing current form through minus.  Repair, a fresh display, Proceed with unchanged program values and one cleanup, and Listener 42 must succeed.

```sh
node tools/swank/web/test-show-special.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-show-special
```

The driver removes its functions, class/printer method, special symbols, and package, then releases its jobs, stops, and session.  It accepts the same protected-record options as the other focused drivers.  The sole expected HTTP error is the unsupported Streams response.  Native fixtures cover continuation-stack cell identity, moving GC, and unsupported layouts.  This driver tests browser reload within one boot.  Show Special across image restoration remains untested.

## Object Inspector

The Inspector driver starts its named DEBUG 3 target as a batch evaluation and navigates its arrays, cyclic cons cells, and instance slots through the browser.  It tests command completion, three retained panes, pagination and partial pages, history, reload, lexical replacement expressions, unbound slots, type and reader errors, interrupted input, and typed Abort.  Lost submission and input replies must replay once.  A completed store followed by a printer failure must remain effective without repeating its expression.  Refresh after an array shrinks must permit backward navigation.  Clear must expire old references while preserving the session and command ID, and a closed stop must retain disabled recorded panes.  Proceed and the following Listener expression must return the expected values.  Layout assertions require full local and component labels to fit on one line while long values wrap.  Disabled recorded values retain their readable text without action-button strike-through.  After the owned stop closes, reload without selecting a stop must recover its known Request History results with unchanged visible rows, command identities, and guest command counters.

```sh
node tools/swank/web/test-inspector.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-inspector-test
```

The driver releases its named function and class, jobs, stops, and session.  It loads the checked-in description fixture for its failing printer.  Those shared fixture definitions remain loaded.  It creates fresh stops.  Saved-stop reference expiry requires the native restoration tests.

## Listener debugger input

The focused debugger driver tests inline and standalone Help, completion and contextual help, guest nesting prompts, ordinary and nested Abort, and interactive restart arguments through retained command input.  It tests SPACE completion of :Proceed, omitted and explicit Default selection, the Proceed button, restart indices and the default marker, and missing-default rejection followed by explicit interactive selection in the same session.  It distinguishes a restart that exits the stop from one that returns a command result while the stop remains active, including visible values, zero values, and normally returning Proceed and typed Abort operations.  Native mouse clicks spanning a monitor refresh check that unchanged Debugger and restart actions retain their DOM elements and receive the click.  The restart test also renders a pending replacement query and changes an unrelated stop row while the mouse button is pressed.  A held action queue tests immediate debugger-menu dismissal.  Its nested operation-error case reloads at the child stop, aborts that command, verifies the restored outer draft and selection, and continues the original computation.  It interrupts blocked restart argument readers from a condition stop and from an earlier interruption stop, aborts each child, and completes the original computation.  It checks that invalid no-argument and restart-index requests return HTTP 400 without advancing the stop's command ID.

```sh
node tools/swank/web/test-listener-debugger.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-listener-debugger-test
```

Display Debugger tests exercise SPACE completion, contextual help, typed submission in both debugger inputs, inline and standalone menu selection, and edits made while the parse reply is held.  Transfers must preserve the exact stop, selected frame, evaluation mode, command counter, retained records, Inspector, and draft/cursor.  A suspended parent must permit this display-only command while its child owns the pending operation.  Lost-reply recovery, reload, and refresh must preserve the chosen activity without repeating navigation.  Six focus and page-bound checks cover initial transfer and refresh, child transfer, and Parent/Child links with another refresh.  These run within the complete Listener debugger suite against fresh x86-64 condition stops.  Saved-image restoration of this command remains untested.

Explicit-argument tests invoke a restart with required parameters and no interactive function, reload during its input wait, interrupt that reader, abort an expression error, and complete the original evaluation.  A separate fixture evaluates a dynamically bound expression, returns multiple values, and counts argument evaluation and restart invocation across a discarded accepted submission reply and exact-request replay.  Both counts must remain one.  The driver also checks Arguments completion, default selection, the per-restart button, and subsequent Listener evaluation.

`REPLAY_ITERATIONS` repeats the lost-reply argument restart, FINISH, and following Listener evaluation sequence.  It defaults to one.  Each repetition retains its request receipt and job identities in the result.

Frame tests check completion, typed and mouse selection, Next/Previous/Top/Bottom, zero movement, rejected targets without command-ID consumption, once-only relative motion after reply loss, and selection across reconnect and reload.  Parent and child selections remain independent.  External selection updates the highlight without executing another inspection.  A frame containing a local whose printer signals an error tests child Abort after mouse and external-controller selection, absence of automatic printing retries, suppression of results for a different frame, and recovery through an explicit frame command.  The broad Listener suite checks Show Frame, individual and all locals, unavailable-local rendering, and labelled recorded locals after a stop closes and its selection clears.

A compiled debug-3 fixture captures NIL and :$INACCESSIBLE-VALUE$ arguments in a reader closure.  Mouse selection checks that both bindings have true availability flags and display their values.  Continuation calls the closure, and another Listener form verifies reuse after the stop closes.

A second named debug-3 fixture contains an unused FLET function HELPER that captures an argument and an ordinary variable HELPER holding 41.  Mouse selection checks separate `(FUNCTION HELPER)` and `HELPER` records, true availability flags, and the displayed closure and integer.  Continuation and another Listener form both return 42.

A named, no-argument debug-3 target calls a NOTINLINE helper inside and after separate LET scopes for X=37 and Y=41.  Four condition stops and mouse frame selections check that each binding appears only inside its scope.  Proceed continues each stop, and both the target and the next Listener evaluation return 42.

The driver tests both typed Proceed and the CONTINUE button for continuation.  `PROTECTED_STOP` optionally names a numeric stop ID whose state and next command ID must remain unchanged.  The result records browser errors and failed HTTP requests and response bodies, including across page reloads.  The driver records its session and releases its owned evaluations, stops, and session.

## Frame search

The driver requires the matching guest Find Frame operation and browser assets:

```sh
node tools/swank/web/test-find-frame.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-find-frame-test
```

It creates one private package and four recursive DEBUG 3 activations.  Typed Listener and standalone Debugger commands, SPACE completion, contextual help, and the mouse menu exercise direction, duplicate names, misses, brief/detail output, option rejection, printer child Abort, replay, selection, and nine history identities.  A reload removes only its Detailed command's saved browser descriptor and requires recovery of the same guest result and arguments without resubmission.

At width 360, Detailed and ordinary compiled-code output must retain the same text elements, line geometry, and horizontal scroll across refresh.  After Proceed, the retained closed stop must show recorded output with live controls disabled.  The next Listener evaluation must succeed.  Cleanup releases the owned stop, job, helper jobs, package, and session.  This driver does not establish saved-image or ARM64 behavior.

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

The model supplies generation-zero results for the child stop's four automatic inspections, requiring exact per-stop IDs and null operands.  It checks that nested activity, timer, and visibility samples preserve error feedback while a successful explicit sample clears it.  Interval notices remain visible.

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

The browser driver retains a session, a completed counter evaluation, and a DEBUG 3 returned closure while the operator saves and restarts the VM.  The closure has inherited variable/function bindings, a current captured parameter, a compiled reader, and an unwind cleanup counter.  The driver selects its frame, creates an Inspector page, and records lexical output and all nine expression/value histories.  It then submits a parent expression that saves an inherited value in a new LET local, increments the original inherited cell, and enters a continuable child through CERROR.  The parent command remains running at READY.  This test requires an isolated guest whose native frame-binding lifetime correction has passed its restoration tests.  Use a fresh output directory:

```sh
node tools/swank/web/test-image-restore.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-image-restore-test
```

Before submitting the suspended expression, Release Session and New Session must recover the same active stop and its visible history with current references.  At READY, the driver records both owned stop IDs and the parent's accepted command ID/source, then suspends browser requests while retaining its session storage.  Save the guest, wait for snapshot completion, stop QEMU, and restart the saved image.  Once SWANK responds and any separate native restoration checks finish, signal the driver from another terminal:

```sh
touch /tmp/mezzano-image-restore-test/restored
```

The driver reloads the browser and recovers the same job and two stops through a replacement session and fresh tokens.  Its Debugger actions select the recorded owned IDs.  Fresh child inspections must work while the parent still displays its original source and running command ID with a prior-boot label.  Typed child Proceed must continue that same command through a retained lexical write and the compiled reader, returning 38/39/42/43 once without another child.  The parent remains stopped at its selected frame.  Full parent history loading follows command completion.  Printed lexical/Inspector history, original IDs/source, prior-boot labels, disabled historical Inspector actions, and fresh controls must remain available.  The nine histories must advance once for the completed expression.  Fresh access observes inherited 39 and current 43.  Final program Proceed returns 39/44/39/1 after one cleanup.

Old-session tokens must reject at the HTTP boundary.  A current-session token for a historical frame must still reject native access, and prior-boot resubmission of the running expression must reject rather than execute again.  Each rejection preserves the command counter.  The driver captures those three expected error responses separately from session-expiry/outage recovery and rejects later unexpected browser errors.  It never renews old references or repeats the expression as part of recovery.

A new Listener input returns 42, the completed counter remains one, and documentation and Peek remain usable.  The driver releases both closed stops, its jobs, definitions, symbols, and session.  Failure evidence retains the owned identities and condition for coordinated cleanup.  The driver requires restart confirmation within 15 minutes.  This case tests a parent suspended at CERROR, rather than arbitrary execution positions or external I/O.

The history fixture supplies every API response locally and makes no guest requests:

```sh
node tools/swank/web/test-debugger-history-fixtures.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-debugger-history-fixtures
```

It tests one hundred retained records, fresh inspection priority, queued live actions between history reads, a failed read followed by reconnect, exact source and ID ordering, historical Inspector actions, partial reload, and suppression of a failed current-boot printer retry.  Pending-state cases include command 0 with cached next ID 0, a later accepted command beyond that cached counter, and an older historical command whose result has not arrived.  It also tests result recovery for known command records when no debugger stop is selected.  Existing live reload tests wait for the history-complete indicator before comparing retained text.

## Debugger command I/O

The intercepted command-I/O fixture serves the Web sources locally and replaces every API request.  It requires no guest.  It checks Unicode character offsets across bounded output reads, queued-action priority, the shared Listener/standalone input element, draft/cursor reload, accepted input reply loss and exact replay, separate parent/child drafts, fresh input after EOF, invalid output-range rejection, and disabled closed input.  Returned commands with zero output and EOF NIL have no empty input panel.  Changing job interruptibility preserves the neighboring Debugger button.  A lost accepted-submit reply recovers the running reader from its guest ID, permits input before exact submit replay, and preserves one execution across reload and replay.

```sh
node tools/swank/web/test-command-io-fixtures.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-command-io-fixtures
```

The separate jobless-stop driver creates one uniquely named thread with an owned debugger and ABORT restart.  Its Listener setup finishes before the standalone stop is selected.  It checks evaluated READ-LINE output/input, Unicode offsets, a draft/cursor across reload, independent nested command input, typed child Abort, per-command EOF, fresh input, program continuation, and Listener reuse.  It releases only its owned thread's stops, setup/cleanup jobs, symbols, function, and session.

```sh
node tools/swank/web/test-command-io.mjs \
  http://127.0.0.1:8766/ /tmp/mezzano-jobless-command-io
```

Isolated and stable x86-64 browser acceptance passed the jobless driver, Listener/restart driver, batch Inspector driver, and frame-evaluation driver.  Their readers use the command's input/output identity.  Program input remains on the evaluation job.  Coverage includes nested readers and Abort, reload, uncertain submit/input replies, exact replay, returning restart values, and interruption inside an interrupted command.  Native tests separately passed a partially consumed command reader across image restoration.  The intercepted browser fixture tests fresh-handle input for a prior-boot running record.  A browser command reader across an image restart remains untested.

### Publication into an old parked loop

The native [command-I/O upgrade fixture](../test-command-io-upgrade.lisp) runs in an isolated pre-command-I/O image.  Load the existing service-test helpers, then compile and load this fixture at SAFETY 3, DEBUG 3, SPEED 1 before publishing the new service:

```lisp
(lispm-command-io-upgrade-test:prepare)
```

PREPARE retains one batch stop in the old command loop, its selected frame and nine history values, a completed command, and the interpreter dispatch table.  The stop must have no active or pending command during publication.  Publish the tested native prerequisites, service, and adapter, then load the command-I/O test helpers with default LOAD allocation.  Keep the original upgrade fixture compiled before publication:

```lisp
(lispm-command-io-upgrade-test:finish)
```

FINISH checks historical command identity, result/replay, I/O-less defaults, selection/history, and interpreter-table identity after full GC.  The same old loop then runs the existing Unicode input/output, offset replay/conflict, independent EOF, and nested Abort checks.  Proceed must return 42, run cleanup once, and restore all seven application streams.  FINISH releases its job, stops, and controller.  CLEANUP releases only its retained fixture state after an interrupted test.

The x86-64 rehearsal passed on a working copy of the pre-I/O checkpoint with Mezzano 8619f444 and Slime 98bf7aa6 sources.  Ordinary modules used default LOAD.  RUNTIME/STRUCT used the image builder's wired runtime policy at SAFETY 3, DEBUG 1, SPEED 1.  The current isolated image was checkpointed before rehearsal, restored afterward, and checked through the unchanged HTTP service.  Preserve a separate current-world checkpoint and finish any inherited test fixture before preparing this case.  This test covers a condition stop parked between commands.  Publication with an active or pending old command remains outside its scope.

Stable incremental publication also passed this old-loop fixture with seven unrelated retained stop records.  Native and browser audits preserved those records, their command/Inspector entries, selection and history, application definitions, and runtime/compiler settings.  The final native audit released its separate baseline after browser cleanup.  The journal records one corrected audit assertion: a per-job dynamic *GLOBAL-DEBUGGER* binding had been mistaken for the global cell.  Its pre-publication global-cell identity was not measured.

## Frame Return

The intercepted Return fixture tests retained cancellation text, the existing command menu/parser path, reload without resubmission, and closed-only Current Stop navigation.  Two active fixture records share a thread display name.  Only the guest-supplied token receives selection and initial inspections.  Reload during an active confirmation also requires completed prior records to load while the reader remains enabled, with unchanged frame, command IDs, input draft/cursor, and submission count.  The existing history fixture retains its fresh-inspection priority assertion when a locally accepted command is beyond a stale monitor counter.

```sh
node tools/swank/web/test-return-fixtures.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-return-fixtures
```

The native-backed driver creates its own DEBUG 3, SAFETY 3, SPEED 1 target and caller.  Its batch case covers SPACE completion, lexical/dynamic cancellation, history, reader/evaluator child Abort, seven returned values, draft/confirmation reload, and exact command/input replay.  A jobless invocation raises a cleanup condition after Return, follows Current Stop to that new root, continues cleanup, and checks the caller's values.  The driver releases its recorded state and tests Listener reuse.  The six-group driver passed on isolated and stable x86-64 guests, releasing its seven jobs, five stops, and session in each run.  The host fixture separately tests duplicate thread labels.  Browser Return across an image restart remains untested.

```sh
node tools/swank/web/test-return.mjs \
  http://127.0.0.1:8766/ /tmp/mezzano-frame-return
```

### Reinvoke

The HTTP unit suite checks all null/Boolean option combinations, Lisp encoding, independent option-list construction, conflicting options, and malformed or missing lists.  The Return driver preserves its six existing groups and adds six Reinvoke groups against the native operation.  Its owned required/optional/rest/key target tests Current/Original defaults and supplied flags, rest/key precedence and spine copying, New cancellation/history and child Abort, lexical/dynamic expression contexts, a 29-argument indexed preview, input/confirmation reload and exact replay, captured replacement identity, and cleanup through Current Stop/Proceed.  All twelve groups passed on an isolated restored x86-64 guest with owned targets compiled at DEBUG 3, SAFETY 3, SPEED 1.  The driver released 29 jobs, fourteen stops, seventeen symbols, and its session.  These were fresh browser commands after the guest restart.  Browser Reinvoke commands held across a restart and stable deployment remain untested.

Host acceptance passed 35 Python tests and seven checks each in the existing intercepted Return fixture and an external Reinvoke fixture using the product HTTP handler locally.  The latter tested three menu option lists, retained cancellation, and active-reader/history reload.  Both recorded zero guest requests.  Their evidence and the failed generic-static-server runs are retained in /tmp/web-reinvoke-host.  The six native Return groups were not rerun during this host-only phase.

The focused product check passed 26 excerpts across the debugger, Command Processor, and Web guides after catalog refresh, plus Peek processes, SPACE/Tab completion, and Listener 42.  It released two jobs and its session.  Functional and product browser error lists were empty.  Evidence is /tmp/web-reinvoke-native-restored and /tmp/web-reinvoke-product-restored.  Earlier runs preserve a diagnosed stale-contrib publication failure and an SSH-forward exit with unknown cause.  Neither changed the accepted driver or product parser.

## Throw

The native-backed Throw driver creates three owned DEBUG 3/SAFETY 3/SPEED 1 targets with catch tags and cleanup counters.  It exercises both debugger views, SPACE completion and help, menu entry, prompted and inline operands, cancellation previews, reader/value/missing-catch child Abort, lexical/dynamic input, tag-reader and confirmation reload, and original Proceed.  A third inline form must enter a child before operand effects.  Inline values include strings containing spaces, Unicode, markup-looking text, and a heap vector through full GC.

```sh
node tools/swank/web/test-throw.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-throw-test
```

The Listener case preserves multiline source with a semicolon comment.  The standalone editor receives one line with a block comment.  Before submission, the driver compares the editor text with the intended source.  Lost-reply cases discard an accepted input reply and an accepted inline submit reply, then replay their exact requests.  Confirmation reload preserves command identity and draft input.  Transfer, closed-history recovery, once-only counters, cleanup, and the next Listener evaluation must pass.

Use a fresh output directory.  The driver preserves its first failure and separate evidence/cleanup failures, releases only its recorded jobs/stops/session, and checks protected stop records.  All eight groups passed on x86-64 with twelve reviewed captures and no page/loading/HTTP/finalization errors.  Node and Chromium exited with status zero.  The driver released four jobs, nine stops, and its session.  Browser interaction held across an image restart remains untested.  The [guest test guide](../TESTING.md#throw-command) specifies the native and saved-command tests.

## SAR64 instruction steps

The native-backed driver uses the integer-step fixture from the [guest test guide](../TESTING.md#integer-instruction-steps).  Its two Listener cases execute typed :Single Step through a register/immediate SAR64 at zero prompts and a memory/CL SAR64 at two prompts.  The latter uses count 65 to check six-bit masking.  Both shift -3 to -2.

Run the driver with a runtime configuration and a fresh output directory:

```sh
node tools/swank/web/test-sar64-step.mjs runtime-config.json /tmp/mezzano-sar64-test
```

The configuration must authorize execution, record native SAR64 acceptance, pin the runtime metadata, native guard, handoff, source manifest, book and auxiliary provenance, and provide process/native/asset guard commands.  Each guard runs before and after the cases.  The guest must already have the ordinary prerequisite fixtures loaded.

The driver checks exact instruction PCs and displayed operands, current-generation inspection, defined flags, raw register/memory state through moving GC, unchanged code, exact accepted-ID replay, original values, and one cleanup.  It removes only owned points, symbols, jobs, stops, and its session.

Both cases passed on two-CPU x86-64 QEMU with ordinary SAFETY 3/DEBUG 3/SPEED 1 fixtures.  Two captures were reviewed.  Node and Chromium exited zero.  All 198 responses succeeded, and browser, network, HTTP, and finalization error lists were empty.  Ten jobs, two stops, and the session were released.  These cases use the inline Listener debugger.  Standalone-Debugger interaction, fresh-cold execution, and ARM64 remain untested.  A separate native [parked-stop restoration test](../TESTING.md#parked-sar64-restoration) passed without fixture reload.  Browser interaction held across that restart remains untested.

## Single Step Web tests

The host state test executes the application's selection and input functions without a browser, HTTP server, or guest:

```sh
node tools/swank/web/test-step-state.mjs
```

It checks observed and missed generation transitions, a different function at the same frame index, old transcripts and Inspector metadata, stepping input/draft preservation, rejection before submission, failed-printer suppression, and descriptive closed-stop frames.  The Python suite checks argument-free `single-step` encoding, rejection of supplied operands, and generation-field JSON conversion.

The intercepted browser fixture uses local static files and replaces every API request:

```sh
node tools/swank/web/test-single-step-fixtures.mjs \
  http://127.0.0.1:8772/ /tmp/mezzano-single-step-fixtures
```

Its model covers observed Listener and standalone-debugger transitions, paused reload with the same stop association, missed transitions, current-generation live views, disabled old Inspector references, preserved drafts/cursors/mode, retained `unwound` text, and exact accepted-ID replay.  It records zero guest requests.  A synthetic busy rejection checks the retained input and Request History record.  Background polling and nested Examiner rendering preserve error feedback.  Successful explicit recovery clears the preceding error, preserving newer errors and informational notices.  The model does not test native instruction execution, CALL, or nonlocal exits.

Existing intercepted command-I/O, evaluation-environment, Return, and history fixtures provide generation zero for their unchanged stops and command results.  Native-backed acceptance requirements include an owned Listener worker at zero/two prompt depths, a target-qualified pause and release, fast reentry without a stepping monitor sample, expired frame/Inspector handles, RET into a different function at the same index, CALL step-over and escaping nonlocal exits.  The [retained instruction-step reference](../../../doc/debugger.md#retained-instruction-steps) records current native results.  Native test controls must not submit or select native debugger commands for the browser.  Preserve exact source/runtime/process guards and release browser records before native fixture cleanup.
