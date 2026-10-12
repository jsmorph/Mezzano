# Peek development

## Processes query: 2026-10-12

The user approved a read-only Processes view, Lisp Show Processes command, and SELECT navigation.  The recommendation uses a guest Lisp query for thread observations and the existing retained debugger handles for navigation.  The browser displays the returned fields.  The HTTP server forwards the typed request.

The existing [Peek application](../../applications/peek.lisp) prints thread names, scheduler states, and sleeping wait objects.  [Scheduler code](../../supervisor/thread.lisp) exports the relevant accessors, but ALL-THREADS traverses the live list without locking.  Its SAMPLE-THREAD-STATE function establishes the required interrupt and global-lock discipline.  The new sampler will copy five field references or values under that lock, with no allocation or printing.  Record construction and bounded text conversion will follow outside the lock.  Each row will describe one scheduler observation.  Enumeration and retained-stop association occur separately.

THREAD-RUN-TIME updates the active interval only for the calling thread.  The Processes query will expose the recorded accumulator with INTERNAL-TIME-UNITS-PER-SECOND.  Another active thread's unfinished interval remains absent.  Wait items can survive a wakeup, so the query will describe them only for states that represent waiting.  State and retained debugger stops remain separate fields: a retained stop normally sleeps on its command event.

Name and wait text will accept bounded primitive data and known supervisor wait structures.  Arbitrary object printers will never run.  Thread names can coincide, so stop association will compare thread objects with EQ under the debugger service mutex.  The adapter will reuse stop tokens.  It will create no thread handles or persistent thread registry.

The API will return a title, run-time units per second, and rows containing name, state, priority, wait kind, wait text, recorded run time, and associated stops.  Show Processes will format the same guest query.  The [supervisor restrictions](../../doc/internals/supervisor-restrictions.md) govern its scheduler sampler.  The [remote API](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) will specify response fields and observation limits.

Required tests:

- [x] Duplicate names and exact thread-to-stop associations, including nested stops.
- [x] Event/mutex waits and stale wait items after wakeup.
- [x] Hostile printers, primitive names, bounded text, and Unicode.
- [x] Thread creation and exit during repeated queries.
- [x] Runtime units and counter growth after yielding.
- [x] SWANK serialization, Show Processes help/completion/output, and repeated queries without thread-handle retention.
- [ ] Fresh build and boot, coordinated with the main development task.

## Review findings

The existing stop encoder called DEBUGGER-STOP-INFORMATION for its numeric ID.  That query recursively copied the raw thread name, so a circular list name could exhaust the stack during Processes or debugger selection.  The recommendation moves the bounded primitive label formatter into the debugger service and uses it for the stop's thread display as well as Processes labels.  This fixes both queries without changing general result copying or adding an ID-only API.  The same formatter applies to evaluation-job thread metadata, which previously returned the raw name.  Tests must encode and inspect a retained stop and serialize a job whose names are circular.

A targeted supervisor hotload must pass `:wired T` to LOAD, matching the cold build.  The callback executes with interrupts disabled and requires resident code and constants.  Source review of the multiple-value save path found fixed wired-stack slots for the sampler's five values.

Show Processes formats the captured stop's immutable descriptive ID without another live-handle lookup.  A captured summary therefore remains printable after release.  SWANK encoding still validates handles: a direct guest release between association and encoding returns `:released-stop`.  Adapter requests serialize and cannot cause that race with each other.  The test checks released-handle rejection and token equality across stop discovery and repeated Processes requests.

The guest fixture uses the existing SYS:SOURCE logical pathname translation.  Raw SWANK RPC forms require CL-qualified operators because SWANK reads them in a package with no Common Lisp inheritance.

## Evidence

Host SBCL checks passed for circular primitive labels and the 160/161-character boundary.  Guest compilation of the new supervisor sampler succeeded.  The initial hotload omitted `:wired T`, violating the callback's resident-code requirement.  Source review identified the error after the failed session.  The retry script includes the required LOAD argument.  During compilation of the shared label formatter and revised stop-information function, the guest panicked in GC with `Insufficient space for garbage collection!`.  The serial log identifies GC-INSUFFICIENT-SPACE with the world stopped and a compile worker waiting in %GC/SLOW-CONS.  No Processes fixture had run.  A later sampler query timed out while the guest remained stopped.  The main development task preserved the panic log and disk, recovered the development VM from its saved image with the same memory allocation, and investigated store accounting separately.

The corrected targeted hotload passed on the recovered x86-64 QEMU guest.  Compilation completed for the wired sampler, common label formatter, stop/job metadata, Processes module, Command Processor, and SWANK adapter.  The live query returned 27 rows.

`sbcl --script tools/swank/test-processes.lisp 4006` exited 0.  It compiled and ran the guest fixture, then checked SWANK serialization, shared stop tokens across discovery and Processes, token equality through 15 refreshes, unchanged session handle-table size, cyclic job-name serialization, command assistance, and Show Processes output.  Guest assertions covered duplicate names, nested stops, event/mutex waits, stale waits after wakeup, hostile printers, circular names, the 160/161-character boundary, Unicode, recorded runtime growth, 30 transient thread creations/exits, captured-summary printing after release, and rejection of released stops.  The fixture released its workers, stops, job, controller, and session.

These results cover the hotloaded x86-64 implementation.  Cold-build/CI boot and ARM64 execution remain untested for this increment.  The main development task will run the cold-build/CI check after the concurrent source changes settle.
