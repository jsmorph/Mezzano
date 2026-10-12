# Mezzano Web Listener and Debugger

The server exposes the retained SWANK evaluation and debugger services through HTTP.  The browser provides a Lisp Listener, retained evaluations, condition and interruption stops, stack frames, local values, zero-argument restarts, and request history.  Python uses its standard library.  The browser uses native HTML, CSS, and JavaScript.

## Running

Run from this directory on the VM host:

```sh
uv run --no-python-downloads --python /usr/bin/python3 server.py \
  --listen 0.0.0.0 --port 8765 --swank-host 127.0.0.1 --swank-port 4006 \
  --allow-host minideb2 --allow-host minideb2.tail3bfd26.ts.net \
  --allow-host 100.122.26.31 --allow-host 172.16.0.64
```

The default HTTP address is 0.0.0.0:8765, as requested by the user.  The default SWANK target is 127.0.0.1:4006.  Port 4005 belongs to the original VM.  The installed Python interpreter is used without downloading another interpreter or adding application dependencies.

Each accessible DNS name or IP address must appear in the Host allowlist.  Localhost, 127.0.0.1, the host name, and its fully qualified name are included by default.  An HTTP client that can reach the service has authority to evaluate Lisp in the machine.  The application provides no account authentication or TLS.  Host and Origin checks reject requests from unrelated browser origins.  POST requests require JSON and the `X-Mezzano-Request: 1` header.  The server grants no CORS permission.

The [systemd unit](mezzano-web.service) records the minideb2 launch configuration.  The [operations guide](../minideb2/README.md) describes the machine and endpoint setup.

## Using the interface

Return submits a command or Lisp form to the [guest Lisp Command Processor](../../../doc/command-processor.md).  Its guide lists the supported commands, completion and help keys, defaults, and pathname insertion.  Shift-Return inserts a newline.  Mouse-Right or the lower activity label opens the System Menu.  The menu selects the package, interactive input mode, activity, and connection operations.  Output and returned values appear in the Listener transcript.  Lisp forms returning zero values appear as `(No values)`, distinct from a returned `NIL`.

An interactive evaluation accepts text and EOF through its input controls.  Interrupt requests a retained debugger stop.  Release removes a terminal evaluation's stored output and results.  Guest jobs remain retained after session release and can be discovered from a fresh session.

Select an evaluation's Debugger action or a retained stop.  The System Menu's This Debugger column provides condition inspection, :Show Proceed Options, :Show Backtrace, :Show Frame, and :Show Local All.  Lisp parses typed debugger commands at the arrow prompt.  :Set Current Frame N selects a frame from the backtrace and requests its local values.  :Show Local N displays one local.  Original argument values remain unavailable.  Parent Stop and Child Stop select related retained stops.  A printer can itself enter a child stop.  The parent command remains visible as running while the child is inspected.

Restart lines invoke zero-argument restarts.  Available local values use the debugger's printed representation.  Unavailable values display `<unavailable>`.  A selected frame's function and index identify the displayed locals.  Closed stops retain their previously queried results until Release Stop.  The Request History activity records command IDs, states, prior-boot markers, and submissions whose replies remain uncertain.

### Session and request lifetime

A tab saves its guest session name, creation-attempt state, evaluation sources and names, input ranges, interrupt IDs, and command IDs in `sessionStorage`.  Reload resumes that identity.  Independent tabs create different sessions.  Duplicated tabs can inherit one identity.  Requests for a shared identity serialize in the HTTP server, while guest conflicts remain visible.

Each HTTP operation opens a SWANK connection, resumes the saved session, performs its operation, and closes the connection.  Debugger submission and release acquire their lease on that same connection.  Closing the connection relinquishes the controller.  Separate result polls permit child-stop inspection while a printer command runs.

The browser records each mutation before dispatch.  A lost reply preserves the original identity.  Repeat Original Request reuses an evaluation name, input range, interrupt ID, or command ID.  It never assigns a new identity to an uncertain submission.  A definitive rejection has a separate state and can be retained in history.

Release operations have no replay identity.  Check Release Outcome queries the original reference.  A released-object reply establishes the object's present state.  An expired reference establishes unavailability while leaving the original release outcome unknown.  A successful query records that the object remained retained at that check.  Keep in History preserves that observation and permits a later, separate explicit release action.

An expired session remains visible and requires New Session.  New Session archives unresolved records under their original session and discovers retained jobs and stops through fresh tokens.  Archived requests cannot replay under the new identity.  Session release requires the current pending records to be resolved or archived.

### HTTP API

`POST /api` accepts an object with `session`, `operation`, and optional `arguments` fields.  Session and evaluation names contain 64 lowercase hexadecimal digits.  Tokens retain their three-element protocol representation and are checked against the request's session.

