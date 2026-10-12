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
| Show Herald | Displays the guest implementation and version.  :Detailed Yes adds machine and software information.  An omitted :Detailed means No.  Mentioning it without a value means Yes. |
| Show Command Processor Status | Displays mode, prompt, package, and pathname default. |
| Show Processes | Displays thread names, scheduler states, priorities, wait reasons, recorded run time, and retained debugger stop IDs. |
| Clear Output History | Clears the tab's prior displayed transcript while preserving input history and retained jobs. |
| Show Directory | Lists guest files matching a pathname.  An omitted argument uses a wildcard in the default directory.  A directory pathname acquires wildcard name and type components. |
| Show File | Displays a guest text file and records its pathname as the default. |
| Load File | Calls guest LOAD and records its pathname as the default. |
| Compile File | Calls guest COMPILE-FILE and records the source pathname as the default.  :Load Yes loads the result.  :Load defaults to No when omitted and Yes when mentioned without a value.  :Binary File takes an output pathname. |

File arguments use Mezzano Common Lisp pathname syntax.  Relative names merge with the Listener's pathname default.  Double quotes delimit an argument containing spaces, commas, quotes, or a leading colon.  Logical pathnames obey Common Lisp logical namestring character restrictions.  Physical REMOTE pathnames accept Unicode filenames.

These commands implement the listed arguments and keywords.  Unsupported or duplicate keywords produce an input error.  Compile File supports Yes and No for :Load.  Genera's Ask choice, multiple-file arguments, output redirection, and other command keywords are unsupported.

Show Processes uses `mezzano.debug:process-summary`, the same guest query as Peek's Processes view.  It reports live observations assembled from per-thread scheduler samples.  Run time counts recorded processor time in the displayed units.  An active scheduling interval enters that counter when the thread switches out.  Scheduler state and retained debugger stops are separate: a thread waiting at a retained stop usually has scheduler state Sleeping.  Idle threads are absent from the supervisor's live-thread list.

### Completion, help, and history

SPACE completes the current command or keyword word.  Tab requests COMPLETE for the whole name.  At an empty argument, another SPACE accepts the displayed default.  HELP lists the current commands, choices, or remaining keywords.  The browser provides F12 and Control-? for HELP.  RETURN parses and submits the input.  Shift-RETURN inserts a newline.

Lisp returns replacement text and cursor positions.  The browser applies a response only while its input and cursor match the request.  Offsets count Unicode characters.  The browser converts those offsets to its editor's UTF-16 indices.  A pathname presentation carries character offsets in retained output and its guest namestring.  Job information returns presentations in output order.  Clicking it while a pathname argument is expected asks Lisp to insert and quote that value.

Accepted input history records original submitted text by job name.  Recalling input fills the editor.  Submitting it creates a new job name.  Replaying an uncertain request retains its original name.  Clear Output History records its prior displayed job names before submission, then applies the returned effect once for that owned job.  Reload and replay preserve that boundary, including output accepted after the clearing command.  Effects are applied after the command reaches a terminal state.

The current editor displays the argument prompt and contextual help above the command line.  Genera interleaves argument prompts with editable fields.  Full field editing, grouped command menus, pathname filename completion, general object presentations, and the remaining Command Processor modes are unsupported.

### Debugger commands

The debugger input requires a leading colon.  Lisp parses its command and returns an action using the retained debugger operations.  The browser resolves the selected frame token and renders the result.

| Command | Supported behavior |
|---|---|
| :Show Backtrace | Lists retained call frames. |
| :Set Current Frame index | Selects a frame by its zero-based decimal index and displays its available locals. |
| :Show Frame | Displays the selected function and available locals.  Original argument values remain unavailable. |
| :Show Local All | Displays all available local records for the selected frame.  All is the default. |
| :Show Local index | Displays one local by its zero-based decimal index. |
| :Show Proceed Options | Displays retained restart choices.  The browser can invoke zero-argument restarts. |

Show Backtrace lists call frames.  Raw stack-slot inspection is unavailable through the retained API.

## Guest and transport APIs

The package MEZZANO.COMMAND-PROCESSOR exports MAKE-LISTENER, LISTENER-INFORMATION, START-LISTENER, and ASSISTANCE.  Command definitions, parsing, argument validation, completion, execution, and presentation metadata live in [the guest implementation](../system/command-processor.lisp).

START-LISTENER uses the existing retained evaluation service.  Each Listener accepts one active submission.  A second new submission reports :listener-busy.  Other Listeners and ordinary evaluation jobs remain independent.  Accepted work survives disconnection and session release.  Repeating a creation name, source, and interactive setting in the same Listener returns the existing job, including after that job changed the package.  Conflicting content or another Listener reports :request-conflict.  Release and image-restore rules follow the [retained service](../tools/swank/README.md).

Listener state survives connection closure.  Session release or a new boot retires that session's Listener identity.  Retained jobs and stops remain discoverable through a new session.  Their prior Listener's package and defaults are not adopted by the new session.

| HTTP operation | Arguments and result |
|---|---|
| listener-information | No arguments.  Returns package, mode, prompt, busy-p, and default-pathname. |
| start-listener | name, source, and optional interactive.  Returns an ordinary retained job token. |
| listener-assistance | source, cursor, action, optional context and presentation.  Returns input classification, replacement text and cursor, prompt, default, expected-type, help, candidates, complete-p, and error. |

Assistance actions are inspect, space, complete, help, parse, and insert.  Context is listener or debugger.  Insert requires a pathname presentation value.  Debugger parse replies include operation and display fields, and where applicable needs-frame, local-index, or select-frame.  The [SWANK protocol reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) gives the Lisp argument spelling.

Job information adds :listener-result.  It is NIL for ordinary evaluation jobs.  A Listener result records :kind (:command or :form), optional :command, :effects, :presentations, and any command input :error.  An input error is printed and recorded.  Runtime conditions, including file and compiler errors, enter the retained debugger.
