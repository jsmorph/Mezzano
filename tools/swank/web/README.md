# Mezzano Web Listener and Debugger

The Web interface provides a Lisp Listener, debugger, retained evaluations, Peek process viewer, and Document Examiner.  A Python server connects the browser to Mezzano's SWANK service.  Evaluations, output, debugger stops, and command results remain in the guest across browser disconnections.

## Installation and access

The server requires Python 3.13 or later and has no third-party Python dependencies.  Running it with the command below also requires uv.  The browser requires JavaScript and sessionStorage.  The Mezzano guest must provide the retained SWANK service and its Command Processor and Document Examiner modules.  The Web server does not implement SWANK's shared-secret handshake.  The [installation guide](../../../doc/installation.md) covers guest setup.

From the Mezzano checkout, this example uses an installed Python interpreter, serves HTTP on loopback, and connects to SWANK on port 4005:

```sh
uv run --no-python-downloads --python python3 tools/swank/web/server.py \
  --listen 127.0.0.1 --port 8765 \
  --swank-host 127.0.0.1 --swank-port 4005
```

The browser address for that configuration is `http://127.0.0.1:8765/`.  The SWANK host and port identify the endpoint reachable from the Python server, which may be a forwarded guest port.

| Option | Default | Meaning |
|---|---|---|
| `--listen` | `0.0.0.0` | HTTP listening address. |
| `--port` | `8765` | HTTP listening port. |
| `--swank-host` | `127.0.0.1` | SWANK server address. |
| `--swank-port` | `4006` | SWANK server port. |
| `--timeout` | `15` | Request timeout in seconds. |
| `--allow-host` | None added | Additional HTTP hostname or IP address.  May be repeated. |

Network access uses a listening address such as `0.0.0.0` and an allowed browser hostname, for example `--allow-host lispm.example.net`.  The corresponding browser address is `http://lispm.example.net:8765/`.  The allowlist includes `localhost`, `127.0.0.1`, the server's hostname, and its fully qualified hostname.  Additional addresses require an explicit `--allow-host`.  Every request's Host header must include the HTTP listening port.

### Access restrictions

Access to the HTTP service grants Lisp evaluation and debugger control in the guest.  The server provides no account authentication or TLS.  Host and Origin checks restrict browser request origins.  Network access controls determine which clients can use the service.

POST requests require JSON and the `X-Mezzano-Request: 1` header.  An Origin header, when present, must equal `http://` followed by the request's Host header.  The server grants no CORS permission.  Its current checks expect direct HTTP access.  It does not interpret forwarded host or scheme headers from a reverse proxy.

## Lisp Listener

The initial Listener displays a system herald with the image version, architecture, memory and backing-store totals, loaded ASDF systems and versions, and keyboard help.  `Show Herald` prints the title, facts, and help in the transcript.  `Show Herald :Detailed` also lists loaded systems.  A dash marks a system without a declared version.  Reload samples fresh startup facts.  Retained command output keeps the facts captured when that command ran.

Return submits a command or Lisp form.  Shift-Return inserts a newline.  Alphabetic input and an initial colon introduce commands.  A bound variable name is accepted when it does not identify a command.  Other input is Lisp source, and a leading comma forces Lisp reading.  For example:

```text
Command: Set Package CL-USER
Command: (+ 20 22)
Command: Help :Format Detailed
```

SPACE completes a command word, Tab completes a name, and F12 requests contextual help.  Another SPACE accepts a displayed argument default.  Pathnames in command output are mouse-sensitive: clicking one inserts it into the expected pathname argument.  The [Command Processor guide](../../../doc/command-processor.md) describes commands, arguments, pathname rules, and input history.

Mouse-Right or the lower activity label opens the System Menu.  The menu selects an activity, package, interactive-input mode, or connection operation.  The Listener displays program output and each returned value.  A form returning zero values displays `(No values)`.  Ordinary Listener submissions run one at a time in a session.  While a submission is running, the status beside the input identifies whether that Listener is evaluating, waiting for evaluation input, or stopped in the debugger.

When the evaluation stops, that Listener displays its innermost debugger and directs command input to that stop.  The prompt identifies the nesting level.  Ordinary Listener input and each debugger level retain their drafts and cursor positions, including across reload.  Leaving a level restores the preceding draft.  Other Listener sessions remain independent.  A second ordinary submission while the Listener is evaluating or waiting for program input reports that the Listener is busy and preserves the typed input.

