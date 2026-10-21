# Lisp Command Processor

The Web Listener accepts Command Processor commands and Lisp forms through a guest Lisp module.  Each retained remote session owns a Listener with a package, pathname default, and current job.  The guest parses commands, supplies completion and help, executes commands, and records output presentations.  The browser renders that information and keeps its input and output histories.  The Lisp HTTP server and SWANK adapter call the shared guest session service.

## Input and commands

Command-Preferred is the implemented mode.  Alphabetic input and an initial colon introduce commands.  A known bound variable is accepted when its name does not identify a command.  Other input is Lisp source.  A leading comma forces Lisp reading, including a variable whose name conflicts with a command.  Commands and finite argument choices accept unambiguous prefixes.  Command names are case-insensitive.

```text
Command: Help :Format Detailed
Command: Set Package CL-USER
Command: (+ 20 22)
Command: (defparameter help 42)
Command: ,help
```

| Command | Arguments and behavior |
|---|---|
| Help | Lists supported commands.  :Format Brief is the default, including a mentioned :Format without a value.  Detailed adds descriptions. |
| Set Package | Selects an existing package.  An omitted argument uses the current package. |
| Show Herald | Displays the Listener herald: image version, architecture, memory totals, and keyboard help.  :Detailed Yes adds loaded ASDF systems and declared versions.  An omitted :Detailed means No.  Mentioning it without a value means Yes. |
| Show Command Processor Status | Displays mode, prompt, package, and pathname default. |
| Show Processes | Displays thread names, scheduler states, priorities, wait reasons, recorded run time, and retained debugger stop IDs. |
| Set Breakpoint | Takes a compiled function name and a required PC.  Installs an instruction breakpoint. |
| Clear Breakpoint | Takes a compiled function name and an optional PC, defaulting to byte 16.  Removes that location. |
| Clear All Breakpoints | Takes a compiled function name and removes all its locations. |
| Show Breakpoints | Lists every installed function/offset location. |
| Clear All | Terminates retained evaluations across Listeners, releases their output and closed debugger records, and clears this tab's evaluation histories. |
| Clear Output History | Clears the tab's prior displayed transcript while preserving input history and retained jobs. |
| Show Directory | Lists guest files matching a pathname.  An omitted argument uses a wildcard in the default directory.  A directory pathname acquires wildcard name and type components. |
| Show File | Displays a guest text file and records its pathname as the default. |
| Load File | Calls guest LOAD and records its pathname as the default. |
| Compile File | Calls guest COMPILE-FILE and records the source pathname as the default.  :Load Yes loads the result.  :Load defaults to No when omitted and Yes when mentioned without a value.  :Binary File takes an output pathname. |

File arguments use Mezzano Common Lisp pathname syntax.  Relative names merge with the Listener's pathname default.  Double quotes delimit an argument containing spaces, commas, quotes, or a leading colon.  Logical pathnames obey Common Lisp logical namestring character restrictions.  Physical REMOTE pathnames accept Unicode filenames.

These commands implement the listed arguments and keywords.  Unsupported or duplicate keywords produce an input error.  Compile File supports Yes and No for :Load.  Genera's Ask choice, multiple-file arguments, output redirection, and other command keywords are unsupported.

Show Processes uses `mezzano.debug:process-summary`, the same guest query as Peek's Processes view.  It reports live observations assembled from per-thread scheduler samples.  Run time counts recorded processor time in the displayed units.  An active scheduling interval enters that counter when the thread switches out.  Scheduler state and retained debugger stops are separate: a thread waiting at a retained stop usually has scheduler state Sleeping.  Idle threads are absent from the supervisor's live-thread list.

### Compiled breakpoints

Set Breakpoint requires a function name and a PC.  Clear Breakpoint defaults its PC to byte 16.  PCs accept nonnegative decimal integers or `#x` hexadecimal integers and count bytes from the compiled function object's start, matching Show Compiled Code.  Lisp validates each new location against the compiler's instruction-start map.  An older function without that map reports unavailable metadata until recompiled.

