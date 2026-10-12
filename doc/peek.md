# Peek process viewer

Peek displays Mezzano threads and their retained debugger stops.  The System Menu opens Peek.  F9 followed by P selects it from the keyboard.  The Listener command `Show Processes` prints the process list in the transcript.

## Display and commands

Peek starts in Help mode.  Processes displays one row for each enumerated thread.  Process names may repeat.  Clicking a name opens operations for that sampled row.

| Gesture | Operation |
|---|---|
| P or Processes | Displays process samples. |
| F12 or Help | Displays Peek help. |
| SPACE | Requests a new sample. |
| A number followed by Z | Sets the update interval in seconds, from 1 to 86400. |
| Q or Quit | Returns to the activity that selected Peek. |

The initial update interval is 20 seconds.  Automatic updates run while the Processes display and browser tab are visible.  Requests run sequentially.  A successful response replaces the displayed rows and records its receipt time.  An error preserves the previous rows, marks them stale, and reports the error.  Connect / Resume restores an interrupted connection.

Describe displays the row's sampled fields.  A Debugger entry selects an existing retained stop associated with that exact thread.  A thread may have several stops when a debugger operation enters another condition.  The stop can close or be released between sampling and selection.  The debugger reports its current state when selected.

## Reading a sample

| Field | Meaning |
|---|---|
| Process Name | Thread name, limited to 160 characters. |
| State | Scheduler state at sampling time. |
| Priority | Scheduler priority class. |
| Wait | Bounded description of the recorded wait object, when present. |
| Recorded runtime | Accumulated runtime charged by the scheduler, in seconds. |

State is a scheduler value.  It does not identify a Lisp condition or establish whether a thread has a debugger stop.  Retained stop associations provide that information separately.  Recorded runtime excludes a running thread's unfinished scheduling interval and does not represent a CPU-use percentage.

The sampler reads each thread under the scheduler lock.  Enumeration, individual samples, and retained-stop association occur at different times.  Threads can start, finish, sleep, or wake during the operation.  Duplicate names identify separate rows, and names do not serve as thread identities.

Wait descriptions use bounded built-in representations.  Unrecognized objects appear as `[object]`.  Shortened strings include `[truncated]`.  Describe does not invoke arbitrary object printers.  Peek provides observation and navigation to retained stops.  Thread arrest, reset, termination, and debugger interruption of arbitrary threads are unavailable.

## Selecting activities

F9 starts SELECT and displays `Select:` in the status line.  The following letter selects an activity: L for the Lisp Listener, D for Document Examiner, or P for Peek.  Existing input remains in its editor when another activity is selected.  F9 followed by F12 lists these bindings.  Backspace cancels SELECT.  Shift-F11 closes its help dialog.

F9 is the Web interface's SELECT mapping.  This mapping differs from the Genera X client's F1 binding.  The [Web interface guide](../tools/swank/web/README.md) describes connections, retained evaluations, and request recovery.  The [debugger guide](debugger.md) describes retained stops and the operations available after selecting one.
