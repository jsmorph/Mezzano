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
- [x] Convert recovered fonts after approval, retaining provenance and notices.
- [x] Compare recovered glyph rasters, metrics, selected layout positions, and colors.
- [ ] Complete the original-window layout comparison, including paragraph justification.
- [x] Review, commit, and push the bounded implementation increment.

The working HTTP client, browser test, guides, and service unit were reviewed and pushed as Mezzano 71f051fb.  The operations guide selects that revision for fresh checkouts.  Original-font conversion and exact visual matching remain open.

## Original font identification: 2026-10-12

The [font-identification report](font-research/README.md), comparison script, and recorded results preserve 21 tested strings from the original classic debugger capture and the Workbook's embedded one-bit Listener and menu images.  Every selected ink rectangle has a recovered-font candidate with zero missing and zero extra pixels.  The result records source hashes, image orientation, positions, candidates, and recovered metrics.  This evidence identifies compatible glyphs for those samples.  It does not establish browser rendering or every glyph in each font.

The roles use several fonts: CPTFONT and CPTFONTCB for fixed text, JESS14 for menu items, HL12I and HL12BI for Workbook labels and headings, SWISS12B-CCAPS for mouse help, and EUREX24I and HL12 variants for the herald.  The classic interaction label matches TR12I and MATH12 equally on the tested Latin glyphs.  TR12I also matches its related menu-title prefix.  Classic text raster origins support fourteen-pixel line spacing.  At that research checkpoint, the browser used fallback glyphs and twelve-pixel body line height.

The recommendation is to convert the recovered fonts for their identified roles, then test Chromium at device-pixel ratio 1 for exact raster pixels, advances, baselines, line heights, and complete layout.  At that research checkpoint, font conversion required the pending fontTools approval.  No conversion dependency or font asset was installed in the research increment.

## Lisp Command Processor integration: 2026-10-12

The browser submits Listener input through the guest Command Processor and uses its assistance API for completion, HELP, defaults, and pathname insertion.  Debugger command parsing also runs in Lisp.  Accepted input history retains submission order across lost replies.  Clear Output History applies to the displayed-job set recorded with its original request, after the command reaches a terminal state.

The first expanded browser run exposed stale argument help after completion.  The browser now requests inspection of the replacement text.  The second used an invalid Unicode logical pathname.  The test now creates physical REMOTE pathnames, whose namestrings support the exercised Unicode character.  Later attempts read clear-output results before refresh completed, clicked a hidden activity action, or clicked the editor while reload refresh was moving it.  The driver now waits for action readiness and verifies editor focus.  The failed runs' owned fixtures were inspected and removed.

Review found that a running job's empty effects list prematurely marked clear-output effects as applied.  Effects now wait for a terminal job state.  A focused browser test supplies running and returned metadata, verifies the original clear boundary, and repeats the terminal result.  A separate HELP-only test confirmed that inspection leaves candidates hidden, F12 displays package candidates, and clicking a candidate inserts the guest replacement and restores focus.

The final full run passed all nine commands, completion, HELP, defaults, input-history order after replay, package persistence, variable/comma input, Unicode physical filenames and character offsets, two ordered pathname presentations, file display/loading/compilation, debugger frame and individual-local commands, clear-output reply loss/replay, evaluation reload and input, interruption, restart continuation, and release reconciliation.  All owned files, compiled files, packages, functions, jobs, stops, and sessions were removed or released.  Chromium reported exactly two expected HTTP 409 responses and no unexpected browser errors.  Evidence is lispm-listener-final2 and its adjacent log under the host's web-browser-evidence directory.

Original-font conversion and complete visual matching remain unfinished.

## Document Examiner: 2026-10-12

The user approved four panes, Lisp topic lookup/search/command parsing, and browser viewer histories.  The implementation follows the Genera User's Guide, Document Examiner chapter, and the original [Genera 8.3 MacIvory captures](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/docex.html).  The de2.gif reference is 1160 by 852 pixels.  The viewer/right divider is at x661, the right-pane split at y363, and the command pane begins at y727.  Original glyph identification found exact sample matches for HL12BI pane labels, HL12B headings, HL12 body text, CPTFONT candidates, JESS13 command-menu text, and SWISS12B-CCAPS mouse help.  These findings require browser conversion and raster tests before they establish display fidelity.