```text
Command: (compile 'demo-add '(lambda (value) (+ value 1)))
Command: Set Breakpoint DEMO-ADD #x10
Command: Show Breakpoints
Command: Clear Breakpoint DEMO-ADD
Command: Clear All Breakpoints DEMO-ADD
```

A function operand uses Mezzano's function-name syntax, including symbols and SETF names.  A name containing spaces needs Command Processor quotes, for example `Set Breakpoint "(setf accessor)" #x10`.  The guest reads one name with read-time evaluation disabled in the Listener's package, or the debugger's current package, and resolves its current definition when the command executes.  It accepts function names rather than arbitrary function-producing expressions.  The [Lisp breakpoint API](debugger.md#lisp-breakpoint-management) accepts exact compiled function objects.

The table identifies a location by its function object and byte offset.  Redefining a name leaves its old locations on the original function.  Show Breakpoints prints the retained function identities.  In the debugger, Clear All Breakpoints with no function uses the selected frame's exact executing function, including an older definition.  The Listener requires an explicit function.

The x86-64 implementation provides four global hardware locations.  Installation/removal synchronizes online CPUs.  A retained hit remains inspectable and can continue after its location is cleared.  Breakpoint commands preserve frame selection and expression/value history.  Retained replay returns the recorded result without repeating the mutation.  Reader, resolution, location, capacity, and printer errors enter the usual debugger.  Conditions/actions and mouse breakpoint operations remain planned.

### Single Step