Large output arrives across successive refreshes.  The job status displays `receiving output` with received and total character counts until the browser has received the captured output.  Evaluation completion and output transfer are separate states.  Pathname and herald presentations become active when their complete text range has arrived.

Interactive evaluations accept text and EOF through their input controls.  Interrupt requests a debugger stop.  Evaluations lists retained jobs and their states.  Release removes a completed job's stored output and results.  Clear All terminates retained evaluations across Listeners, releases their stored data and closed debugger records, and clears this tab's evaluation histories.  Its result remains available as Command result in Evaluations for request recovery.  Clear Output History clears the displayed transcript and initial herald while preserving input history and retained jobs.  The cleared state persists across tab reloads.

## Debugger

The owning Listener displays a stopped evaluation inline.  Its Debugger action opens the same retained stop in the separate Debugger activity.  Both views use the guest command parser and display the stack, restart choices, and condition.  Each inspection runs once on initial selection.  Reload reuses retained results.  A repeated inspection keeps its previous completed result visible while the new command is pending.  Inspection and restart buttons are disabled while a debugger command is outstanding or a child stop is active.  The command input remains editable while stopped.  The Debugger activity also lists stops.  Condition inspection is also available from the System Menu.  The debugger prompt accepts these commands:

| Command | Behavior |
|---|---|
| `:Abort` | Invokes the stop's ABORT restart.  In a child entered by a debugger command, it abandons that command and returns to the enclosing debugger. |
| `:Help` | Displays the guest debugger command help. |
| `:Show Backtrace` | Lists frames. |
| `:Set Current Frame N` | Selects a frame by its zero-based index and displays its locals. |
| `:Show Frame` | Displays the selected function and available locals. |
| `:Show Local All` | Displays the selected frame's local records. |
| `:Show Local N` | Displays one local by its zero-based index. |
| `:Show Proceed Options` | Lists restart choices. |

Restart lines invoke the selected restart interactively.  For an evaluation started with interactive input, a restart's QUERY-IO reader accepts text and EOF through the existing input controls.  A restart can return to the same stop or transfer control out of it.  Returned restart values, including values from a returning :Abort, appear in the debugger, with `(No values)` for zero values.  Unavailable local values display `<unavailable>`.  Original caller argument values are unavailable.  The selected frame's function and index identify the displayed locals.  The [debugger guide](../../../doc/debugger.md) describes stopping states and the compiler information required for local inspection.

Printing a condition or value can enter a child stop.  The owning Listener follows that child, and :Abort returns to its parent without continuing the original computation.  Parent Stop and Child Stop navigate the relationship in the separate Debugger while the parent command remains running.  Closed stops retain previously queried results until Release Stop.

The Web debugger currently exposes condition, frame, local, and restart inspection, interruption, and interactive restart invocation.  It does not provide object browsing, source or disassembly views, binding writes, frame evaluation, or stepping.

## Document Examiner

Document Examiner opens from the System Menu.  Its Viewer displays topics.  Current Candidates lists lookup results, Bookmarks retains viewed and deferred topics, and Commands accepts documentation commands.  Named viewers preserve separate topic lists, bookmarks, candidate histories, and reading positions across tab reloads.  If a saved topic or heading disappears, its section displays `Topic unavailable` with its identifier.  Bookmarks remain stored, and other available sections still render.  Reload or selecting the bookmark retries lookup.

Show Documentation opens a topic.  Show Candidates searches titles and keywords.  Show Table of Contents lists a topic's descendants, and Show Overview displays its relationships and source.  Mouse-Left reads a topic, Mouse-Middle opens its overview, and Mouse-Right opens topic operations.  Shift-Middle inserts a deferred bookmark from a topic or discards one from the Bookmarks pane.

Read Private Document appends saved topic references to the selected viewer.  Mouse-Right on its command-menu item offers Save, Load, and Hardcopy Private Document.  Load inserts deferred bookmarks without displaying text.  Save writes bookmarks in displayed order through a retained guest job.  Its result appears in Evaluations.  Hardcopy uses the browser's print dialog without changing the viewer.  The [Document Examiner guide](../../../doc/document-examiner.md) defines search options, viewer commands, private-file format, and pathname defaults.

## Peek and activity selection

