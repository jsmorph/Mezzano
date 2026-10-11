# Web UI development journal

## Scope and approved design: 2026-10-12

The user requested a Symbolics-like Web UI served by a uv-runnable Python server that communicates with Mezzano through SWANK.  The parent reviewed the standard-library Python and native-browser design.  The user approved implementation and required HTTP to listen on all interfaces, with exact original Listener and Debugger fonts and colors.

The server defaults to 0.0.0.0:8765 and uses SWANK at 127.0.0.1:4006.  The original VM at port 4005 remains separate.  Host allowlists, Origin validation, JSON requests, and a custom request header constrain browser access.  Any network client reaching this service has Lisp evaluation authority.  The checked-in systemd unit records minideb2 addresses.  Python application dependencies remain zero.

### Session and request decisions

The HTTP request lifetime follows the existing [Lisp client](../debugger-client.lisp): open a SWANK connection, resume the saved session, perform the operation, and close the connection.  Debugger submission acquires its lease and submits on that connection.  Closing the connection relinquishes control.  Result polls use new connections, allowing child-stop inspection while a parent printer command runs.

A tab stores the session identity and creation-attempt state in sessionStorage.  An independent tab creates a session.  A duplicated tab can inherit the identity.  The server serializes each session's requests and removes idle lock entries after the last waiter or active request leaves.  Guest conflicts remain visible.

The browser records evaluation names, input ranges, interrupt IDs, and debugger command IDs before dispatch.  Lost replies preserve those identities.  Replay uses the original request.  Session expiry requires explicit replacement.  Replacement archives unresolved records under the old identity and discovers retained objects with fresh tokens.

Release operations have no replay identity.  The client queries the original job, stop, or session after a lost release reply.  A released-object result establishes the object's present released state.  An expired reference establishes unavailability without proving whether the original release ran.  A successful query records that the object remained retained at that check.  The history retains this distinction.  A subsequent release requires a separate explicit action.

## Display research