| Operations | Arguments |
|---|---|
| open-session, resume-session, jobs, release-session | None |
| stops | Optional include_closed |
| listener-information | None |
| start-listener | name, source.  Optional interactive |
| listener-assistance | source, cursor, action.  Optional context, presentation |
| start-evaluation | name, source.  Optional package, input, interactive |
| save-private-document | name, pathname, topics |
| read-private-document | pathname |
| job-information, release-job | job |
| job-output | job, start.  Optional end |
| job-input | job, offset, text.  Optional eof |
| interrupt-job, job-interrupt-result | job, id |
| information, release-stop | stop |
| result | stop, id |
| submit | stop, id, command.  Optional argument |

Submit supports condition, restarts, frames, locals, and invoke-restart.  Locals takes a frame token.  Invoke-restart takes a restart index.  The [retained debugger protocol](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) defines guest operations, token lifetimes, states, and error reasons.

Success returns `{"value": ..., "diagnostics": [...]}`.  Failure returns `{"error": ..., "uncertain": ...}`.  Input validation failures precede SWANK dispatch.  Transport or remote decoding failures report an uncertain outcome.  The default transport deadline is 15 seconds, and the HTTP body limit is one MiB.

## Document Examiner

Select Document Examiner from the System Menu.  Its [guide](../../../doc/document-examiner.md) covers topic lookup, candidate search, tables of contents, overviews, bookmarks, viewers, and command keys.  The [project guide](../../../doc/project-guide.md) maps the complete project documentation.  Guest Lisp reads the source documents and handles topic hierarchy, cross-references, search, and command completion.  The browser stores viewer references and histories in tab sessionStorage.

Read Private Document appends the file's referenced topics to the current viewer.  Mouse-Right on that menu item provides Save, Load, and Hardcopy Private Document.  Load inserts deferred bookmarks without displaying text.  Save writes bookmarks in displayed order through a retained guest job, whose result appears in Evaluations.  Its original name, pathname, topic IDs, and source command survive reload and lost replies.  Repeat Original Request reuses those values.  Hardcopy prints the referenced topics without changing the viewer.  Lisp supplies pathname parsing and defaults.