Named viewers retain topic references, viewed/deferred bookmarks, candidate lists, and reading positions in tab sessionStorage.  Topic bodies come from Lisp.  Repeated lookup selects existing content.  Topic buttons support viewing, overview, deferred bookmarking, and discard.  The search-options dialog uses Lisp-supplied modes and defaults.  Hardcopy uses the browser's print dialog.  The shared Chromium/CDP harness was extracted without dependencies, and the existing Listener/Debugger suite passed afterward.

The first Examiner browser run checked its connection variable before app.js loaded after reload.  A readiness guard fixed that driver failure.  A subsequent run passed.  Review corrected the browser's Exact default to Lisp's Substring default and moved newly viewed deferred bookmarks into first-read order.  Another run compared all serialized state before scroll persistence had settled.  Diagnosis found that discard saved the old position before the shortened content clamped it.  Discard now saves the resulting position, pagehide saves tab state, and restore waits for loaded fonts.

The final Examiner run passed completion, topic reuse, mouse operations, temporary overview, deferred/viewed ordering, tables of contents, candidate recall, Initial plus Adjacent search, flat search results, Unicode named viewers, viewer switching, discard, reload with exact 100-pixel scroll restoration, Help, Examiner guide lookup, print dispatch/CSS, a 640-pixel viewport, and session cleanup.  It created no guest jobs and reported zero browser errors.  Evidence is web-browser-evidence/lispm-examiner-final and its adjacent log.  The existing Listener suite evidence is web-browser-evidence/lispm-listener-examiner.

At this functional checkpoint, fallback typography, pane geometry, and extra separator lines between included subordinate sections still differ from the reference.  The approved font/layout increment will test and correct these.

## Recovered fonts and integer layout: 2026-10-12

The user approved fontTools as a build dependency.  The [font build and test record](fonts/README.md) pins fontTools 4.60.1, hashes the twelve recovered source records and Unicode mapping, and retains the recovery license and separate historical-font notice.  The server serves the generated assets without additional runtime dependencies.  Original-font research uses the [Genera 8.3 MacIvory Examiner capture](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/de2.gif), in addition to the earlier Listener and debugger references.

The converter retains bitmap pixels, left kerns, advances, baselines, and character heights.  Chromium 145.0.7632.109 at device-pixel ratio 1 passed all 1,555 mapped glyphs with zero missing, extra, or intermediate-gray pixels, exact advances, and exact baseline and line-height measurements.  An initial OS/2 version warning was corrected before the tested build.  The final rebuild corrected the font metadata's notice filename and repeated the glyph suite.

Fractional widget positions produced antialiased pixels despite integer contours.  A focused HL12 experiment measured zero gray pixels at an integer origin and 314 at each quarter-pixel offset for all four tested gasp settings.  The recommendation was integer pane and table dimensions plus integer placement of centered widgets.  Body paragraphs use left alignment.  Original word justification remains unfinished.  A custom word-positioning implementation was deferred.  Shared helpers preserve integer placement after resize.

Application tests found a table-width feedback error: repeated layout used the previous table width and grew it.  Layout now derives column widths from the parent, and the Examiner test asserts that every table fits.  A data-URL command marker caused two CSP errors after functional assertions passed.  An inline SVG marker resolved those errors.  A read-only diagnostic had released its session before Chromium cleanup failed on a late profile-file write.  Cleanup now retries removal of its own profile with a finite limit.  A later launch inside the restricted local sandbox failed before browser startup and created no guest session.  The authorized host Chromium run succeeded.

The final Examiner run passed completion, mouse operations, bookmarks, candidate options/history, viewer switching, Unicode viewer names, reload with exact 100-pixel reading position, Help, print dispatch, 640-pixel layout, source-link identity, table bounds, and session release with zero browser errors.  The full Listener/Debugger suite then passed after shared typography changes, including command completion, physical Unicode files, input history, interactive input, lost-reply replay, debugger locals and restart continuation, clear-output replay, release reconciliation, and cleanup.  It reported the two expected HTTP 409 responses and no unexpected errors.  All owned files, jobs, stops, and sessions were released or removed.

