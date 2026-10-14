# Lisp Command Processor

The Web Listener accepts Command Processor commands and Lisp forms through a guest Lisp module.  Each retained SWANK session owns a Listener with a package, pathname default, and current job.  The guest parses commands, supplies completion and help, executes commands, and records output presentations.  The browser renders that information and keeps its input and output histories.  Python transports typed HTTP requests through SWANK.

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
| Clear All | Terminates retained evaluations across Listeners, releases their output and closed debugger records, and clears this tab's evaluation histories. |
| Clear Output History | Clears the tab's prior displayed transcript while preserving input history and retained jobs. |
| Show Directory | Lists guest files matching a pathname.  An omitted argument uses a wildcard in the default directory.  A directory pathname acquires wildcard name and type components. |
| Show File | Displays a guest text file and records its pathname as the default. |
| Load File | Calls guest LOAD and records its pathname as the default. |
| Compile File | Calls guest COMPILE-FILE and records the source pathname as the default.  :Load Yes loads the result.  :Load defaults to No when omitted and Yes when mentioned without a value.  :Binary File takes an output pathname. |

File arguments use Mezzano Common Lisp pathname syntax.  Relative names merge with the Listener's pathname default.  Double quotes delimit an argument containing spaces, commas, quotes, or a leading colon.  Logical pathnames obey Common Lisp logical namestring character restrictions.  Physical REMOTE pathnames accept Unicode filenames.

These commands implement the listed arguments and keywords.  Unsupported or duplicate keywords produce an input error.  Compile File supports Yes and No for :Load.  Genera's Ask choice, multiple-file arguments, output redirection, and other command keywords are unsupported.

Show Processes uses `mezzano.debug:process-summary`, the same guest query as Peek's Processes view.  It reports live observations assembled from per-thread scheduler samples.  Run time counts recorded processor time in the displayed units.  An active scheduling interval enters that counter when the thread switches out.  Scheduler state and retained debugger stops are separate: a thread waiting at a retained stop usually has scheduler state Sleeping.  Idle threads are absent from the supervisor's live-thread list.

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

A stopped Listener uses its guest-reported innermost debugger stop and nesting prompt.  Debugger commands require a leading colon.  Lisp parses the command and selects the retained operation.  The guest retains the current frame independently for each stop, and the browser renders that selection and its inspection result.  It preserves ordinary Listener input and each debugger level's draft and cursor across entry, exit, and reload.  Input without a leading colon evaluates one Lisp form in the selected frame.  Lexical assignment takes effect immediately.  Each stop retains its own expression and value histories.  Reader, evaluation, and printing errors enter a child debugger, where :Abort abandons the evaluation and returns to its parent.  The [frame-evaluation reference](debugger.md#frame-evaluation) describes binding availability and lifetime limits.

| Command | Supported behavior |
|---|---|
| :Abort | Invokes the innermost CL:ABORT restart captured by this stop.  At a child caused by a debugger command, its command abort returns to the parent debugger. |
| :Help | Lists the implemented guest debugger commands and descriptions. |
| :Proceed | Invokes the first captured CL:CONTINUE restart interactively.  Omitting the argument selects Default. |
| :Proceed Default | Uses the same default selection as :Proceed. |
| :Proceed index | Invokes the captured restart at that zero-based decimal index interactively. |
| :Proceed index :Arguments | Prompts for a Lisp expression returning the argument list, then invokes that restart.  An omitted index selects Default. |
| :Inspect | Inspects the primary value from this debugger level's evaluation history. |
| :Describe Last | Describes that value without changing the history. |
| :Clear Inspector | Releases this stop's retained Inspector object and place references. |
| :Show Backtrace | Lists retained call frames. |
| :Set Current Frame index | Selects a frame by its zero-based decimal index and displays its available locals. |
| :Top Of Stack | Selects frame zero, the newest retained frame, and displays its available locals. |
| :Bottom Of Stack | Selects the oldest retained frame and displays its available locals. |
| :Next Frame | Moves toward older callers and displays the selected frame.  :Nframes takes a nonnegative decimal count, defaulting to one. |
| :Previous Frame | Moves toward newer callees and displays the selected frame.  :Nframes takes a nonnegative decimal count, defaulting to one. |
| :Show Frame | Displays the selected function and available locals.  Original argument values remain unavailable. |
| :Show Local All | Displays all available local records for the selected frame.  All is the default. |
| :Show Local index | Displays one local by its zero-based decimal index. |
| :Show Proceed Options | Displays retained restart choices and marks the default CONTINUE.  Selecting a choice invokes its interactive function in the guest to obtain any arguments. |