Peek lists guest threads, sampled scheduler fields, and existing retained debugger stops.  It opens from the System Menu or with F9 followed by P.  Processes mode uses a 20-second refresh interval while visible.  SPACE requests a sample, a number followed by Z changes the interval, F12 selects Help, and Q returns to the previous activity.  Describe shows sampled fields.  Debugger selects an associated retained stop.  The [Peek guide](../../../doc/peek.md) explains runtime, sampling, and state interpretation.

F9 starts SELECT.  L selects the Listener, D selects Document Examiner, and P selects Peek.  F9 followed by F12 lists supported activities.  Backspace cancels selection.  Existing editor input remains unchanged when switching activities.  F9 is the Web interface's SELECT mapping.

## Connections and recovery

A tab retains its session identity, input history, request records, and viewer state in sessionStorage.  Reload resumes the same session.  Independent tabs create separate sessions.  Duplicated tabs can inherit one identity.  Closing a browser or releasing a session leaves guest jobs retained until explicit release.  Stored output and results consume guest memory.

Each HTTP operation opens a SWANK connection and closes it after the operation.  Debugger control lasts for that connection.  The guest preserves accepted jobs and debugger commands independently of the connection.

Request History distinguishes rejected requests from requests whose replies were lost.  Repeat Original Request uses the recorded evaluation name, input range, interrupt ID, debugger command ID, or private-document Save arguments.  It preserves the identity of the uncertain request.  Recalling input in the Listener and pressing Return creates a new evaluation instead.

For an uncertain release, Check Release Outcome queries the original object.  A released-object response establishes its current state.  An expired reference leaves the original release outcome unknown.  A successful query records that the object was still retained.  Keep in History preserves that observation and permits a separate release request.

When the guest reports an expired session, the browser creates a new session, archives request and debugger-command records under their original session, and discovers retained jobs and stops through new tokens.  Input history and Document Examiner viewers remain stored.  The current activity refreshes after connection.  Recovery preserves prior requests in Request History and requires a new submission to evaluate an expression again.  Transport failures retain the existing session identity for Connect / Resume.  New Session also permits explicit replacement while disconnected.  Release Session requires unresolved requests to be resolved or archived.

## HTTP API

`POST /api` takes `session`, `operation`, and optional `arguments` fields.  Session and job names are 64 lowercase hexadecimal digits.  Job, stop, and frame tokens belong to the request's session.

| Operations | Arguments |
|---|---|
| open-session, resume-session, jobs, release-session | None. |
| stops | Optional include_closed. |
| listener-information, processes | None. |
| monitor-state | Optional offsets: objects with name and start fields. |
| start-listener | name, source.  Optional interactive. |
| listener-assistance | source, cursor, action.  Optional context, presentation. |
| start-evaluation | name, source.  Optional package, input, interactive. |
| job-information, release-job | job. |
| job-output | job, start.  Optional end. |
| job-input | job, offset, text.  Optional eof. |
| interrupt-job, job-interrupt-result | job, id. |
| information, release-stop | stop. |
| result | stop, id. |
| submit | stop, id, command.  Optional argument. |
| document-query | action.  Optional topic, query, mode, adjacent. |
| document-assistance | source, cursor, action. |
| save-private-document | name, pathname, topics. |
| read-private-document | pathname. |

Monitor-state returns Listener information, all retained jobs with incremental output, and active and closed stops.  Output shares a 65,536-character response budget.  Each row reports its start and end offsets and the full sampled output length.  Supplying the returned ends on the next request retrieves remaining output.  Metadata and printed values remain subject to the SWANK message-size limit.

Submit accepts condition, restarts, frames, locals, abort, help, invoke-restart, and invoke-restart-interactively.  Locals requires a frame token.  Both restart operations require a restart index.  Invoke-restart calls the restart with zero arguments.  Invoke-restart-interactively runs its interactive argument reader.  Abort and Help take no argument.  The [retained debugger protocol](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) defines operation semantics, states, token lifetimes, and errors.

Success returns `{"value": ..., "diagnostics": [...]}`.  Failure returns an `error` and, for operation failures, an `uncertain` flag.  Input validation precedes SWANK dispatch.  Transport or remote decoding failures after dispatch report an uncertain outcome.  Requests require a Content-Length header, and bodies are limited to one MiB.  Chunked transfer encoding is unsupported.