The final focused 1160 by 852 capture has zero intermediate-gray pixels.  Seven selected title, pane-label, and menu rectangles match the recovered glyph rasters and original positions.  The last viewer-label offset was one pixel.  Moving one pixel from its top margin to its bottom margin corrected that offset while preserving the pane's total height.  The complete historical title differs from the recovered raster by six pixels.  Source-specific Mezzano text, left-aligned paragraphs, remaining layout details, other zoom and device-pixel ratios, other browsers, and fallback Unicode require further comparison.  Complete original-window fidelity remains open.

Evidence is retained under the host's web-browser-evidence directory as lispm-font-final, lispm-examiner-font-complete, and lispm-listener-font-complete with adjacent logs.  The checked-in comparison scripts and JSON reports identify exact source and screenshot hashes.

## Private-document browser operations: 2026-10-12

The approved private-document UI follows the Genera User's Guide sections on Document Examiner commands and Creating a Private Document.  Read appends referenced topics to the selected viewer.  Load inserts deferred bookmarks without displaying their text.  Save captures the current bookmark display order, viewed topics followed by deferred topics, as a retained guest job.  Hardcopy renders the referenced topics for the browser's print operation without changing viewer state.  The Read Private Document command-menu item exposes Save, Load, and Hardcopy through Mouse-Right.

Lisp parses pathnames, supplies defaults, and reads or writes the guest file.  The browser uses the existing retained mutation record for Save, preserving the original name, canonical pathname, ordered topic IDs, and displayed command source before dispatch.  Request History replays that same record after reply loss.  Save jobs remain discoverable in Evaluations and require explicit release.  These operations use the existing HTTP and viewer mechanisms without additional dependencies.

The focused browser test will check bookmark order and saved contents, Load without displayed text, Read content, private print dispatch without viewer mutation, default assistance, main and right menus, accepted-save reply loss/reload/replay, and removal of only its unique guest file and retained jobs/session.

The first focused run passed Save acceptance, retained lost-reply identity, reload, and same-token replay, then failed a driver assertion because it omitted the transcript's `Command: ` prefix.  The stored source and displayed command were correct.  The uniquely named guest file and exact saved/cleanup jobs and session were explicitly released.  The corrected driver then passed all planned checks, including original-token replay, saved topic order, Load without displayed sections, Read, print dispatch with deduplicated sections and unchanged viewer state, and complete owned-fixture cleanup.  It reported zero browser errors.  Physical printing remains untested.  Evidence is web-browser-evidence/lispm-private-second and its adjacent log, with the failed driver's state and cleanup record retained separately.

## Examiner title clipping: 2026-10-12

The remaining six title pixels are the final `r` glyph's two-column by three-row overhang beyond the string's 313-pixel advance.  Both original de1.gif and de2.gif omit exactly those pixels.  An isolated Chromium test using an inline block clipped at its advance matched both original title rectangles pixel for pixel.  The simplest correction is to clip the existing title span to its inline-block bounds.  It preserves every font glyph and the existing title position.  The observed match supports this rendering choice.  The historical drawing code's clipping behavior remains an inference.

The application capture then matched both original 320 by 24 title rectangles with zero differences.  The reusable isolated test verifies original image hashes, measures the unclipped six-pixel difference, and requires zero differences after clipping without changing font data.  The full application capture retains zero intermediate-gray pixels and zero offsets for all seven selected title, pane-label, and menu samples.  Its session was released.  Evidence is web-browser-evidence/lispm-title-final, lispm-title-first-reference, and lispm-title-app.png.  Paragraph justification and complete-window fidelity remain unfinished.

## Peek and activity selection: 2026-10-12

The user approved a read-only Peek activity, a Show Processes Listener command, and browser SELECT gestures using F9 followed by L, D, or P.  The recommendation uses the existing activity container, serialized HTTP requests, retained stop selection, and recovered-font converter.  Guest Lisp samples scheduler fields and associates retained stops by thread identity.  The browser renders those records without evaluating or printing thread objects.  No new dependency is required.