Proceed without an available CONTINUE reports an error while leaving the computation stopped.  An explicit index selects another restart.  A restart can return values and leave the debugger active, or transfer control out of it.  The browser displays returning values.

:Arguments is a Boolean keyword.  Omitted, it defaults to No.  Mentioned without a value, it defaults to Yes.  :Arguments No uses the restart's interactive reader.  :Arguments Yes reads one expression, evaluates it in the stopped thread's current dynamic environment and a null lexical environment, and passes the elements of its primary value to the restart.  The value must be a finite proper list.  For example, entering (list 20 22) supplies two arguments, while NIL supplies none.  Reading disables read-time evaluation.  Aborting an unfinished read clears input already buffered on QUERY-IO while preserving the retained input record for replay.  Reader, evaluation, and argument errors enter a child debugger.  :Abort there abandons the command and returns to the original stop.

Selection starts at frame zero and persists across reconnects and image restoration.  Each nested debugger has its own selection.  A mentioned :Nframes requires a value.  Zero displays the current frame.  Movement beyond the retained stack reports an error and preserves selection.  Mouse selection and :Set Current Frame use the same guest operation.

Show Backtrace lists call frames.  Find Frame, internal/invisible-frame filtering, detailed argument/disassembly options, and raw stack-slot inspection remain unavailable through these commands.

## Guest and transport APIs

The package MEZZANO.COMMAND-PROCESSOR exports MAKE-LISTENER, LISTENER-INFORMATION, START-LISTENER, and ASSISTANCE.  Command definitions, parsing, argument validation, completion, execution, and presentation metadata live in [the guest implementation](../system/command-processor.lisp).

START-LISTENER uses the existing retained evaluation service.  Each Listener accepts one active ordinary submission.  A second ordinary submission reports :listener-busy.  Clear All accepts a control submission that terminates the earlier evaluation.  Other Listeners and ordinary evaluation jobs remain independent.  Accepted work survives disconnection and session release.  Repeating a creation name, source, and interactive setting in the same Listener returns the existing job, including after that job changed the package.  Conflicting content or another Listener reports :request-conflict.  Release and image-restore rules follow the [retained service](../tools/swank/README.md).

Listener state survives connection closure.  Session release or a new boot retires that session's Listener identity.  Retained jobs and stops remain discoverable through a new session.  Their prior Listener's package and defaults are not adopted by the new session.

| HTTP operation | Arguments and result |
|---|---|
| listener-information | No arguments.  Returns package, mode, prompt, busy-p, active-job, debugger, default-pathname, and a detailed herald sample. |
| start-listener | name, source, and optional interactive.  Returns an ordinary retained job token. |
| listener-assistance | source, cursor, action, optional context and presentation.  Returns input classification, replacement text and cursor, prompt, default, expected-type, help, candidates, complete-p, and error. |

Assistance actions are inspect, space, complete, help, parse, and insert.  Context is listener or debugger.  Insert requires a pathname presentation value.  Debugger parse replies include operation and argument fields, and where applicable display or local-index.  Frame selection plans carry a decimal index or movement count.  Current-frame inspection carries NIL, with an optional local-index identifying the displayed local.  The Proceed plan uses a NIL argument for the default selection or an integer for an indexed selection.  :Arguments Yes chooses invoke-restart-with-arguments.  The [SWANK protocol reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) gives the Lisp argument spelling.

Job information adds :listener-result.  It is NIL for ordinary evaluation jobs.  A Listener result records :kind (:command or :form), optional :command, :effects, :presentations, and any command input :error.  An input error is printed and recorded.  Runtime conditions, including file and compiler errors, enter the retained debugger.

Herald presentations contain :type :herald, :start and :end character offsets, and :herald.  The offsets delimit the plain-text herald in job output.  The payload contains :title, :facts, :detailed-p, :systems, and :help.  Facts and help are lists of lines, each containing inline records with :kind (:text, :emphasis, or :key) and :text.  System records contain :name and :version, with NIL for an undeclared version.  Listener information returns the same payload in :herald.

The :DEBUGGER descriptor is NIL outside a stop.  Otherwise it identifies the innermost stop in this Listener's active job, its one-based :DEPTH, and :PROMPT.  SWANK encodes :STOP as a stop token.  Listener ownership and the descriptor are sampled under the guest service lock.  The browser uses this descriptor to select input context.
