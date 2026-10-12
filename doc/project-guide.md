# Project guide

This project develops a Lisp machine on Mezzano, with remote evaluation, retained debugging, and a Symbolics-style browser interface.  Development and tests run on minideb2 using x86-64 QEMU/KVM.  The original VM uses SWANK port 4005.  The development VM uses 4006, and its Web interface uses port 8765.

## Documentation map

| Subject | Documentation |
|---|---|
| Architecture, ownership, supported behavior, and remaining work | [Debugger design and implementation status](debugger.md) |
| Remote evaluation, interactive input, interruption, and debugger use | [Remote evaluation and debugging](../tools/swank/README.md) |
| Listener commands, completion, help, defaults, and pathname insertion | [Lisp Command Processor](command-processor.md) |
| Browser use, HTTP operations, reconnection, and release recovery | [Web Listener and Debugger](../tools/swank/web/README.md) |
| Sessions, tokens, RPCs, results, rejection reasons, and documentation operations | [Retained Mezzano debugger protocol](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) |
| Dependencies, source revisions, builds, services, snapshots, restore, and tests | [Mezzano on minideb2](../tools/swank/minideb2/README.md) |
| Documentation lookup, search, viewers, and bookmarks | [Document Examiner](document-examiner.md) |
| Original glyph identification and visual evidence | [Original Symbolics font research](../tools/swank/web/font-research/README.md) |
| Decisions, diagnoses, failed tests, and implementation history | [Development journal](../tools/swank/devnotes.md) and [Web UI development journal](../tools/swank/web/devnotes.md) |

## Runtime and compiler

Mezzano runs Lisp threads under its supervisor.  Retained evaluations each use a worker thread with private standard streams.  A stopped thread preserves its dynamic environment while other threads continue.  The heap remains shared.  Application locks held by a stopped thread can block other work.

The running compiler defaults to safety 3, debug 3, and speed 1.  Preserved lexical bindings have tested read and internal-write behavior, including captured bindings and full GC.  Bootstrap compilation uses debug 1.  The [compiler guarantees](debugger.md#compiler-guarantees) specify the supported binding cases and remaining scope/type requirements.

The existing implementation documents describe the [compiler frontend](internals/compiler-frontend.md), [compiler backend](internals/compiler-backend.md), [calling convention](internals/abi.md), [memory layout](internals/memory-layout.md), [instance representation](internals/instances.md), [supervisor restrictions](internals/supervisor-restrictions.md), and [filesystem](internals/file-system.md).  Their source dates and scope differ from the current debugger test evidence.

## Debugging and evaluation

The retained service supports explicit condition entry, nested printer stops, frame and local inspection, zero-argument restarts, batch and interactive evaluation, numbered interruption, and reconnection after lost replies.  Its APIs retain accepted work independently of a connection.  Saved-image tests cover specific stopped, queued, and running states.  [Stop and command lifetimes](debugger.md#stop-and-command-lifetimes) and the protocol reference specify identity, ownership, replay, and expiration.

Symbolics-level debugging remains the objective.  The [capability table](debugger.md#capability-and-evidence) records unfinished lexical evaluation, public binding mutation, original argument recovery, argument-taking restarts, arbitrary frame return and reinvocation, breakpoints, stepping, object browsing, and selected-frame dynamic context.  Existing low-level primitives establish only the cases described in that table.

## Operations and evidence

The host tools build images, start QEMU, retain serial output, and expose SWANK.  The Web server uses Python's standard library and native browser code.  Lisp owns debugger semantics, Listener parsing, and documentation lookup.  The operations guide lists the required dependencies and test commands.

A claim about tested behavior must identify its architecture and execution state.  Current evidence covers x86-64 QEMU/KVM.  ARM64 and bare-metal behavior require separate tests.  The journals preserve failed attempts and their corrections.  The [test catalog](debugger.md#test-scope-and-provenance) maps each test source to its purpose.

## Remaining system work

GUI-free startup, early startup failure handling, and QEMU host control remain unfinished.  The present VMs hide the host display while the guest initializes its desktop.  QMP/GDB control independent of guest networking remains part of the agenda.  Bare-metal FEP work is deferred.

Original-font conversion, glyph measurements in Chromium, and full-screen comparison determine the browser's visual fidelity.  The font report distinguishes recovered glyph evidence from rendered-browser evidence.  Functional browser tests alone establish neither font identity nor exact layout.
