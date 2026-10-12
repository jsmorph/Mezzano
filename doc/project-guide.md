# Mezzano user guide

Mezzano runs Common Lisp as an operating system.  The Web interface provides a Listener for commands and Lisp forms, a debugger for retained stops, a process viewer, and a Document Examiner for these manuals.  SWANK clients can use the same evaluation and debugger services.

## Getting started

The [installation and operation guide](installation.md) covers source checkout, image building, QEMU startup, remote access, and snapshots.  The [Web guide](../tools/swank/web/README.md) covers server configuration and browser controls.  The [remote evaluation guide](../tools/swank/README.md) provides command-line examples.

At the Listener prompt, enter a Lisp form or a [Command Processor command](command-processor.md):

```text
Command: (+ 20 22)
Command: Set Package CL-USER
Command: Help :Format Detailed
```

Return submits input.  SPACE and Tab complete command names and arguments.  F12 requests help.  The System Menu selects Listener, Debugger, Evaluations, Peek, or Document Examiner.  F9 followed by L, D, or P selects Listener, Document Examiner, or Peek.

## Documentation

| Task | Reference |
|---|---|
| Build, boot, connect, and save the system | [Installation and operation](installation.md). |
| Use the browser interface | [Web Listener and Debugger](../tools/swank/web/README.md). |
| Enter commands and complete arguments | [Lisp Command Processor](command-processor.md). |
| View threads and their debugger stops | [Peek process viewer](peek.md). |
| Browse manuals and save reading lists | [Document Examiner](document-examiner.md). |
| Evaluate from a Lisp client | [Remote evaluation and debugging](../tools/swank/README.md). |
| Inspect stops, locals, restarts, and job state | [Debugger and evaluation reference](debugger.md). |
| Implement a retained SWANK client | [Retained debugger protocol](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md). |
| Use the native desktop | [Desktop reference](quickstart.md). |
| Parse and generate JSON | [JSON](json.md). |
| Use HTTPS and the Responses client | [HTTPS and OpenAI requests](https.md). |
| Configure guest networking | [Networking](manual.md). |
| Use atomic operations and extended structures | [Atomic extensions](atomic-extensions.md) and [structure extensions](defstruct-extensions.md). |

## Evaluation and debugging

A retained evaluation runs in a guest worker thread.  Its output, values, and debugger stops remain available after a client disconnects.  Interactive evaluations accept input and EOF.  An interrupt requests a debugger stop in that worker.  A stop preserves the running computation while a client inspects frames, local values, and restart choices or invokes a zero-argument restart.

Local inspection depends on the compiler's debug policy and available location metadata.  The [compiler guarantees](debugger.md#compiler-guarantees) describe those requirements.  The [retained evaluation reference](debugger.md#retained-evaluation) defines job identity, input, output, interruption, and release.  Restoring an image begins a new boot and expires prior client references.  A client can discover surviving jobs and stops through a new session.

## Threads

Mezzano schedules threads in a shared Lisp heap.  The following expression returns their names:

```lisp
(mapcar #'mezzano.supervisor:thread-name
        (mezzano.supervisor:all-threads))
```

ALL-THREADS walks the live thread list without the scheduler's global lock.  Threads can start or finish during that walk.  Retained evaluation jobs and debugger stops identify their associated threads through the debugger service.