The [Web guide](README.md#symbolics-display-references) retains source links and page references.  The Genera 8 Workbook figures were rendered from the source PDF and inspected.  Figure 4 on printed page 7 shows the System Menu and mouse help.  Figure 7 on page 10 shows the initial Listener.

An initial static study used a permanent activity bar, cards, and a textarea control row.  The parent compared it with the original figures and rejected those arrangements.  The implementation now uses the full Listener text area, lower activity label, left and bottom scroll tracks, two reverse-video mouse-documentation lines, and who-line.  The obsolete study was removed.

The source-oriented debugging capture shows the classic debugger inside a Lisp Interaction Window: bold condition, function and argument lines, inline restart choices, and an arrow prompt.  A separate Display Debugger capture includes stack, disassembly, condition, and variable panes.  Review selected the classic Listener variant for this increment.  Its supported inspection actions appear in the System Menu and at the arrow prompt.

The user requires original typography.  The fallback monospace font remains provisional.  Symbolics' UI manual maps the default fixed roman normal style to CPTFONT.  The recovery repository at commit 809694a73ece7f840b6541b4781cd47152d1ea35 publishes Genera 8.5 bitmap sources and a v0.1.3 release containing BDF and bitmap-only OTB fonts.  Chromium rejected the released CPTFONT OTB through FontFace with Invalid font data in ArrayBuffer.  Build-only fontTools conversion awaits approval.  No conversion dependency has been installed.  The repository's historical-glyph NOTICE and tooling license have separate scopes.

The manual and captures establish the layout reference.  Original-font conversion, pixel comparison, and exact visual fidelity remain unfinished.  The classic debugger capture does not identify its precise Genera version.  Mezzano identity, commands, local labels, and browser time deliberately replace unavailable or inapplicable Symbolics content.

## Implementation review and corrections

The server's reader accepts the SWANK subset needed here and rejects reader macros and dotted lists.  It frames UTF-8 by bytes.  HTTP input validation precedes transport dispatch.  Malformed remote encoding after dispatch reports an uncertain outcome.  An ordinary SWANK debugger event triggers throw-to-toplevel, followed by draining the original RPC's termination before connection close.

Review found and corrected these failure paths: remote Unicode or integer decoding reported as definite HTTP input rejection, immediate close after SWANK abort, session-lock table growth, unchecked message-event shapes, missing accepted-socket timeout, and malformed JSON values reaching unchecked comparisons.

The browser serializes user actions and skips redundant polls.  Evaluation actions capture source, package, and input mode before queueing.  Pending requests retain their originating session.  Known rejections remain separate from lost replies.  Session replacement archives uncertain records without replay under a new identity.  Commands belonging to a released stop leave the current command list.

Frame selection identifies its function and local table.  Completed command IDs and states appear in Request History.  The main debugger retains incomplete-command and child-stop status.  Horizontal and vertical scroll indicators derive their dimensions from the current content.  Recovery of a lost creation reply updates the existing transcript's source after replay.

## Test evidence

### Isolated tests

Nine Python tests passed.  They cover string escaping, UTF-8 framing, zero values versus printed NIL, unavailable-local encoding, typed arguments, malformed remote encoding, ordinary SWANK abort and draining, session-lock removal, browser-origin checks, malformed HTTP fields, and uncertain decoding failure after dispatch.

The fake SWANK peer originally used a single recv call for its header and failed to detect body EOF.  It now uses buffered exact-length reads with explicit short-read failure and a socket timeout.  The isolated suite passed after that correction.

### Live protocol tests

The HTTP-to-SWANK suite passed against the running x86-64 development guest.  It exercised Unicode output and Lisp-character offsets, multiple and zero values, duplicate creation, session resume, interactive input replay, CERROR, frames and available locals 111 and 222 at debug 3/safety 3, CONTINUE returning 333, interruption, duplicate command IDs, ABORT unwind cleanup, and a printer child stop.  It recovered the child, observed the parent's retained result, and aborted the parent evaluation.

The first run failed before SWANK dispatch because a local variable shadowed Python's http module.  Renaming the variable corrected the test.

A later debugger fixture used compile with a global name but produced a frame printed as (LAMBDA :IN NIL).  Its frame-name assertion failed.  The original cleanup then assumed the stop had closed and also failed.  Four exact owned job names and the active stop were inspected and released.  The fixture now uses DEFUN and UNWIND-PROTECT/FMAKUNBOUND.  Cleanup walks owned child stops, aborts only its own active evaluations, releases its stops and jobs, and releases its session.  The condition-class fixture also removes its class binding.

The expanded run completed those cleanup requests successfully.  Pass reporting was moved after cleanup.  The final live run passed added assertions for :released-job, :released-stop, and :expired-session after release.  Every fixture cleanup completed before the pass messages.

### Browser tests

The initial CUA entry reported no available browser.  The parent then used installed headless Chromium through Node's native CDP WebSocket support, without npm dependencies.

The first browser run passed evaluation/output/multiple values, reload retention, CERROR condition/stack/available locals/restarts, CONTINUE returning 333, and fixture release.  The parent owns the reusable browser driver.

The broader driver passed Listener, reload, 640-pixel viewport, and interactive input checks.  Its first replay test accessed Request History before initial refresh had populated it.  A later run passed replay but accessed the debugger menu before stop-selection refresh populated it.  A third run opened the menu before queued stop selection displayed the debugger.  All three failures were driver-readiness errors.  The parent added explicit action-readiness waits and released each run's exact owned fixtures and session.  The fourth run passed evaluation, multiple values, reload, interactive input, discarded creation-response replay, condition, stack, available locals, CONTINUE, and fixture release, with zero browser errors.

The final browser run also passed discarded job-release and session-release replies.  Queries recovered the released-object and expired-session states, and explicit New Session restored access.  Cleanup released the owned jobs, stop, and final session.  Chromium reported the two expected HTTP 409 responses and no unexpected errors.  The test discards a completed fetch response after dispatch.  It does not simulate every TCP failure position.  Evidence is retained on minideb2 under /home/somebody/src/mezzano-boot/web-browser-evidence/lispm-browser-release, with its adjacent log.

The driver also exits with an error when its configured Chromium executable is absent.  A startup review corrected cleanup that could otherwise wait for an exit event after spawn had failed.

Unavailable-local browser rendering has source review only.  Actual image restore and ARM64 guest behavior have no tests in this increment.  Native fallback-font screenshots establish functional rendering, without establishing exact original visual fidelity.  The final browser measurement found no loaded CPTFONT and measured Hello at 36.123046875 pixels, compared with the recovered font's expected 40-pixel advance.  The original and current Debugger captures were inspected side by side.  The inline structure follows the selected classic variant, while the current glyph widths and shapes differ.

## Remaining work

- [x] Finish the broader browser run, including saved-request replay and release reconciliation.
- [x] Run the added live released-reference and expired-session assertions.
- [ ] Convert or otherwise obtain a browser-usable original font after approval, retaining provenance and notices.
- [ ] Compare rendered glyphs, metrics, layout, and colors with the original captures.
- [ ] Review, commit, and push the bounded implementation increment.