The HTTP `document-query` operation takes `action` (`catalog`, `topic`, `search`, `contents`, or `overview`), with `topic`, `query`, `mode`, and `adjacent` as applicable.  Modes are `exact`, `initial`, and `substring`.  `document-assistance` takes `source`, a character `cursor`, and `action` (`inspect`, `space`, `complete`, `help`, or `parse`).  The [SWANK reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md#document-examiner-operations) defines result records.

## Symbolics display references

The Listener follows Symbolics' [Genera Workbook](https://bitsavers.trailing-edge.com/pdf/symbolics/software/genera_8/Genera_Workbook.pdf), printed pages 5–7 and 10–12, particularly figures 4 and 7.  Those Genera 8 figures show the full Listener text area, multiple borders, lower activity label, left and bottom scroll tracks, two reverse-video mouse-documentation lines, and who-line.  The initial Listener has a centered herald.  The palette uses solid black and white.

The selected debugger follows the [classic Listener debugger capture](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/symbolics-images/source-code-debugging.gif) on the [source-oriented debugging page](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/source-oriented-debugging.html): inline bold condition, function and argument lines, inline restart choices, and an arrow prompt.  The page does not identify a precise Genera release.  The [Program Development Utilities manual](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/documentation/Program-Development-Utilities.pdf), printed pages 189–191, describes this debugger entry display.  Its printed page 206 illustrates the restart popup.

The [Display Debugger capture](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/development-environment/debugger.gif) shows another original debugger layout with separate stack, disassembly, condition, and variable panes.  The present interface follows the classic Listener variant.

Mezzano identity, package, guest process state, and supported commands replace Symbolics-specific content.  The who-line clock uses browser time.  Local values are labeled Local because the API does not supply the original display's argument classification.  Inspection requires explicit commands.  Pathname presentations support command argument insertion.  General object presentations, source selection, disassembly, local writes, frame evaluation, and stepping remain unimplemented.

### Font status and visual limits

The interface loads twelve recovered Symbolics fonts.  The [font build and raster tests](fonts/README.md) preserve source hashes, conversion settings, provenance, licenses, and measurements.  Chromium at device-pixel ratio 1 reproduced all 1,555 mapped glyphs with zero missing, extra, or intermediate-gray pixels and exact advances, baselines, and line heights.  Application panes and measured text widgets use integer placement.  The [original-font identification report](font-research/README.md) records the Listener and debugger source comparisons.

The final 1160 by 852 Examiner capture has zero intermediate-gray pixels.  Seven selected title, pane-label, and menu samples match the recovered glyphs and original positions.  The title clips its final glyph overhang at the string advance, reproducing both original title captures pixel for pixel.  Document paragraphs use left alignment while the original uses justification.  Complete-window fidelity, other zoom levels and device-pixel ratios, other browsers, and fallback Unicode glyphs remain unverified.  The tested font shapes and selected positions do not establish complete visual equivalence.

Symbolics' [Programming the User Interface, Volume B](https://ftpmirror.your.org/pub/misc/bitsavers/pdf/symbolics/software/genera_7/999029_Programming_the_User_Interface_Volume_B_Aug86.pdf), printed page 123, maps the default fixed roman normal style to FONTS:CPTFONT.  The [recovered Genera font repository](https://github.com/htayj/genera-fonts/tree/809694a73ece7f840b6541b4781cd47152d1ea35) publishes Genera 8.5 bitmap sources.  CPTFONT has an eight-pixel advance, twelve-pixel character height, and baseline ten.  Chromium rejected the released bitmap-only OTB file.  The user approved build-only fontTools conversion.  The server serves the generated TrueType files without a conversion or font runtime dependency.

The recovery repository's BSD license covers its tooling and documentation.  Its NOTICE treats the historical glyph designs separately.  Both accompany the generated assets.  Recovered Genera 8.5 font data, the Genera 8 manual, and the Genera 8.3 Examiner capture come from different versions.  Their tested glyph comparisons are recorded separately.

## Tests

```sh
uv run --no-python-downloads --python /usr/bin/python3 test_server.py
uv run --no-python-downloads --python /usr/bin/python3 test_server.py --live-port 4006
```

Nine isolated tests passed: Lisp string and value encoding, fragmented UTF-8 framing, typed arguments, malformed remote encoding, ordinary SWANK debugger abort and reply draining, session-lock cleanup, browser-origin restrictions, malformed JSON field types, and uncertain failure after dispatch.

The live suite passed through HTTP, SWANK, and the running x86-64 development guest.  It covered Unicode output and character offsets, multiple and zero values, identical creation replay, session resume, interactive input replay, CERROR, stack frames and available locals at debug 3/safety 3, restart continuation, interruption, abort cleanup, and a printer child stop.  It released its jobs, closed stops, and session, and removed its function and condition-class fixtures.  Queries after release returned the expected released-job, released-stop, and expired-session errors.

The browser test runs on a host with Chromium and Node.  The tested versions are Chromium 145.0.7632.109 and Node 24.13.0.  It uses Node's built-in WebSocket API and requires no npm packages.  From the Mezzano checkout on that host:

```sh
node tools/swank/web/test-browser.mjs http://minideb2:8765/ /tmp/mezzano-browser-test
```

The first argument is the server URL.  The second is the screenshot and diagnostic directory.  CHROMIUM can select another Chromium executable.  The driver starts an isolated headless profile, sends keyboard and mouse events through CDP, and removes its profile on exit.  A failed interaction saves the browser's session state and leaves its recorded guest fixtures available for inspection.

The expanded Chromium run passed all nine Listener commands, SPACE and COMPLETE, contextual HELP candidates, defaults, package changes, Lisp/command disambiguation, Unicode cursor offsets, two pathname presentations, input history, and clear-output replay that preserves later output.  A focused test checks that a running job cannot consume its terminal display effect.  It also passed Listener output and multiple values, reload, a 640-pixel viewport overflow check, interactive input, condition and stack inspection, available locals, restart continuation, and release.  Controlled response loss discarded a completed fetch response after server dispatch.  Creation replay recovered the original job.  Lost job-release and session-release replies were reconciled through queries, followed by explicit session replacement and final cleanup.  Two expected HTTP 409 responses represented a released job and an expired session.  No unexpected browser errors occurred.  The driver records font metrics and screenshots, which require visual review against the original references.

Complete original-window comparison remains unfinished.  Unavailable-local encoding has an isolated test, while unavailable-local browser rendering has source review only.  Actual image restore, ARM64 guest behavior, and byte-for-byte original-screen fidelity have not been tested here.  The [development journal](devnotes.md) records failures, corrections, and test scope.

The focused private-document browser test runs separately:

```sh
node tools/swank/web/test-private-document.mjs http://minideb2:8765/ /tmp/private-document-test
```

It passes the original main/right menus, guest pathname defaults, bookmark order, discarded Save response followed by reload and same-job replay, Load without text, Read, and Hardcopy without viewer mutation.  It removes its uniquely named guest file and releases its Save job, cleanup job, and session.  Chromium reports no browser errors.  The driver intercepts print dispatch.  Physical printer output remains untested.