The [Genera User's Guide](https://www.bitsavers.org/pdf/symbolics/software/genera_8/Genera_User_s_Guide.pdf), printed pages 2894–2897, describes the top mode menu, reverse-video current mode, initial Help, Processes on P, Quit on Q, twenty-second updates, nZ interval changes, and updates while Peek is exposed.  The [original Peek capture](https://ssw.jku.at/General/Staff/PF/peek.gif), from Ralf Moeller's [development-environment gallery](https://ssw.jku.at/General/Staff/PF/genera-screenshots.html), shows compact process rows, a process operation menu, a left scroll track, and lower label, help, and status lines.  The 980 by 717 GIF has SHA256 `691c8722aa85aba15c31b0599483e4f99639753b0b3340894d479e1af81182a1`.  The gallery does not identify its Genera release.

The captured columns are Process Name, State, Priority, Idle, and % Utilization.  The Mezzano display will instead identify its supported sampled fields: name, scheduler state, priority, wait description, and recorded runtime.  Runtime excludes a running thread's unfinished scheduling interval.  Success replaces the sample and its timestamp.  Failure leaves an explicitly stale sample.  Polls run only while the Processes mode is visible, without overlap.  The Describe action displays only returned fields.  Debugger actions select existing retained stops.  Arrest, reset, kill, and other thread controls are outside this increment.  SPACE provides explicit refresh.  The [Genera 7 Program Development Utilities manual](https://bitsavers.trailing-edge.com/pdf/symbolics/software/genera_7/999021_Program_Development_Utilities_Aug86.pdf), Peek Help on printed page 100, establishes that binding.

Recovered-font comparison found exact ink-mask matches for Process Name at (23, 30) and Notifications 1 at (23, 54) using TVFONT, menu Processes at (14, 6) and Describe at (154, 329) using JESS14, and the lower Processes label at (24, 649) using CPTFONT.  TVFONT must be converted and tested through the existing pinned fontTools build.  Mask matches establish the sampled shapes.  The converted browser font requires a separate raster and metric test.

The [Genera Workbook](https://bitsavers.org/pdf/symbolics/software/genera_8/Genera_Workbook.pdf), printed pages 22–25, establishes SELECT followed by L, D, or P, the Select: status prompt, SELECT HELP, and RUBOUT cancellation.  The [Symbolics X Window System User's Guide](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Symbolics-X-Window-System-Users-Guide.pdf), Keyboard Support in the Genera X Client, printed page 9, maps F1 to SELECT and F9 to SCROLL.  F9 is the explicitly approved browser mapping here.  F9 then F12 will list supported activities.  Backspace will cancel without changing input.

The focused browser test will cover SELECT prompt, cancellation, help and activity selection without editor changes; Peek mode/quit keys, manual and timed refresh, visible-only polling, no overlap, stale failure state, duplicate process names, safe text rendering, safe Describe fields, and exact retained-stop navigation.  A uniquely owned worker will provide a live process and a condition stop, with complete fixture cleanup.  Separate deterministic HTTP-response fixtures will cover error/timing cases that cannot be forced safely in the shared guest.  Screenshot comparison will check the sampled original fonts and monochrome layout.  Passing those checks will not establish complete original-window equivalence.

- [x] Implement and test SELECT navigation.
- [x] Add the typed processes HTTP operation and Peek rendering.
- [x] Convert TVFONT and test its browser glyphs and metrics.
- [x] Test live process and stop association, refresh/error behavior, and cleanup.
- [x] Document supported operation and limits, review, commit, and push.

The focused navigation run passed the SELECT status prompt, cancellation, activity help and dismissal, L/D/P selection, Peek Quit returning to its invoking activity, and unchanged Listener input/focus.  It also checked that the product catalog excludes development journals, font research, test guides, deployment-specific operations, and design records, and navigated Project Guide to Installation and Debugger.  No guest jobs were created.  The owned session was released, and Chromium reported zero errors.  Evidence is peek-navigation-first.

TVFONT was converted using the existing pinned build, with its source hash added to the input manifest.  The updated browser test passed all 1,697 glyphs across thirteen fonts, with zero missing, extra, or intermediate-gray pixels, exact advances, and exact CSS baselines and line heights.  TVFONT contributes 142 glyphs at height 10 and baseline 8.  The [Peek source-font comparison](fonts/peek-matches.json) records five exact original ink-mask matches.  Evidence is peek-fonts-test.  Complete Peek layout comparison and the live sampler test remain pending at this checkpoint.

Live sampler testing paused after guest compilation stalled.  Live browser work stopped while the root agent coordinated diagnosis.  A separate local Web instance served typed browser-response fixtures, with every API request intercepted before application startup and zero guest requests.  That test passed process rows, safe text and duplicate names, bounded Describe, disabled references from another session, manual and timed refresh, Help/activity/hidden-tab polling suppression, delayed-request nonoverlap, stale-row retention after a released-stop error, automatic retry, transport-error reconnection, and Quit.  Maximum concurrent process requests was one.  Chromium reported zero errors.  The hidden-tab case used a simulated visibility event.

The first fixture capture measured a one-pixel horizontal offset in the top menu and lower label, plus a five-pixel vertical label offset.  Measured integer padding and help/status strip heights corrected those positions.  The second fixture run passed the same behavior tests.  Its 980 by 717 capture matches four original string rectangles with zero missing or extra pixels and zero position offsets.  The full capture contains zero intermediate-gray pixels.  The [comparison script](fonts/compare-peek-layout.py) and [result](fonts/peek-layout.json) retain source and application hashes.  These fixtures establish frontend behavior and selected typography, while live HTTP-to-guest sampling and exact stop association remain pending.  Evidence is peek-fixtures-first and peek-fixtures-second.

A separate documentation-cleanup probe preserved a viewer containing an obsolete journal topic and a valid viewer.  The first driver expected a typed unknown-topic error, but the guest signaled SIMPLE-ERROR through an ordinary SWANK debugger, producing a visible HTTP 502 and Disconnected state.  Its owned session was explicitly resumed and released.  The corrected probe observed that diagnostic, preserved both obsolete-viewer bookmarks, resumed the connection, selected the valid viewer, and rendered its topics without removing the obsolete viewer.  It released its session and created no jobs or files.  Evidence is removed-topic-test and removed-topic-second.  The root agent is handling the proposed missing-topic behavior separately.

The final fixture run added a 640-pixel viewport with a 160-character name.  The table remained contained by its scrolling pane, the horizontal scroll control moved the pane, and the preceding behavior checks still passed with zero guest requests and zero browser errors.  Evidence is peek-fixtures-final.  The local test server was stopped after the run.

The live browser run passed SELECT and product-guide navigation, the uniquely named CERROR worker's sampled process fields, Describe, exact retained-stop navigation, Show Processes reporting the same worker, and restart continuation.  Both owned evaluation jobs, the stop, and the session were released.  Chromium reported zero errors.  The live capture was inspected separately from the fixture typography comparison.  The product guide describes the supported fields, runtime limits, failure behavior, and explicit browser key mapping.  Evidence is peek-live-first and its adjacent log.

## Retained documentation references: 2026-10-12

The user approved a typed missing-topic response and a visible unavailable entry while preserving bookmarks and other retained topics.  The guest reports `:missing-topic` through the existing service-error response.  The browser will catch only that reason while restoring each retained topic.  It will retain the saved title and topic ID, render `Topic unavailable` in that section, and continue fetching other records.  A successful parent-topic fetch still supplies its included sections, avoiding duplicate requests.  An omitted saved child receives its own lookup so removal of one heading does not prevent the remaining document from rendering.  Transport failures retain the existing connection-error behavior.

The focused browser test will restore missing and valid records together, require visible unavailable sections and unchanged bookmarks, exercise a removed child of a valid parent, reload the viewer, navigate another valid topic, and release its session.  Controlled response tests will distinguish missing-topic from transport errors and verify that a later successful lookup replaces unavailable content.  No saved topic reference is deleted by error handling.

The focused browser run passed the missing document, removed child, and valid-section restoration together, unchanged bookmarks after reload, and continued connection use.  Controlled responses distinguished HTTP 502 from `:missing-topic` and replaced an unavailable entry after a successful lookup.  The session was released, and no guest jobs or files were created.  Chromium reported the four expected HTTP 409 responses and no unexpected errors.  Evidence is missing-document-first and its adjacent log.  Screenshot review found separate `#1=`/`#1#` text in a multiline guide code block.  That rendering defect was reported to the Examiner backend owner for diagnosis.
