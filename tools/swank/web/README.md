# Mezzano Web Listener and Debugger

The Web interface provides a Lisp Listener, debugger, retained evaluations, Peek process viewer, and Document Examiner.  A Lisp HTTP server inside Mezzano serves the browser files and calls the shared remote service.  Evaluations, output, debugger stops, and command results remain in the guest across browser disconnections.

## Installation and access

The guest requires the matching Mezzano core, Jzon, Babel, and Web server sources.  The browser requires JavaScript and sessionStorage.  The shared remote service supplies the same retained sessions and debugger operations to HTTP and SWANK.  The [installation guide](../../../doc/installation.md) covers the guest and JSON dependencies.

Load the server from a guest Listener:

```lisp
(load "SYS:SOURCE;TOOLS;SWANK;WEB;LOAD-MEZZANO.LISP")
(defparameter *web-server*
  (mezzano.web:start-server
   :address "0.0.0.0" :port 8765
   :allowed-authorities '("lispm.example.net:8765" "localhost:8765" "127.0.0.1:8765")
   :root (translate-logical-pathname "SYS:SOURCE;TOOLS;SWANK;WEB;")))
```

Open `http://lispm.example.net:8765/` after forwarding the guest port through QEMU.  Each allowed authority includes the hostname and external HTTP port.  The external port may differ from the guest listening port.

| Argument | Default | Meaning |
|---|---|---|
| `:address` | `"0.0.0.0"` | Guest IPv4 listening address. |
| `:port` | `8080` | Guest HTTP listening port. |
| `:allowed-authorities` | Required | List of accepted HTTP hostname:port strings. |
| `:root` | Required | Physical directory pathname containing the browser files and fonts. |
| `:timeout` | `15` | Socket receive/send deadline in seconds. |

The browser has a 20-second fetch deadline.  Synchronous metadata and documentation requests can continue in the guest after a browser stops waiting.  Accepted evaluations and debugger commands retain their identities and results for recovery.

`(mezzano.web:stop-server *web-server*)` stops the listener, cancels its accepted connections, and waits for its threads to finish.  Retained evaluations and debugger commands keep their existing threads and records.

