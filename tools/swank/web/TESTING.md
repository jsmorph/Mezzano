# Web interface tests

The Python tests exercise HTTP and SWANK transport behavior.  The Chromium drivers exercise browser interaction against a running Web server and Mezzano guest.  Font and layout measurements have separate tools in the [font testing guide](fonts/README.md).

## HTTP and SWANK tests

Python 3.13 or later is required.  From the Mezzano checkout:

```sh
uv run --no-python-downloads --python python3 tools/swank/web/test_server.py
```

The isolated tests create local fake peers and HTTP servers.  They exercise framing, encoding, typed arguments, request-origin checks, error classification, connection cleanup, and session serialization.  They do not require a running guest.

The live suite connects to SWANK on loopback.  The port is configurable:

```sh
uv run --no-python-downloads --python python3 tools/swank/web/test_server.py \
  --live-port 4005
```

It starts a temporary HTTP server and exercises evaluation, Unicode output offsets, returned values, replay, interactive input, condition stops, frame and local inspection, restart continuation, interruption, and child stops.  Its cleanup removes the functions, classes, jobs, stops, and session it created.

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

The Listener driver covers command assistance, evaluation and input history, guest file commands, Unicode presentations, interactive input, debugger commands and restarts, retained-request recovery, and release reconciliation.  It checks initial debugger inspection, Listener ownership through reload, typed Help through the owning Listener, and successful ordinary submission after CONTINUE.  The Examiner driver covers topics, mouse operations, candidate history, search options, bookmarks, named viewers, reload, reading positions, and print dispatch.  The private-document driver covers command menus, defaults, bookmark order, Save replay, Load, Read, Hardcopy, and file cleanup.

Each driver starts a separate headless browser profile and removes that profile on exit.  Successful runs release their owned guest sessions and fixtures.  Failed interactions save session state and fixture identities for inspection and cleanup.  The Listener and private-document tests create guest files and evaluation jobs.  They require a writable guest home directory.  Other clients' retained objects must remain untouched.

Lost-reply tests discard a completed HTTP response after server dispatch.  They exercise saved-request recovery rather than every possible transport failure point.  Print tests intercept print dispatch.  They do not verify physical printer output.  Browser screenshots require separate comparison before supporting a visual-fidelity claim.

## Listener debugger input

The focused debugger driver tests inline and standalone Help, completion and contextual help, guest nesting prompts, ordinary and nested Abort, and interactive restart arguments through retained evaluation input.  It distinguishes a restart that exits the stop from one that returns a command result while the stop remains active, including visible values, zero values, and a normally returning typed Abort.  Native mouse clicks spanning a monitor refresh check that unchanged Debugger and restart actions retain their DOM elements and receive the click.  The restart test also renders a pending replacement query and changes an unrelated stop row while the mouse button is pressed.  A held action queue tests immediate debugger-menu dismissal.  Its nested operation-error case reloads at the child stop, aborts that command, verifies the restored outer draft and selection, and continues the original computation.  It checks that invalid no-argument and restart-index requests return HTTP 400 without advancing the stop's command ID.

```sh
node tools/swank/web/test-listener-debugger.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-listener-debugger-test
```

The driver selects the CONTINUE button for continuation.  `PROTECTED_STOP` optionally names a numeric stop ID whose state and next command ID must remain unchanged.  The driver records its session and releases its owned evaluations, stops, and session.

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