In the debugger, `:Single Step` takes no arguments or keywords.  It executes one supported x86-64 machine instruction at the selected interrupted frame.  A CALL runs until its return or an escaping RETURN-FROM, GO, or THROW.  The debugger then selects the interrupted destination in the same stop.  The [instruction-step reference](debugger.md#retained-instruction-steps) lists supported instructions and execution contexts.

A step invalidates previous frame and Inspector references.  The Web interface retains their transcript entries, disables their old actions, and loads the new condition, stack, selected frame, and restarts when the step stops.  While the computation is stepping, both command inputs preserve their drafts and reject submission.  Interrupt remains available through the active evaluation.

### Clear All

Clear All deletes retained evaluation data across all Listeners.  Running evaluations terminate through the supervisor's thread termination operation, which runs their unwind cleanup.  The command waits for those threads to exit before releasing their output, values, and closed debugger records.  It also clears this tab's transcript, input history, and prior request and debugger-command records.  Document Examiner viewers and bookmarks retain their documentation state.

Clear All captures its targets after any earlier clearing operation has finished.  Later submissions survive that clearing.  A waiting Clear All already included in another clear's targets is cancelled with those evaluations.  Clear All can run while the same Listener has an active evaluation and preserves package and pathname changes published during that evaluation's cleanup.  Active debugger stops in threads outside the evaluation service remain under debugger control, and the result reports their count.

The clearing command retains its own result for recovery after a lost reply.  The Web interface hides that result from the transcript and labels it Command result in Evaluations.  Repeating its original request recovers the same operation and preserves later work.

### Listener herald

A new Web Listener opens with a detailed herald.  The title, facts, and help come from the guest.  The image version includes the revision recorded at build time.  Physical memory and backing store are totals in KiB.  The backing store holds persistent object memory and paging data.

Show Herald appends the same display to the transcript.  :Detailed lists loaded ASDF systems in two columns.  A dash means the system declares no version.

The opening herald remains above subsequent output until Clear Output History or Clear All.  Reload obtains a fresh opening sample.  A retained Show Herald result preserves the data captured when the command ran, including after reload or request replay.  Text clients receive the same facts and help as plain text, with one system per line.

### Completion, help, and history

SPACE completes the current command or keyword word.  Tab requests COMPLETE for the whole name.  At an empty argument, another SPACE accepts the displayed default.  HELP lists the current commands, choices, or remaining keywords.  The browser provides F12 and Control-? for HELP.  RETURN parses and submits the input.  Shift-RETURN inserts a newline.

Lisp returns replacement text and cursor positions.  The browser applies a response only while its input and cursor match the request.  Offsets count Unicode characters.  The browser converts those offsets to its editor's UTF-16 indices.  A pathname presentation carries character offsets in retained output and its guest namestring.  Job information returns presentations in output order.  Clicking it while a pathname argument is expected asks Lisp to insert and quote that value.

Accepted input history records original submitted text by job name.  Recalling input fills the editor.  Submitting it creates a new job name.  Replaying an uncertain request retains its original name.  Clear Output History records its prior displayed job names before submission, then applies the returned effect once for that owned job.  Reload and replay preserve that boundary, including output accepted after the clearing command.  Effects are applied after the command reaches a terminal state.

The current editor displays the argument prompt and contextual help above the command line.  Genera interleaves argument prompts with editable fields.  Full field editing, grouped command menus, pathname filename completion, general object presentations, and the remaining Command Processor modes are unsupported.

### Debugger commands

A stopped Listener uses its guest-reported innermost debugger stop and nesting prompt.  Debugger commands require a leading colon.  Lisp parses the command and selects the retained operation.  The guest retains the current frame independently for each stop, and the browser renders that selection and its inspection result.  It preserves ordinary Listener input and each debugger level's draft and cursor across entry, exit, and reload.  Input without a leading colon evaluates one Lisp form in the stop's current mode, initially the selected frame's lexical environment.  Lexical assignment takes effect immediately.  Each stop retains its own expression and value histories.  Reader, evaluation, and printing errors enter a child debugger, where :Abort abandons the evaluation and returns to its parent.  The [frame-evaluation reference](debugger.md#frame-evaluation) describes binding availability and lifetime limits.

| Command | Supported behavior |
|---|---|
| :Abort | Invokes the innermost CL:ABORT restart captured by this stop.  At a child caused by a debugger command, its command abort returns to the parent debugger. |
| :Help | Lists the implemented guest debugger commands and descriptions. |
| :Reinvoke | Prepares current arguments and asks for confirmation before calling the selected activation's replacement. |
| :Reinvoke :Original Args | Uses the original supplied sequence and omissions. |
| :Reinvoke :New Args | Reads one expression supplying the new argument list. |
| :Proceed | Invokes the first captured CL:CONTINUE restart interactively.  Omitting the argument selects Default. |
| :Proceed Default | Uses the same default selection as :Proceed. |
| :Proceed index | Invokes the captured restart at that zero-based decimal index interactively. |
| :Proceed index :Arguments | Prompts for a Lisp expression returning the argument list, then invokes that restart.  An omitted index selects Default. |
| :Inspect | Inspects this debugger level's * value. |
| :Describe Last | Describes that value without changing the history. |
| :Clear Inspector | Releases this stop's retained Inspector object and place references. |
| :Show Function | Displays the selected frame's associated function and assigns only the debugger level's * value before printing. |
| :Show Compiled Code | Disassembles the selected executing function, with labels, hexadecimal byte offsets, bytes, and annotations. |
| :Set Breakpoint function PC | Installs a validated location in the function's current definition.  PC is required. |
| :Clear Breakpoint function [PC] | Removes that function/offset location.  PC defaults to byte 16. |
| :Clear All Breakpoints [function] | Removes all locations in the named function, or the selected frame's exact executing function when omitted. |
| :Show Breakpoints | Prints all installed function/offset locations. |
| :Show Instruction | Displays the instruction containing the selected saved caller location or interrupted program counter. |
| :Show Arglist | Prints the selected compiled function's stored lambda list, preserving selection and evaluation history.  Missing metadata reports unavailable. |
| :Show Argument [index or All] | Displays current source arguments.  All is the default.  An available indexed value becomes *, and + receives its checked location.  Show Frame displays the same source-parameter indices. |
| :Show Rest Argument | Displays the selected frame's current rest parameter and assigns only *.  Available NIL, absent rest, and unavailable storage have distinct displays. |
| :Use Dynamic Environment | Selects the debugger's global evaluation context. |
| :Use Lexical Environment | Selects the current frame's live lexical context. |
| :Show Standard Value Warnings | Prints corrections to invalid or unbound debugger reader/printer controls. |
| :Show Lexical Environment | Prints inherited lexical variable and local-function bindings, excluding the current source function's own locals.  Missing ancestry and unavailable values remain explicit. |
| :Show Special symbol | Prints the symbol's special binding in the selected Program frame or in the Debugger.  :Environment selects the context. |
| :Show Bindings | Prints the special bindings established by the selected frame.  :All includes all frames.  :Matching takes a case-sensitive symbol-name substring.  Bound NIL and unbound are distinct. |
| :Show Catch Blocks | Prints active catch tags and available destination functions and hexadecimal byte offsets.  :All includes all retained frames. |
| :Show Condition Handlers | Prints condition types, handler functions, and their active/inactive state at debugger entry.  :All includes all retained frames. |
| :Show Backtrace | Lists retained call frames. |
| :Find Frame string | Searches function names toward older callers.  :Reverse searches newer frames, and :Detailed adds locals and marked code. |
| :Set Current Frame index | Selects a frame by its zero-based decimal index and displays its available locals. |
| :Top Of Stack | Selects frame zero, the newest retained frame, and displays its available locals. |
| :Bottom Of Stack | Selects the oldest retained frame and displays its available locals. |
| :Next Frame | Moves toward older callers and displays the selected frame.  :Nframes takes a nonnegative decimal count, defaulting to one. |
| :Previous Frame | Moves toward newer callees and displays the selected frame.  :Nframes takes a nonnegative decimal count, defaulting to one. |
| :Show Frame | Displays the selected function, original supplied arguments, current source parameters, and available locals.  Missing metadata and unavailable values remain explicit. |
| :Show Local All | Displays recorded locals for the selected frame, preserving history.  All is the default. |
| :Show Local index | Displays one recorded local by its zero-based decimal index.  An available value becomes *, and + receives its checked location when declaration metadata is available. |
| :Return | Reads one expression supplying all return values, displays them, and asks for confirmation before returning from the selected frame. |
| :Show Proceed Options | Displays retained restart choices and marks the default CONTINUE.  Selecting a choice invokes its interactive function in the guest to obtain any arguments. |

Debugger operations run with application condition handlers disabled.  A handler established inside an evaluated expression still works.  Unhandled reader, evaluator, printer, and restart-function errors enter a child debugger.  Leaving the debugger restores the application's handlers for continuation and unwind cleanup.

Proceed without an available CONTINUE reports an error while leaving the computation stopped.  An explicit index selects another restart.  A restart can return values and leave the debugger active, or transfer control out of it.  The browser displays returning values.

:Arguments is a Boolean keyword.  Omitted, it defaults to No.  Mentioned without a value, it defaults to Yes.  :Arguments No uses the restart's interactive reader.  :Arguments Yes reads one expression, evaluates it in the stopped thread's current dynamic environment and a null lexical environment, and passes the elements of its primary value to the restart.  The value must be a finite proper list.  For example, entering (list 20 22) supplies two arguments, while NIL supplies none.  Reading disables read-time evaluation.  Aborting an unfinished read clears input already buffered on QUERY-IO while preserving the retained input record for replay.  Reader, evaluation, and argument errors enter a child debugger.  :Abort there abandons the command and returns to the original stop.

Selection starts at frame zero and persists across reconnects and image restoration.  Each nested debugger has its own selection.  A mentioned :Nframes requires a value.  Zero displays the current frame.  Movement beyond the retained stack reports an error and preserves selection.  Mouse selection and :Set Current Frame use the same guest operation.

Find Frame requires a nonempty, case-sensitive function-name substring.  It excludes the selected frame and does not wrap.  :Detailed, :Invisible, and :Reverse default to No when omitted and Yes when mentioned without a value.  A miss preserves selection.  :Invisible Yes reports unsupported before command acceptance.  Search preserves evaluation history.  A match selects before printing, so printer Abort preserves that selection.  The [frame-search reference](debugger.md#frame-search) defines associated names, output, and replay.

Show Function, Show Compiled Code, and Show Instruction take no arguments.  Show Function preserves the other eight expression/value history slots, including +.  Code display preserves all history and selection and retains an older active function version after redefinition.  Ordinary call locations use the saved return address minus one.  Interrupted locations use the exact saved PC.  Headers distinguish these locations and unavailable metadata.  The commands initially support the selected function and complete disassembly.  Genera's function/range arguments, octal PCs, More processing, output destinations, and + locative assignment remain unsupported.  The [function and instruction reference](debugger.md#functions-and-instructions) defines offsets, printer recovery, invalid-argument frames, and tested stopping states.

Use Dynamic Environment and Use Lexical Environment take no arguments and preserve frame selection and all nine history values.  Each outer stop starts in lexical mode.  A child inherits its parent's choice and can change it independently.  Control-X followed by I toggles the mode while either debugger editor has focus, preserving the draft and cursor.  A form displays the nesting arrows followed by `Eval (program): ` or `Eval (debugger): `.  Empty input and colon commands display the arrows.  Clearing or submitting the form restores the arrow prompt.  Both modes use the stop's reader/printer controls and the stopped thread's other debugger-time special bindings.  Dynamic mode permits evaluation when selected-frame scope metadata is unavailable.  The [evaluation-environment reference](debugger.md#evaluation-environments) gives the native operations and lifetime rules.

Reinvoke's :Original Args and :New Args Boolean keywords default to No when omitted and Yes when mentioned.  Both Yes is invalid.  Original Args is a Mezzano extension.  Current supplies optional/key values explicitly.  Original preserves omissions.  New Args evaluates one expression in the selected mode and uses its primary value, or NIL for zero values.  The [Frame Reinvoke reference](debugger.md#frame-reinvoke) specifies reconstruction, lifetime requirements, transfer behavior, and acceptance limits.

Show Standard Value Warnings takes no arguments or options and preserves selection and history.  Before each command, the debugger checks its saved `*PACKAGE*`, `*READ-BASE*`, `*PRINT-BASE*`, and `*READ-DEFAULT-FLOAT-FORMAT*`.  Invalid or unbound values receive defaults: COMMON-LISP-USER, 10, 10, and SINGLE-FLOAT.  The display distinguishes bound NIL from `[unbound]` and retains original and replacement values in correction order.  Valid values and debugger edits persist between commands, independently for each stop.  Command return or nonlocal exit restores the program's bindings.  More Processing and Output Destination options remain unsupported.  The [standard-value reference](debugger.md#standard-values) specifies validation, printer recovery, and restoration.

Show Lexical Environment takes no arguments or options and preserves selection and history.  It lists distinct shadowed ancestor bindings, with variable bindings before local-function bindings and inner bindings before outer ones in each namespace.  An empty known ancestry reports `This frame was not lexically called.`  Missing metadata reports `Lexical ancestry unavailable.`  Missing storage prints `[unavailable]` for that binding.  This includes unused outer values omitted by closure capture.  The [lexical-environment reference](debugger.md#lexical-environment) describes ownership, compiler policies, and printer recovery.

Show Special requires one symbol spelling.  It reads that spelling under the debugger's current package when the command executes.  Both omitted :Environment and a mentioned :Environment without a value select Program for the retained program frames.  :Environment Debugger selects this level's history variables and current debugger-command bindings.  Streams is recognized but reports an unsupported environment before command acceptance.  Command quoting preserves a spelling containing whitespace or beginning with a colon, for example `:Show Special "|name with spaces|"`.  Command words, keywords, and environment choices support completion.  Symbol-name discovery remains unavailable.  The [special-binding reference](debugger.md#special-bindings) specifies live cells, NIL/unbound/unavailable states, replay, and recovery.  The display preserves selection, evaluation mode, history, and program bindings.

Show Bindings supports established x86-64 condition-stop frames and preserves selection and evaluation history.  Its :All keyword defaults to No when omitted and Yes when mentioned without a value.  :Matching requires a string when mentioned, for example `:Show Bindings :All :Matching "*PACKAGE*"`.  The empty string matches every symbol name.  Repeated bindings appear from inner to outer, and bindings established by runtime functions appear under their runtime frames.  Unsupported frame layouts report unavailable binding locations.  Frame-visibility filtering remains unavailable.

Show Catch Blocks uses the same :All defaults as Show Bindings.  It lists active tags under their owning frames, preserving repeated tags from inner to outer.  Available destinations name the executing runtime %CATCH function and a hexadecimal byte offset from the function object's start.  %CATCH receives the transfer and returns the supplied values to its caller.  Missing control metadata preserves the tag and reports Destination unavailable.  The command preserves selection and evaluation history.  Unsupported frames report unavailable catch locations.

Show Condition Handlers uses the same :All defaults as Show Bindings.  It lists handlers established by the selected frame, or all retained frames with :All.  When SIGNAL invokes a handler, its cluster becomes inactive.  A break inside that handler reports this state and the still-active older clusters.  Mezzano's runtime %HANDLER-BIND frame may own the cluster.  The command preserves selection and evaluation history.  Unsupported frame layouts report unavailable handler locations.

Show Backtrace lists call frames.  Internal-frame and invisible-frame filtering and raw stack-slot inspection remain unavailable.  Show Frame, Show Backtrace, and the other navigation commands lack Detailed options.

## Guest and transport APIs

The package MEZZANO.COMMAND-PROCESSOR exports MAKE-LISTENER, LISTENER-INFORMATION, START-LISTENER, and ASSISTANCE.  Command definitions, parsing, argument validation, completion, execution, and presentation metadata live in [the guest implementation](../system/command-processor.lisp).

START-LISTENER uses the existing retained evaluation service.  Each Listener accepts one active ordinary submission.  A second ordinary submission reports :listener-busy.  Clear All accepts a control submission that terminates the earlier evaluation.  Other Listeners and ordinary evaluation jobs remain independent.  Accepted work survives disconnection and session release.  Repeating a creation name, source, and interactive setting in the same Listener returns the existing job, including after that job changed the package.  Conflicting content or another Listener reports :request-conflict.  Release and image-restore rules follow the [retained service](../tools/swank/README.md).

Listener state survives connection closure.  Session release or a new boot retires that session's Listener identity.  Retained jobs and stops remain discoverable through a new session.  Their prior Listener's package and defaults are not adopted by the new session.

| HTTP operation | Arguments and result |
|---|---|
| listener-information | No arguments.  Returns package, mode, prompt, busy-p, active-job, debugger, default-pathname, and a detailed herald sample. |
| start-listener | name, source, and optional interactive.  Returns an ordinary retained job token. |
| listener-assistance | source, cursor, action, optional context and presentation.  Returns input classification, replacement text and cursor, prompt, default, expected-type, help, candidates, complete-p, and error. |

Assistance actions are inspect, space, complete, help, parse, and insert.  Context is listener or debugger.  Insert requires a pathname presentation value.  Debugger parse replies include operation and argument fields, and where applicable display.  Frame selection plans carry a decimal index or movement count.  Current-frame inspection carries NIL.  Find Frame carries (string detailed-p invisible-p reverse-p).  Show Local uses operation local with NIL for All or a nonnegative index.  The Proceed plan uses a NIL argument for the default selection or an integer for an indexed selection.  :Arguments Yes chooses invoke-restart-with-arguments.  The [SWANK protocol reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) gives the Lisp argument spelling.

Job information adds :listener-result.  It is NIL for ordinary evaluation jobs.  A Listener result records :kind (:command or :form), optional :command, :effects, :presentations, and any command input :error.  An input error is printed and recorded.  Runtime conditions, including file and compiler errors, enter the retained debugger.

Herald presentations contain :type :herald, :start and :end character offsets, and :herald.  The offsets delimit the plain-text herald in job output.  The payload contains :title, :facts, :detailed-p, :systems, and :help.  Facts and help are lists of lines, each containing inline records with :kind (:text, :emphasis, or :key) and :text.  System records contain :name and :version, with NIL for an undeclared version.  Listener information returns the same payload in :herald.

The :DEBUGGER descriptor is NIL outside a stop.  Otherwise it identifies the innermost stop in this Listener's active job, its one-based :DEPTH, :PROMPT, :EVALUATION-ENVIRONMENT, and :EVALUATION-PROMPT.  SWANK encodes :STOP as a stop token.  Listener ownership and the descriptor are sampled under the guest service lock.  The browser uses this descriptor to select input context.