The server reads only its explicit asset allowlist beneath `:root`.  A persistent deployment selects a pinned asset directory.  The [installation guide](../../../doc/installation.md#pinned-web-deployment) describes preparing that directory and coordinating guest and browser updates.

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

Interactive evaluations accept text and EOF through their input controls.  Interrupt is available when the guest reports that the evaluation or its running debugger command can be interrupted.  It enters a retained debugger stop.  Evaluations lists retained jobs and their states.  Release removes a completed job's stored output and results.  Clear All terminates retained evaluations across Listeners, releases their stored data and closed debugger records, and clears this tab's evaluation histories.  Its result remains available as Command result in Evaluations for request recovery.  Clear Output History clears the displayed transcript and initial herald while preserving input history and retained jobs.  The cleared state persists across tab reloads.

## Debugger

The owning Listener displays a stopped evaluation inline.  Its Debugger action opens the same retained stop in the separate Debugger activity.  Both views use the guest command parser and display the stack, current frame, restart choices, and condition.  The browser requests these inspections in sequence when you select a stop or complete a step.  It requests the next inspection as soon as the preceding one completes and polls a pending result at the normal refresh interval.  Reload reuses retained results.  A repeated inspection keeps its previous completed result visible while the new command is pending, provided its frame index still agrees with the guest's current frame.  Inspection and restart buttons are disabled while a debugger command is outstanding or a child stop is active.  The command input remains editable while stopped.  Rejected commands preserve the editor text and cursor.  The Debugger activity also lists stops.  Condition inspection and frame navigation are also available from the System Menu.  The debugger prompt accepts these commands:

| Command | Behavior |
|---|---|
| `:Abort` | Invokes the stop's ABORT restart.  In a child entered by a debugger command, it abandons that command and returns to the enclosing debugger. |
| `:Return` | Reads one expression supplying the selected activation's return values, then asks for confirmation. |
| `:Reinvoke` | Requests a new call from the selected activation using current parameter values, after confirmation. |
| `:Reinvoke :Original Args` | Uses the original supplied argument sequence. |
| `:Reinvoke :New Args` | Reads one expression supplying an argument list before confirmation. |
| `:Proceed` or `:Proceed Default` | Invokes the first captured CL:CONTINUE restart interactively.  The restart list marks it `Default`. |
| `:Proceed N` | Invokes the restart with zero-based index N interactively. |
| `:Proceed N :Arguments` | Reads and evaluates an argument-list expression, then invokes restart N with those arguments.  Omit N or use Default to select the default restart. |
| `:Use Dynamic Environment` | Evaluates forms without the selected frame's lexical bindings. |
| `:Use Lexical Environment` | Evaluates forms using the selected frame's lexical bindings. |
| `:Help` | Displays the guest debugger command help. |
| `:Show Backtrace` | Lists frames. |
| `:Set Current Frame N` | Selects a frame by its zero-based index and displays its locals. |
| `:Next Frame` | Selects the next older caller.  `:Nframes N` moves N frames. |
| `:Previous Frame` | Selects the next newer frame.  `:Nframes N` moves N frames. |
| `:Top Of Stack` | Selects frame zero. |
| `:Bottom Of Stack` | Selects the last frame. |
| `:Show Frame` | Displays the selected function, original supplied arguments, current source parameters, and available locals. |
| `:Show Function` | Displays the selected frame's associated function and assigns it to this stop's * history value. |
| `:Show Compiled Code` | Disassembles the selected frame's executing function. |
| `:Set Breakpoint FUNCTION PC` | Installs a validated instruction breakpoint.  PC is required. |
| `:Clear Breakpoint FUNCTION [PC]` | Removes that location.  PC defaults to byte 16. |
| `:Clear All Breakpoints [FUNCTION]` | Removes a named function's locations, defaulting to the selected executing function. |
| `:Show Breakpoints` | Lists all installed function/offset locations. |
| `:Show Instruction` | Displays the instruction containing the saved caller location or the interrupted program counter. |
| `:Show Lexical Environment` | Displays bindings inherited from lexical ancestors of the selected frame. |
| `:Show Special SYMBOL` | Displays the selected frame's special binding.  :Environment selects Program or Debugger. |
| `:Show Standard Value Warnings` | Displays invalid or unbound reader/printer controls and their debugger replacements. |
| `:Show Arglist` | Displays the selected compiled function's argument list, preserving the active definition after redefinition. |
| `:Show Argument [index or All]` | Displays current source parameters.  All is the default.  An available indexed value becomes this stop's * value, and + receives its checked location. |
| `:Show Rest Argument` | Displays the current rest parameter and assigns it to this stop's * history value. |
| `:Show Bindings` | Displays special-variable bindings established by the selected frame.  :All selects every frame.  :Matching filters symbol names. |
| `:Show Condition Handlers` | Displays condition handlers established by the selected frame and their active status at stop entry.  :All selects every frame. |
| `:Show Catch Blocks` | Displays catch tags and their destination functions and byte offsets.  :All selects every frame. |
| `:Show Local All` | Displays the selected frame's recorded locals, preserving history.  All is the default. |
| `:Show Local N` | Displays one recorded local by its zero-based index.  An available value becomes *, and + receives its checked location. |
| `:Show Proceed Options` | Lists restart choices. |
| `:Inspect` | Inspects this stop's * history value. |
| `:Describe Last` | Describes this stop's * history value. |
| `:Clear Inspector` | Releases this stop's Inspector references and clears its displayed inspection history. |

Input without an initial colon evaluates one Lisp form in the debugger's selected evaluation environment.  A new top-level stop defaults to lexical evaluation, using the selected frame's lexical environment.  For example, `x` reads a binding, `(setq x 42)` writes it, and `(values x (helper))` returns multiple values.  Writes take effect immediately and must satisfy the binding's declared type and storage representation.  :Show Frame refreshes previously printed arguments and locals.  Evaluation sources and their printed results remain in command order, including across reload and stop closure.  Zero values display `(No values)`.

Control-X I in either debugger editor toggles lexical and dynamic evaluation without changing the draft or cursor.  The guest reports `Eval (program): ` for lexical evaluation and `Eval (debugger): ` for dynamic evaluation.  While editing a form, the prompt appends that label after the nesting arrows.  Blank input and colon commands retain the arrows.  Dynamic evaluation uses global bindings and the stopped command thread's current special bindings.  A child debugger inherits its parent's choice and can change its own mode independently.  Mode changes preserve selection and evaluation history.  Reload retains the mode and draft.  An accepted toggle repeated with its original command ID executes once.

Lexical evaluation uses the selected frame's original special-variable cells.  Interpreted forms and compiled callees read and write those cells, and writes take effect immediately.  New LET and PROGV bindings during evaluation shadow the selected cells and unwind normally.  Dynamic evaluation uses the bindings at the point of error.  Debugger history, validated reader/printer controls, existing streams, and handler suppression remain in effect.  An unavailable historical special environment raises :UNAVAILABLE-SPECIAL-ENVIRONMENT.  Historical special lookup currently supports established x86-64 condition stops.

The debugger gives each stop separate bindings for `*PACKAGE*`, `*READ-BASE*`, `*PRINT-BASE*`, and `*READ-DEFAULT-FLOAT-FORMAT*`.  Valid values and edits persist within that stop.  Before each command, Lisp replaces an invalid or unbound control with its standard value.  `:Show Standard Value Warnings` displays the original and replacement values, distinguishing bound `NIL` from `[unbound]`.  The command takes no arguments and preserves frame selection and evaluation history.  Its text remains in command order across reload.  A failing original-value printer enters a child debugger, where `:Abort` abandons the display.  Continuing or unwinding restores the program's bindings.  More Processing and Output Destination options are unsupported.

:Show Special reads one symbol without evaluating it.  Its required symbol argument uses Lisp spelling in this level's validated `*PACKAGE*`.  The command's menu entry opens the editor for that argument.  Guest assistance completes commands, keywords, and environment choices.  Symbol-name discovery is unsupported.  Command quotes preserve whitespace or a leading colon in symbol source, for example `:Show Special "|mixed name|"` or `:Show Special ":KEYWORD"`.  :Environment Program reads the selected frame's binding, including inherited bindings and global fallback.  Omitted :Environment and a mentioned keyword without a value both select Program, independently of evaluation mode.  :Environment Debugger reads this level's nine retained history values for their symbols and the current command's dynamic bindings otherwise, including the four reader/printer controls.  An evaluation temporarily binds minus to its current form.  Show Special reads the binding currently in effect.  Minus is not stored as a tenth history value.  Streams is recognized but reports unsupported.  The command preserves selection, mode, histories, and program bindings.  Program lookup supports established x86-64 condition-stop frames.  Bound NIL, unbound, and unavailable values remain distinct.  Reader or printer errors enter a child, where typed :Abort returns to the parent.  Printed results survive reload and stop closure.

Each debugger stop has separate `+`, `++`, and `+++` form history, `*`, `**`, and `***` primary-value history, and `/`, `//`, and `///` lists of returned values.  `-` holds the current form.  An evaluation error enters a child debugger.  Typed :Abort abandons that evaluation and returns to the parent.  Read-time evaluation is disabled, and the source must contain exactly one form.  Frames without lexical scope information reject lexical evaluation.  Dynamic evaluation remains available.  Client frame references expire on stop exit or a boot change.  Lisp bindings retained by frame evaluation remain usable on the owning stopped thread across image restoration.  Stop exit or release invalidates those bindings, and another thread cannot use them.  The [frame-evaluation reference](../../../doc/debugger.md#frame-evaluation) describes their lifetime.

:Show Function assigns the associated function object to * without rotating value or form history.  The other eight history slots and frame selection remain unchanged.  :Inspect can then inspect that function.  Unlike Genera, the command does not assign a function locative to +.

:Show Compiled Code and :Show Instruction use the executing function retained by the selected frame, including after its global definition changes.  They preserve history and selection.  Code output covers that one function, with hexadecimal byte offsets from the function object and instruction bytes.  Long lines scroll horizontally.  Unavailable locations produce explicit messages, and undecoded bytes remain visible.  Instruction output labels a saved caller location or an interrupted program counter.  A saved caller location identifies the suspended call, rather than a next instruction under stepping.  These commands take no arguments.  Current execution tests cover x86-64.  ARM64 acceptance remains untested.  Explicit function specifications, PC ranges, More processing, output redirection, Genera accelerators, and PC breakpoint mouse actions are unsupported.  Printed results survive reload and stop closure.

:Single Step uses the selected stop's retained instruction-step operation through the same command parser and menu as the other debugger commands.  The native service validates the interrupted location and instruction.  The [native stepping reference](../../../doc/debugger.md#native-breakpoint-entry) describes instruction, CALL, and nonlocal-exit support.  A step that transfers control displays its retained `unwound` result.  Repeating an accepted request uses its original command ID.

While the stop is stepping, its Listener and debugger editors and live actions are disabled.  Draft text, cursor selection, and evaluation mode remain unchanged.  The guest retains the Listener/job association and stop token through that transition and reload.  Fresh condition, restart, backtrace, and frame results must match the stop's current generation.  Earlier printed transcripts and Inspector pages remain visible.  Actions using an earlier generation's Inspector references stay disabled.

Native instruction traps initially select the interrupted program frame, as described in the [native breakpoint reference](../../../doc/debugger.md#native-breakpoint-entry).

:Show Lexical Environment takes no arguments.  It displays inherited variable and function bindings, excluding bindings established by the selected activation.  A current local captured by an inner closure remains a current binding.  Known-empty ancestry reports `This frame was not lexically called.`  Missing ancestry metadata reports `Lexical ancestry unavailable.`, and a binding without accessible storage displays `[unavailable]`.  The command preserves selection and evaluation history.  Printing errors enter a child debugger, and typed :Abort returns to the parent.  Reload and stop closure retain the printed output.  Unused outer capture after the defining activation returns remains a compiler limitation.

:Show Arglist displays the argument list stored with the selected compiled function.  An empty list displays NIL.  Missing metadata produces an explicit unavailable message.  The command preserves frame selection and evaluation history, and its printed result survives reload.

:Show Rest Argument takes no arguments and displays the selected frame's current rest parameter.  It assigns that object to * before printing and preserves the other eight history slots and selection.  Available NIL, absent rest, and unavailable metadata/storage have distinct displays.  A printer error can enter a child debugger, where :Abort returns to the enclosing stop.  Declared dynamic-extent values require their allocating extent.  The [current-rest reference](../../../doc/debugger.md#current-rest-argument) gives the native scope and tests.

:Show Bindings lists repeated bindings in inner-to-outer order and distinguishes bound NIL from an unbound value.  :All defaults to No.  Mentioning :All without a value selects Yes.  :Matching requires a string and uses a case-sensitive literal substring of the symbol name.  Omitting it selects every name.  The command preserves frame selection and evaluation history.  Frameless and other unsupported frames produce an unavailable message.  Established x86-64 condition and hardware-stop frames passed binding-display tests.  ARM64 binding inspection and :Invisible are unsupported.

:Show Condition Handlers identifies each handler's condition type, function, and active or inactive status when the stop began.  During handler invocation, the selected cluster and inner clusters are inactive.  Remaining outer clusters stay active.  Frame headers identify the runtime frame that established the cluster.  :All defaults to No, and mentioning it without a value selects Yes.  The command preserves frame selection and evaluation history.  Reload retains its printed result.  Empty frames and unavailable handler locations have explicit messages.  Established x86-64 condition-stop frames passed display tests.  Native interrupted-frame handler display remains untested.  ARM64 reports handler locations unavailable.

:Show Catch Blocks identifies each catch tag and its destination function and hexadecimal byte offset from the compiled function object.  This is the existing disassembler offset convention.  THROW supplies the returned values.  The runtime catch exit returns into MEZZANO.INTERNALS::%CATCH, which then returns those values to its caller.  Frame headers identify the runtime owner.  :All defaults to No, and mentioning it without a value selects Yes.  The command preserves frame selection and evaluation history, including repeated tags as separate catch entries.  Reload retains its printed result.  Missing destination metadata, unavailable catch locations, and empty frames have distinct messages.  Established x86-64 condition-stop frames passed display tests.  Native interrupted-frame catch display remains untested.  ARM64 reports unavailable catch locations.

Show Frame labels the original supplied sequence separately from current required, optional, rest, keyword, and supplied-p bindings.  Original positions preserve duplicate and unknown keywords accepted by the call.  Current supplied-p bindings can have changed since entry.  Zero original arguments, no current parameters, available NIL, and unavailable values have distinct displays.  The command preserves evaluation history.  Original entry and current parameter data require eligible x86-64 DEBUG 3 frames.  Show Argument uses the same current source-parameter indices: required, optional, one rest binding, then declared keys.  Supplied-p variables and AUX locals have no argument index.  All preserves history.  An available indexed value assigns * and its checked location to +.  DBG:ARG reads or writes by source index or exact name.  DBG:LOCATION-VALUE reads or writes a retained location.  Evaluating + puts that location in * for :Inspect, whose single Value row supports modification.  Ordinary evaluation rotates + history.  Missing declaration metadata clears + and reports the unavailable location while preserving a readable value in *.  Detailed frame options remain unsupported.  The [argument reference](../../../doc/debugger.md#current-arguments) describes availability, invalid indices, and lifetimes.

Show Local prints the same visible local indices as Show Frame.  Its indexed result publishes `+` and `*` before printing.  All and unavailable storage preserve history.  Missing declaration metadata leaves the value readable in * and clears +.  DBG:LOC reads or writes a local by index in either evaluation mode.  Local locations support the same Value-only Inspector operation as argument locations.  The [local reference](../../../doc/debugger.md#current-locals) specifies declarations, shadowed bindings, invalid indices, and lifetime.

The guest retains the current frame for each stop across browser reload and reconnection.  A child stop starts at frame zero and has its own selection.  Clicking a backtrace row selects that frame.  Next and Previous default to one frame.  Zero redisplays the current frame.  A target outside the stack reports an error and preserves the selection.  Repeating an uncertain navigation request with its original command ID moves once.  If printing a frame enters a child debugger, :Abort abandons that inspection and preserves the guest's selected index.  The browser waits for another explicit frame command before retrying the failed inspection.  Selection by another controller updates the highlight.  When the retained result does not match, :Show Frame requests its arguments and locals.

The :Proceed button invokes the default restart.  If no CL:CONTINUE restart exists, the guest rejects that request, and the debugger remains available for an explicit choice.  The error remains in Request History.  Restart lines show their indices and invoke the selected restart interactively.  The command-I/O client displays a restart's QUERY-IO output and input under that command in both debugger views.  A restart can return to the same stop or transfer control out of it.  Returned restart values, including values from a returning :Proceed or :Abort, appear in the debugger, with `(No values)` for zero values.  Unavailable local values display `<unavailable>`.  The frame display lists available lexical locals.  :Reinvoke :Original Args uses the guest's retained supplied-argument metadata when present.  The selected frame's function and index identify the displayed locals.  The [debugger guide](../../../doc/debugger.md) describes stopping states and the compiler information required for local inspection.

Each restart also has a :Proceed N :Arguments button.  It requests one Lisp expression through the command's input controls, allowing arguments even when the application supplies no interactive reader.  For example, `(list 35)` supplies one argument, and NIL supplies none.  Lisp evaluates that expression on the stopped thread in its current dynamic environment and a null lexical environment.  The primary value must be a finite proper list.  Read-time evaluation is disabled.  Typed :Arguments without a value means Yes.  :Arguments No, or omitting the keyword, uses the restart's interactive reader.  An error while reading, evaluating, or invoking enters a child stop.  :Abort abandons that argument command and returns to its parent.

:Return reads one Lisp expression through its command Input control, evaluates it in the selected mode, displays all returned values, and asks for confirmation naming the frame.  Each answer follows its prompt.  A negative answer displays `Return cancelled.` and preserves the expression's history and side effects.  A positive answer unwinds the selected activation and its younger activations.  The original caller receives the expression's zero, one, or multiple values.  Reader, evaluator, printer, and confirmation errors enter a child, where :Abort abandons Return.  Unlike Genera's expected-value prompts, one expression supplies every value.  The [Frame Return reference](../../../doc/debugger.md#frame-return) describes activation restrictions and cleanup behavior.

Reinvoke uses the same command Input control and retained text output.  Both :Original Args and :New Args default to No when omitted and Yes when mentioned.  They cannot both be Yes.  The guest captures the selected frame, callable, and argument list once, displays every argument by index, and asks for confirmation.  A negative answer returns `Reinvoke cancelled.`.  Current reconstruction supplies optional/key values explicitly and derives new supplied-p values.  Original preserves the supplied sequence and omissions.  New Args uses the prompted expression's primary value as the list, or NIL for zero values.  The [Frame Reinvoke reference](../../../doc/debugger.md#frame-reinvoke) describes argument reconstruction, callable selection, activation limits, and dynamic-extent requirements.

Command evaluation, printing, and normally returning restart functions execute with the paused application's condition handlers disabled.  Handlers installed inside a command remain active.  Continuing or unwinding the paused computation restores its handlers.

Printing a condition or value can enter a child stop.  Interrupting a running debugger command also creates a child stop, including when its parent came from an earlier interruption.  The owning Listener follows that child, and :Abort returns to its parent without continuing the original computation.  Parent Stop and Child Stop navigate the relationship in the separate Debugger while the parent command remains running.  Closed stops retain previously queried results until Release Stop.  If cleanup enters another debugger on the same thread, Current Stop selects the guest-supplied active stop.  This explicit action preserves the closed stop's displayed results until navigation.  Closing a stop clears its selected frame and backtrace highlight.  The last returned frame inspection remains labelled as a recorded frame from the closed stop.

The Web debugger exposes condition, frame, local, and restart inspection, interruption, lexical frame evaluation and writes, object inspection and modification, and restart invocation with interactive or explicit arguments.  Selected-frame disassembly is available.  Source views remain unavailable.

### Debugger command input and output

Each accepted command retains its own output and input, including commands entered from batch evaluations or threads without evaluation jobs.  Both debugger views display the same command output and Input, Send Input, and EOF controls.  Program input remains in the evaluation's input controls.

Unsent command input and its cursor use the existing draft storage, keyed by stop and command IDs.  Sending input records its command ID and character offset.  Request History can repeat that request after a lost reply.  EOF ends input for that command.  A later command starts with fresh input.  A nested command has its own input, and returning to the parent restores the parent's draft.  Completed output remains available until the stop is released.  After a lost submit reply, the browser can recover an accepted command's result and input controls from its guest ID.  The uncertain request remains in Request History for exact replay, and new commands remain blocked until that request is resolved.

### Object Inspector

:Inspect opens the Inspector in the selected debugger stop.  Its History lists completed inspections, and three panes show the latest observations, with the newest at the bottom.  Click a component value to inspect it.  Each history entry identifies its component range.  Click the entry to inspect that object and range again.  More Above and More Below select component pages.  Refresh reads the displayed object and range again.  Describe returns its description in the debugger transcript.  Reload displays retained results without repeating these operations.

Modify beside an editable component requests a Lisp expression through that command's Input control.  The stop's selected evaluation mode and history apply.  The expression's primary value replaces that component, and the resulting inspection preserves the page size and position.  An unbound slot displays `<unbound>` and can still be writable.  A bound NIL displays `NIL` and can be inspected.  A type, reader, writer, or printer error enters a child debugger.  :Abort abandons that command and returns to the parent.  A completed store remains effective if later printing fails.  Refresh can inspect the changed object after recovery.

Clear releases Inspector references and clears its displayed history.  It preserves recorded command outcomes for exact-request replay.  Closing a stop leaves its recorded panes visible with controls disabled.  References from a cleared Inspector or earlier boot cannot access current objects.  Clearing from another client can leave printed controls visible until use reports that their references expired.  Other threads can change shared objects between inspections.

The Inspector displays cons cells, array elements, symbol fields, hash-table keys and values, and supported instance and structure slots.  The guest supplies the components and identifies writable places.  Each inspection is one bounded page.  The three panes can show successive pages or refreshes of one object.  This debugger-attached Inspector uses expression-based modification and fresh history navigation.  A standalone Inspector activity, Genera's middle/right-button operations, Return, Set backslash, function internals, and general Genera locatives remain unavailable.  Checked argument locations expose one writable Value row.

## Document Examiner

Document Examiner opens from the System Menu.  Its Viewer displays topics.  Current Candidates lists lookup results, Bookmarks retains viewed and deferred topics, and Commands accepts documentation commands.  Named viewers preserve separate topic lists, bookmarks, candidate histories, and reading positions across tab reloads.  If a saved topic or heading disappears, its section displays `Topic unavailable` with its identifier.  Bookmarks remain stored, and other available sections still render.  Reload or selecting the bookmark retries lookup.

Show Documentation opens a topic.  Show Candidates searches titles and keywords.  Show Table of Contents lists a topic's descendants, and Show Overview displays its relationships and source.  Mouse-Left reads a topic, Mouse-Middle opens its overview, and Mouse-Right opens topic operations.  Shift-Middle inserts a deferred bookmark from a topic or discards one from the Bookmarks pane.

Read Private Document appends saved topic references to the selected viewer.  Mouse-Right on its command-menu item offers Save, Load, and Hardcopy Private Document.  Load inserts deferred bookmarks without displaying text.  Save writes bookmarks in displayed order through a retained guest job.  Its result appears in Evaluations.  Hardcopy uses the browser's print dialog without changing the viewer.  The [Document Examiner guide](../../../doc/document-examiner.md) defines search options, viewer commands, private-file format, and pathname defaults.

## Peek and activity selection

Peek lists guest threads, sampled scheduler fields, and existing retained debugger stops.  It opens from the System Menu or with F9 followed by P.  Processes mode uses a 20-second refresh interval while visible.  SPACE requests a sample, a number followed by Z changes the interval, F12 selects Help, and Q returns to the previous activity.  Describe shows sampled fields.  Debugger selects an associated retained stop.  The [Peek guide](../../../doc/peek.md) explains runtime, sampling, and state interpretation.

F9 starts SELECT.  L selects the Listener, D selects Document Examiner, and P selects Peek.  F9 followed by F12 lists supported activities.  Backspace cancels selection.  Existing editor input remains unchanged when switching activities.  F9 is the Web interface's SELECT mapping.

## Connections and recovery

A tab retains its session identity, input history, request records, and viewer state in sessionStorage.  Reload resumes the same session.  Independent tabs create separate sessions.  Duplicated tabs can inherit one identity.  Closing a browser or releasing a session leaves guest jobs retained until explicit release.  Stored output and results consume guest memory.

Each HTTP request attaches the shared guest session and releases its debugger controller before replying.  Session handles and retained results persist between requests.  HTTP responses close their TCP connections.  A later request resumes the same guest session.  SWANK uses the same service with connection ownership.

Server shutdown closes the listener, cancels open HTTP sockets and request workers, and waits for cleanup.  Accepted evaluations and debugger commands remain in the guest.  Cancellation can lose its HTTP reply, leaving an uncertain outcome for recovery through the original request identity.

Request History distinguishes rejected requests from requests whose replies were lost.  Repeat Original Request uses the recorded evaluation name, input range, interrupt ID, debugger command ID, or private-document Save arguments.  It preserves the identity of the uncertain request.  Recalling input in the Listener and pressing Return creates a new evaluation instead.

The bottom-line request error persists through automatic polling and activity rendering.  A successful explicit request clears the preceding error, including when the guest accepts a submission that is still running.  An action preserves an error or informational message reported while it runs.  Existing Request History records remain unchanged.

For an uncertain release, Check Release Outcome queries the original object.  A released-object response establishes its current state.  An expired reference leaves the original release outcome unknown.  A successful query records that the object was still retained.  Keep in History preserves that observation and permits a separate release request.

When the guest reports an expired session, the browser creates a new session, archives request and debugger-command records under their original session, and discovers retained jobs and stops through new tokens.  Input history and Document Examiner viewers remain stored.  The current activity refreshes after connection.  Recovery preserves prior requests in Request History and requires a new submission to evaluate an expression again.  Transport failures retain the existing session identity for Connect / Resume.  New Session also permits explicit replacement while disconnected.  Release Session requires unresolved requests to be resolved or archived.

Select a retained job's Debugger action to recover its command history.  The browser reads accepted command results from the guest without resubmitting commands.  Fresh stack, restart, condition, and current-frame inspections precede historical loading.  Older results arrive one at a time, with live actions taking priority.  A received/total count remains visible until loading completes, including after page reload.  Evaluation captions use the guest's retained source.  Other recovered commands use their canonical names.  Known command records also receive their results in Request History after reload.  The guest preserves frame selection and expression/value history.

Results recorded before image restoration are labelled `Recorded before this boot.`  Their Inspector values remain readable, with reference actions disabled.  Fresh Inspect commands create current references.  A replacement session has its own Listener, so a retained active evaluation remains accessible through its Debugger action.

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
| command-output | stop, id, start.  Optional end. |
| command-input | stop, id, offset, text.  Optional eof. |
| submit | stop, id, command.  Optional argument. |
| document-query | action.  Optional topic, query, mode, adjacent. |
| document-assistance | source, cursor, action. |
| save-private-document | name, pathname, topics. |
| read-private-document | pathname. |

Monitor-state returns Listener information, all retained jobs with incremental output, and active and closed stops.  Output shares a 65,536-character response budget.  Each row reports its start and end offsets and the full sampled output length.  Supplying the returned ends on the next request retrieves remaining output.

Submit accepts condition, restarts, frames, locals, local, argument, rest-argument, current-frame, select-frame, next-frame, previous-frame, top-frame, bottom-frame, evaluate, inspect, modify, describe-object, clear-inspection, abort, proceed, return, reinvoke, help, invoke-restart, invoke-restart-interactively, invoke-restart-with-arguments, arglist, bindings, handlers, catches, function, compiled-code, instruction, single-step, set-breakpoint, clear-breakpoint, clear-all-breakpoints, breakpoints, lexical-environment, standard-value-warnings, special, use-dynamic-environment, use-lexical-environment, and toggle-evaluation-environment.  These three environment operations take no argument and return the selected evaluation-prompt string.  Stop information and Listener debugger information report evaluation-environment and evaluation-prompt.  Function, compiled-code, instruction, and lexical-environment take no argument and return strings.  Locals requires a frame token.  Local and Argument accept null for All or a nonnegative integer index.  They return guest-formatted text and use the local or source-parameter indices described above.  Rest-argument takes no argument and returns guest-formatted text.  Select-frame requires a nonnegative index.  Next-frame and previous-frame require a nonnegative count.  Current-frame, top-frame, and bottom-frame take no argument.  These six frame commands return index, function, and locals fields.  Stop information reports current-frame, or null for a closed stop.

Result returns state, operation, current-boot-p, result, source, input-length, input-eof-p, input-waiting-p, and output-length.  Source is the copied accepted string for evaluate and null for other operations.  Reading a result preserves command identity and does not execute the command again.  Historical commands without retained I/O report input length 0, EOF true, waiting null, and output length 0.

Command-output returns start, text, and end, using character offsets and an exclusive end.  Command-input uses the command controller and returns the accepted end offset.  Repeating the same input range preserves the accepted bytes.  EOF ends input for that command only.  A fresh stop handle can supply input to a running command retained across image restoration.  Prior-boot command submission remains rejected.

Return takes no argument and reads its expression and confirmation through retained command input.

Reinvoke requires `[originalArguments, newArguments]`, each a Boolean or null.  Null means false.  `[false, false]` selects current arguments, `[true, false]` selects original arguments, and `[false, true]` requests new arguments.  Both true, missing options, and malformed lists are rejected.  The HTTP adapter sends a fresh Lisp Boolean list through the existing submit operation.

Set Breakpoint and Clear Breakpoint require `[function-source, offset]`, with a source string and a nonnegative integer byte offset.  Clear-all-breakpoints accepts a function-name source string or null for the selected frame's exact executing function.  Breakpoints takes no argument.  Lisp reads function names with read-time evaluation disabled and validates new locations against instruction metadata.  All four return guest-formatted strings.  Same-ID replay compares copied arguments and returns the original result.  The [compiled-breakpoint reference](../../../doc/command-processor.md#compiled-breakpoints) defines name quoting, offset defaults, four-location x86-64 capacity, and redefinition behavior.

Arglist takes no argument and returns the guest-formatted signature or unavailable message as a string.

Standard-value-warnings takes no argument and returns the guest-formatted warnings.

Special requires `[symbol-source, environment]`.  Symbol-source is a string, preserved as text through HTTP and SWANK.  Environment is :program, :debugger, or :streams.  The HTTP adapter converts that selector to a protocol keyword.  The guest rejects Streams before accepting a command.  Lisp reads exactly one symbol with read-time evaluation disabled when the command executes.  Same-ID replay compares the copied source and selector and retrieves the retained result.  The result identifies the symbol and environment as formatted text.

Bindings accepts null for the selected frame without filtering, or `[all, matching]`.  All accepts true, false, or null.  False and null encode Lisp NIL.  Matching is a string.  The result is guest-formatted binding text.  Repeating an accepted command compares a copied argument list and string by EQUAL.

Handlers accepts null or false for the selected frame, or true for all frames.  Its result is guest-formatted handler text, including each handler's active status at stop entry.

Catches accepts null or false for the selected frame, or true for all frames.  Its result is guest-formatted catch text, including destination functions and hexadecimal byte offsets where metadata is available.

Evaluate requires one source string and returns an array of printed values, or null for zero values.  Evaluation and printing errors enter a child debugger.  Repeating an uncertain evaluation with the original command ID and source retrieves that command without evaluating it again.

Inspect accepts null for the stop's * history value, or `[object-token, start, count]`.  Modify requires `[part-token, start, count]`.  Start is nonnegative, and count is from 1 through 64.  The default inspection starts at zero with count 32.  Both return object, title, type, start, end, count, total, and parts.  End is exclusive.  Count preserves the requested size even on a partial page.  Each part supplies label, bound-p, value, object, and part.  Unbound values have null value and object fields.  A part token is present only for writable places.  Object and part tokens use the existing three-element session-token representation.  Describe-object accepts an object token or null and returns a string.  Clear-inspection takes no argument.

Invoke-restart and invoke-restart-interactively require a restart index.  Invoke-restart calls the restart with zero arguments.  Invoke-restart-interactively runs its interactive argument reader.  Invoke-restart-with-arguments accepts an index or null for the default and reads an argument-list expression through QUERY-IO.  Abort, Proceed, and Help take no argument.  Proceed selects the first captured CL:CONTINUE restart and invokes it interactively.  The [retained debugger protocol](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) defines operation semantics, states, token lifetimes, and errors.

Success returns `{"value": ..., "diagnostics": [...]}`.  Failure returns an `error` and, for operation failures, an `uncertain` flag.  Input validation precedes shared-service dispatch.  Unexpected request-handler failures return HTTP 500 with an uncertain outcome and enter the retained debugger.  Content-Length, when present, must occur once, and bodies are limited to one MiB.  The server rejects Transfer-Encoding and ambiguous framing.  Request lines are limited to 8 KiB, headers to 32 KiB and 100 fields, and active connection workers to 64.  Unexpected server errors remain available as retained debugger stops through SWANK and Peek.
