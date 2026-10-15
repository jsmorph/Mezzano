# Remote evaluation and debugging

The command-line client evaluates Common Lisp source over SWANK.  The retained debugger client controls evaluation jobs and debugger stops that remain in the guest across connection loss.  Both clients run on SBCL and use its bundled socket library.

The [debugger guide](../../doc/debugger.md) describes supported operations and their limits.  The [API reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) specifies RPCs and errors.  [Installation and operation](../../doc/installation.md) covers the guest image, networking, startup, and snapshots.

## Connection setup

The guest must be running SWANK.  Retained operations require the `swank-mezzano-debugger` contrib, which the retained client loads when it connects.  The clients use IPv4 TCP and expect a SWANK endpoint without a shared-secret handshake.  The retained client also requires the host's `/dev/urandom` to generate session and job names.

Examples run from the Mezzano checkout and use `127.0.0.1:4005`.  This can be the guest's forwarded port or a local SSH tunnel.  `--host` and `--port` select another endpoint for the command-line client.  The Lisp client takes corresponding `:host` and `:port` arguments.

For a VM host exposing SWANK on its loopback port 4005, this SSH command opens a local forwarding port:

```sh
ssh -N -L 4005:127.0.0.1:4005 user@vm-host
```

`user@vm-host` identifies the account and machine running the VM.  SWANK evaluates arbitrary Lisp with the guest's authority.  Access to its endpoint grants that authority.

## Browser interface

The [Web Listener and Debugger](web/README.md) provides the [Lisp Command Processor](../../doc/command-processor.md), source evaluation, interactive input, interruption, backtraces, local values, and restart invocation with interactive or explicit arguments.  Its Python server serves the interface and forwards HTTP requests to the guest's SWANK API.  The guest owns evaluations, output, stops, and command results.  The browser retains its session identity across reloads.

The [Document Examiner](../../doc/document-examiner.md) displays the documentation through guest Lisp topic lookup and search.

## Evaluate source

From the Mezzano checkout:

```sh
sbcl --script tools/swank/lispm-eval --port 4005 '(+ 20 22)'
printf '%s\n' '(format t "hello~%")' '(values 42 :done)' |
  sbcl --script tools/swank/lispm-eval --port 4005
```

The client accepts one source argument or reads standard input when the argument is absent or `-`.  It prints program output followed by each value returned by the last form.  Definitions persist across connections.  Saving them across VM restarts requires a Mezzano snapshot.

Defaults are host `127.0.0.1`, port `4005`, package `CL-USER`, and a 60-second timeout.  Options are `--host`, `--port`, `--package`, and `--timeout`.  Exit status is 0 for success, 1 for a guest condition, 2 for a client/transport error, and 124 for timeout.

A guest condition enters SLDB.  This client reports it and requests the evaluation's abort restart.  A client timeout closes the connection, and the remote computation may continue.  Standard input within this evaluation is an empty stream.

## Retain an evaluation across connections

A retained evaluation owns its worker, input, output, and results in the guest.  Source forms run in order, starting in the package selected by `:package` (default `"CL-USER"`) with a fresh standard readtable.  Package changes apply to later forms in the same job.  Conditions enter the retained debugger.  Batch input receives EOF after the supplied string.

Run this in host SBCL from the Mezzano checkout.  It creates a job, closes the connection, reconnects, and prints `Computed.`, `42`, and `:DONE` before releasing the job and session:

```lisp
(load "tools/swank/debugger-client.lisp")

(let ((session (lispm-debugger-client:make-session))
      (name (lispm-debugger-client:fresh-name))
      (job nil))
  (lispm-debugger-client:call-with-session
   session
   (lambda ()
     (setf job
           (lispm-debugger-client:request
            :start-evaluation name
            "(format t \"Computed.~%\") (values (+ 2 (read)) :done)"
            :input "40")))
   :port 4005)
  (lispm-debugger-client:call-with-session
   session
   (lambda ()
     (let ((info
             (loop for info = (lispm-debugger-client:request :job-information job)
                   unless (eq (getf info :state) :running) return info
                   do (sleep 0.01))))
       (assert (eq (getf info :state) :returned))
       (assert (equal (getf info :values) '("42" ":DONE")))
       (write-string
        (getf (lispm-debugger-client:request :job-output job 0) :text))
       (dolist (value (getf info :values)) (format t "~A~%" value))
       (lispm-debugger-client:request :release-job job)
       (lispm-debugger-client:request :release-session)))
   :port 4005))
```

Keep the generated name if the creation reply can be lost.  Repeating the same name, source, package, input, and input mode in the same boot returns the existing job.  `:jobs` discovers unreleased jobs through any attached session.  `:job-information` returns active stop tokens in `:stops`, which use the inspection and restart operations below.  Job state remains `:running` while a condition is stopped.

Output reads use character offsets and preserve storage.  `:job-output` returns `:text` and `:end`, so the next read can start at that end offset.  Any attached session can read jobs and release terminal jobs.  Releasing a session leaves its jobs intact.  Output and results consume guest memory until job release.

### Interactive input

Create a job with `:interactive T` to keep input open after its initial text is consumed.  A read then waits for more input or explicit EOF.  Job information reports `:input-length`, `:input-eof-p`, and `:input-waiting-p`.  Connection loss leaves the read pending.

Within a `call-with-session` callback, this call supplies a line and EOF to an interactive job whose input length was zero:

```lisp
(lispm-debugger-client:request :job-input job 0 (format nil "hello~%") :eof t)
```

The call returns the ending character offset.  An identical retained range succeeds without appending text again.  A gap, mismatched text, or partial overlap reports `:input-conflict`.  New input starts at the length reported by job information.  EOF can accompany new text or an empty submission at the end.  After an image restore, a fresh session obtains the restored job token and input length before continuing.

### Interrupt an evaluation

Within a `call-with-session` callback, submit the next interrupt ID and retain it if the reply can be lost:

```lisp
(let ((id (getf (lispm-debugger-client:request :job-information job)
                :next-interrupt-id)))
  (lispm-debugger-client:request :interrupt-job job id)
  (lispm-debugger-client:request :job-interrupt-result job id))
```

The result records `:pending`, `:running`, `:returned`, `:unwound`, `:cancelled`, or `:expired`.  Polling job information reveals the retained stop in `:stops`.  The inspection and restart operations below apply to that stop.  CONTINUE resumes computation.  ABORT unwinds through application cleanup.  Cleanup may signal a condition or redirect control, so job information determines the final evaluation outcome.

After an unread reply, query the retained ID or repeat that ID in the same boot.  Reading a new `:next-interrupt-id` and submitting it creates a different request.  A pending request rejects a second request.  A running interruption permits a nested request while its debugger executes a command.  Job information's `:interruptible-p` reports availability.  Delivery waits while footholds are inhibited and validates the target's state again.  A debugger waiting for a command records cancellation with `:already-stopped`.  Interrupting an executing debugger command enters a child stop.  CONTINUE resumes the command, and the child ABORT abandons it while preserving the original stop.

## Debug a background computation

This example starts a compiled function with two arguments, stops at a continuable error, inspects its locals, reconnects, and invokes the continuation.  The function returns two values and runs its unwind cleanup once.

### Start the guest computation

Run from the Mezzano checkout:

```sh
sbcl --script tools/swank/lispm-eval --port 4005 <<'LISP'
(defpackage #:lispm-debug-demo (:use #:cl))
(in-package #:lispm-debug-demo)
(defparameter *cleanup-count* 0)

(defun work (a b)
  (declare (optimize (debug 3) (safety 3)))
  (unwind-protect
       (progn
         (cerror "Resume the example." "Documentation stop.")
         (values (+ a b) :done))
    (incf *cleanup-count*)))

(defparameter *thread*
  (mezzano.supervisor:make-thread
   (lambda ()
     (mezzano.debug:call-with-debugger-service
      (lambda () (work 111 222))))
   :name "Documentation debugger example"))
(values)
LISP
```

The worker enters the retained service inside its own thread.  The evaluation that creates it returns while the worker remains stopped.  The condition, application activation, and restart remain in the guest.

### Inspect the stop

Start host SBCL in the same directory and evaluate:

```lisp
(load "tools/swank/debugger-client.lisp")
(defpackage #:lispm-debugger-example
  (:use #:cl #:lispm-debugger-client))
(in-package #:lispm-debugger-example)

(defparameter *session* (make-session))
(defvar *stop*)
(defvar *frame*)

(defun completed-command (stop id)
  (loop for result = (request :result stop id)
        unless (member (getf result :state) '(:pending :running))
          return result
        do (sleep 0.01)))

(defun inspect-command (stop lease operation &optional argument)
  (let ((id (getf (request :information stop) :next-command-id)))
    (request :submit lease id operation argument)
    (let ((result (completed-command stop id)))
      (assert (eq (getf result :state) :returned) () "~S" result)
      (getf result :result))))
```

The helpers poll within `call-with-session`'s deadline.  The first connection finds the named stop, attaches a controller, selects the application frame, and prints the condition and locals:

```lisp
(call-with-session
 *session*
 (lambda ()
   (setf *stop*
         (loop for stop =
                 (find "Documentation debugger example" (request :stops)
                       :key (lambda (stop)
                              (getf (request :information stop) :thread))
                       :test #'equal)
               when stop return stop
               do (sleep 0.01)))
   (let* ((lease (request :attach *stop*))
          (frames (inspect-command *stop* lease :frames))
          (entry (find-if
                  (lambda (entry)
                    (search "LISPM-DEBUG-DEMO::WORK" (getf entry :function)))
                  frames)))
     (assert entry)
     (setf *frame* (getf entry :frame))
     (format t "~A~%" (inspect-command *stop* lease :condition))
     (format t "~S~%" (inspect-command *stop* lease :locals *frame*))))
 :port 4005 :seconds 30)
```

The local list includes available values `"111"` and `"222"`.  Names and values are printed strings.  The function's debug declaration preserves the source bindings used by this example.

Returning from `call-with-session` closes the connection.  The guest retains the stop.  The host retains its session name and tokens.

### Reconnect and continue

```lisp
(call-with-session
 *session*
 (lambda ()
   (let* ((lease (request :attach *stop*))
          (restarts (inspect-command *stop* lease :restarts))
          (restart (find "CONTINUE" restarts
                         :key (lambda (entry) (getf entry :name))
                         :test #'equal))
          (id (getf (request :information *stop*) :next-command-id)))
     (assert restart)
     (request :submit lease id :invoke-restart (getf restart :index))
     (assert (eq (getf (completed-command *stop* id) :state) :unwound))
     (assert
      (equal
       (call-rpc
        "(swank:eval-and-grab-output
           \"(list (mezzano.supervisor:thread-join lispm-debug-demo::*thread*)
                   lispm-debug-demo::*cleanup-count*)\")")
       '("" "((333 :DONE) 1)")))
     (request :release-stop lease)
     (request :release-session)
     (format t "Returned 333 and :DONE.  Cleanup ran once.~%")))
 :port 4005 :seconds 30)
```

The second call resumes the session and acquires a new lease.  The restart transfers control out of the debugger, producing command state `:unwound`.  The separate thread join establishes application completion and checks `333`, `:DONE`, and one cleanup.  The client then releases the closed stop and session.

## Client use and recovery

`call-with-session` takes a session and a callback, with `:host`, `:port`, and `:seconds` defaulting to `"127.0.0.1"`, 4005, and 60.  Its deadline covers connecting and running the callback.  The client loads the contrib when connecting.  It supports one outstanding RPC per connection.

Within the callback, `request` sends one synchronous debugger RPC.  `send-request` returns a SWANK RPC ID, and `receive-reply` receives that reply.  This transport ID differs from the per-stop command ID accepted by `:submit`.

`session-name` returns the name needed to resume from another host Lisp process.  `(make-session :resume saved-name)` resumes an existing session.  Preserve the associated tokens and command IDs if recovery needs them.  A new session uses 256 bits from host `/dev/urandom`.

| Situation | Recovery |
|---|---|
| Connection lost with a stopped computation | Resume the same session, reacquire the lease, and query stop information. |
| Submission reply lost | Query the original command ID.  Within the same boot, identical resubmission under a valid lease recognizes the recorded command. |
| `:session-attached` | The client retries until its deadline while the previous close hook releases the session. |
| `:already-controlled` | Another controller owns the stop.  Inspection of metadata and recorded results remains available. |
| `:stop-busy` | Query the active command and the stop's `:child` field.  A child stop needs its own control lease and recovery. |
| `:expired-session` after restore | Create a fresh session and discover restored stops.  Historical command results identify their acceptance boot. |
| Expired frame/control error | Obtain current stop information and fresh control/frame references appropriate to that stop. |
| Unexpected SWANK debugger entry | The host client reports the error and requests SWANK's top-level abort.  Retained stops remain discoverable through another connection. |

Commands that print values execute application printers and can block or enter a child stop.  A client timeout closes its connection while an accepted command can continue in the guest.  Query the recorded outcome before deciding what to submit next.

Evaluation jobs and the explicit debugger wrapper retain condition stops.  Numbered job interruption supports computing and input-waiting workers and executing debugger commands.  Selected-frame evaluation reads and writes available lexical bindings.  Arbitrary frame return or reinvocation, breakpoints, and integrated stepping remain planned for the remote API.  Local-variable availability depends on compiler debug metadata and the selected frame.  The [debugger guide](../../doc/debugger.md) describes those limits and the supported stopping states.

## Kernel source loading

Runtime and supervisor functions called before paging starts or with interrupts disabled require resident code and constants.  The cold builder loads its supervisor source set with wired allocation.  A runtime hotload uses the same allocation and the bootstrap optimization policy:

```lisp
(let ((mezzano.compiler::*optimize-policy* '(safety 3 debug 1 speed 1)))
  (multiple-value-bind (file warnings failure)
      (compile-file "SYS:SOURCE;RUNTIME;RUNTIME.LISP")
    (assert (and file (not warnings) (not failure)))
    (load file :wired t)))
```

Callees invoked in those states also require resident implementations.  Loading boot-required functions into pageable memory can fault before the pager and console initialize.  Snapshot acceptance includes restarting the saved image.

## Early panic tests

The early-console panic fixture must compile and load wired before installation:

```lisp
(let ((mezzano.compiler::*optimize-policy* '(safety 3 debug 1 speed 1)))
  (multiple-value-bind (file warnings failure)
      (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-EARLY-PANIC.LISP")
    (assert (and file (not warnings) (not failure)))
    (load file :wired t)))
(lispm-early-panic-test:install)
(mezzano.supervisor:snapshot)
(mezzano.supervisor:wait-for-snapshot-completion)
```

After the save completes, copy the private disk image for a separate QEMU instance.  Before restarting the normal VM, uninstall the fixture and save its normal state:

```lisp
(lispm-early-panic-test:uninstall)
(mezzano.supervisor:snapshot)
(mezzano.supervisor:wait-for-snapshot-completion)
```

The copied image deliberately halts during early-console initialization, before threads and paging initialize.  Its serial output must contain one panic report with "Owned early-console panic test."  The halt must reach the terminal panic stop without recursive APIC accesses or fatal page faults.  Saved pageable thread data can produce truncated diagnostic entries at this stage.  The normal saved image must boot, initialize both CPUs and its current-boot framebuffer, accept SWANK evaluation, and retain the debugger's tested behavior.  The fixture captures the original resident console function as a load-time constant because test symbols created in a running image can reside in pageable memory.  Acceptance covers x86-64 QEMU.  The shared video-reset ordering change has no ARM64 execution result.

## Debugger frame tests

Compile and load the fixtures in Mezzano:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE.LISP"))
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-FRAMES.LISP"))
(lispm-service-test::run-frame-tests)
```

The service fixture runs its existing tests when loaded.  The frame fixture checks selection, movement boundaries, parser completion, command replay, controller replacement, local values after full GC, child-debugger independence, Abort, and cleanup.  For a live structure-redefinition test, call PREPARE-FRAME-TEST before loading the changed debugger service, then call RUN-FRAME-TESTS.  A failed test retains its fixture for inspection.

The local-value fixture checks NIL and keyword values in compiled arguments, copied bindings, constants, captured bindings, and register records.  It also checks missing storage and errors in accessible closure paths:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-AVAILABILITY.LISP"))
(lispm-local-availability-test:run)
```

The local-function fixture checks FLET, recursive LABELS, function/variable namespaces, shadowed function bindings, SETF names, closure metadata, collection, and debug policies:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-LOCAL-FUNCTIONS.LISP"))
(lispm-local-function-test:run)
```

After loading the service fixture, call (lispm-local-function-test:prepare-restore-test) before saving.  After restoration, call (lispm-local-function-test:finish-restore-test).  The fixture checks a stopped frame's separate function and variable bindings after full GC, then continuation and cleanup.  Running RUN again after restoration exercises the saved compiler definitions.

The binding-lifetime fixture inspects an argument-free compiled function inside and after two separate LET scopes.  Direct non-inline calls identify each inspection point.  The test repeats the sequence with full GC while each frame remains active:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-SCOPES.LISP"))
(lispm-debug-scope-test:run)
```

Run it again after image restoration to test the saved compiler.

To include selected-frame persistence in a snapshot test, load the restoration fixture and prepare its stopped thread before saving:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-SERVICE-RESTORE.LISP"))
(lispm-service-test::prepare-restore-test)
```

After restoration, call (lispm-service-test::finish-restore-test).  It requires expired old handles, the same selected frame and local values after full GC, restart completion, and one cleanup, then releases the stop.

## Evaluator environment tests

The compiled fixture checks type declarations in compiler and interpreter environments, binding identity, shadowing, special-variable proclamations, inline declarations, and typed closure writes:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-EVALUATOR-ENVIRONMENT.LISP"))
(lispm-environment-test:run)
```

The evaluation cases run through both the full interpreter and compiled functions.  Environment queries also check symbol-macro shadowing.  The [frame-evaluation fixture](#frame-evaluation-tests) tests the selected-frame environment.

The local-macro fixture exercises enclosing macro and symbol-macro definitions, shadowing, assignment, docstrings, &WHOLE, and &ENVIRONMENT through interpretation, compilation, and compiled-file loading.  It also checks retained macro lambda forms and defining environments, copying, and the identity and state of the original expander:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-MACRO-ENVIRONMENTS.LISP"))
(lispm-macro-environment-test:run)
```

The function-constant fixture saves compiled, lazy, and interpreted functions in a native compiled file.  It checks shared function identity, retained compiled state, interpreted evaluation behavior, nested macro environments, shared lexical cells, source metadata, and full GC:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-FUNCTION-CONSTANTS.LISP"))
(lispm-function-constant-test:run)
```

Its stateful assertions require a fresh compiled-file load before each RUN.  Lazy functions save their resolved target.  Interpreted functions retain an interpreter entry and their saved lexical environment.  Recursive function/environment graphs and cross-target loading have not been tested.

The compilation-error fixture checks that evaluation propagates the original compiler condition, expands a failing macro once, and permits retry of the same lazy function after an error or nonlocal exit.  It also checks recursive forcing and rejection of serialization during compilation:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-EVAL-COMPILATION.LISP"))
(lispm-eval-compilation-test:run)
```

The parameter fixture compares interpreted and compiled results for special bindings, initializer order and declaration scope, optional and keyword parameters, supplied-p values, rest and auxiliary bindings, keyword precedence, multiple values, closure writes, and dynamic unwinding:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-EVALUATOR-PARAMETERS.LISP"))
(lispm-evaluator-parameters-test:run)
```

For snapshot coverage, call PREPARE-RESTORE-TEST in that package before saving and FINISH-RESTORE-TEST after restoration.  The test retains interpreted closures containing a local macro and a shared typed binding, then checks reads and writes after full GC.

## Compiler lexical-environment tests

The AST fixture checks source environments after first-pass expansion and tree copying.  It checks binding identity, shadowing, variable/function namespaces, local macro and symbol-macro definitions, declarations, block/tag references, and preservation of the original tree's environments.  It then compiles and executes the original and copied trees:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-AST-ENVIRONMENTS.LISP"))
(lispm-ast-environment-test:run)
```

Each variable or local-function read has its own AST reference and source environment.  References to the same binding share its binding object.  A known null environment differs from an unknown environment.  The fixture checks distinct occurrence scopes and copied binding identities, then tests execution with DEBUG 0/3, COMPILATION-SPEED 1/3, SAFETY 3, SPEED 1, and type checking enabled.  Cases include constant assignment, closure writes, multiple values, dynamic-extent rest arguments, and nonlocal GO and RETURN-FROM through a non-inlined helper.  Propagation tests check the replaced occurrence's scope while retaining a copied lambda body's definition scope.  Source-marker tests cover AST optimization and lowering, closure binding identity, and separate inlined function scope.  Complete compiler scope coverage remains work.  The frame-evaluation fixture below tests runtime use of the emitted scopes.

For snapshot coverage, call PREPARE-RESTORE-TEST in that package before saving and FINISH-RESTORE-TEST after restoration.  The test retains the first-pass tree, then checks its environments, macro functions, binding identities, copying, and compiled execution after full GC.

After loading the AST fixture, the backend fixture tests source environments during instruction insertion and movement, class changes, branch rewriting, control-flow edge splitting, lowering, and register allocation.  It compares selected call scopes with their AST sources and executes the compiled functions under DEBUG 0/3 and COMPILATION-SPEED 1/3:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-BACKEND-ENVIRONMENTS.LISP"))
(lispm-backend-environment-test:run)
```

The backend package also provides PREPARE-RESTORE-TEST and FINISH-RESTORE-TEST.  They retain a converted backend function and its source environments, then lower, allocate registers, compile, and execute it after restoration and full GC.

The binding-identity fixture checks distinct same-name bindings, shared closure cells, function names, copying, inlining, location changes, and full GC.  Compile and load it in Mezzano so its closure tests also check compiled-file sharing:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-BINDING-IDENTITIES.LISP"))
(lispm-binding-identity-test:run)
```

Its PREPARE-RESTORE-TEST retains three closures and a binding descriptor.  FINISH-RESTORE-TEST checks their shared and shadowed identities and mutations after restoration and full GC.

The allocator lifetime fixture checks inclusive endpoints, expired values, register reuse, a gap followed by a preserved spilled value, missing ranges, and shared layout records:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-ALLOCATION.LISP"))
(lispm-debug-allocation-test:run)
```

It executes in Mezzano and inspects the allocator's location records.  The code-display fixture also tests the bootstrap DEBUG 1 invalid-argument helper's captured FUNCTION value.

Compiled locations and closure layouts retain a descriptor for each binding.  Distinct bindings can have the same display name.  Copied bindings receive new descriptors, while closures sharing a binding retain the same descriptor.  Existing debug records remain readable with absent descriptor identity.  The public local-variable API retains its existing names, locations, and values.

The instruction-scope fixture tests the assembler's address table and runtime lookup:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-SCOPE-TABLE.LISP"))
(lispm-debug-scope-table-test:run)
```

It checks address boundaries, repeated and distinct scope objects, multiple records at one address, alignment, compiled-file sharing, full GC, and older debug records.  NIL denotes a known empty scope; :UNKNOWN denotes unavailable scope information.  Both assembler targets emit the fixture's byte sequence.  The tests inspect its metadata without executing that byte sequence.

The source-scope fixture converts compiler environments to records containing visible bindings and declarations:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-SOURCE-SCOPES.LISP"))
(lispm-debug-source-scope-test:run)
```

It checks shadowing, variable and function namespaces, declared types, special declarations, symbol macros, original macro identity and state, block/tagbody identities, compiled-file sharing, full GC, and backend environments under DEBUG 0/3 and COMPILATION-SPEED 1/3.  Reload the compiled fixture before each RUN because its macro counter checks the saved initial state.

The target-macro fixture checks shared definition constants, target compilation through the file writer, fresh target state, retained native expander state, nested defining environments, failure and retry, compiled-file loading, and full GC:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUG-MACRO-TARGETS.LISP"))
(lispm-debug-macro-target-test:run)
```

Reload its compiled file before each RUN.  It selects both architectures but executes x86-64 functions.  Host cross-build acceptance remains untested.

The emitted-scope fixture resolves compiled source scopes from live call addresses and matches visible binding descriptors to local storage:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-EMITTED-SCOPES.LISP"))
(lispm-emitted-scope-test:run)
```

It checks nested and disjoint same-name bindings, variable/function namespaces, symbol macros and local macros, scope exits, mutation, compiled-file loading, full GC, and both emitters.  Execution uses x86-64 with DEBUG 0/3 and COMPILATION-SPEED 1/3, SAFETY 3, and SPEED 1.  Value checks use DEBUG 3.  Prologue instructions retain unavailable scope information.  ARM64 execution remains untested.

## Frame evaluation tests

The frame-evaluation fixture tests the retained service against compiled stopped functions:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-FRAME-EVALUATION.LISP"))
(lispm-frame-evaluation-test:run)
```

Load the debugger-service fixture first for its test helpers.  The test checks selected binding identity, live and shared-cell writes, namespaces and macros, declarations and storage types, expression/value histories, source replay, nested Abort, full GC, continuation, unavailable scope/storage, and expired or foreign-thread access.  It also checks the guest form-input plan.  Runtime cases use x86-64 with DEBUG 3, SAFETY 3, and SPEED 1, plus a DEBUG 0 unavailable-binding case.  The unavailable-scope check clears only the source-scope field of its owned DEBUG 0 function after the storage check, representing legacy metadata.  The [frame-evaluation reference](../../doc/debugger.md#frame-evaluation) describes the operation and its limits.

For a saved-stop test, call `(lispm-frame-evaluation-test:prepare-restore-test)` before saving the image and `(lispm-frame-evaluation-test:finish-restore-test)` after restoration.  This checks preserved selection, value history, and changed bindings, expired old stop/frame references and frame-backed closures, fresh evaluation after full GC, Proceed, and shared compiled closures.  The fixture releases its stop and retained test objects.

The description fixture checks propagation of the original printer condition from an object or slot value, ordinary bound/unbound slot output, stream designators, and zero return values:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DESCRIBE.LISP"))
(lispm-describe-test:run)
```

The argument-list fixture uses the debugger-service and frame-evaluation helpers:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-ARGLIST.LISP"))
(lispm-arglist-test:run)
```

It checks parameter syntax, empty and unavailable metadata, active function redefinition, full GC, unchanged history and selection, command replay, parser completion, continuation, and cleanup.  The fixture uses native x86-64 compiled condition stops at DEBUG 3, SAFETY 3, SPEED 1.

The function and code-display fixtures require the debugger-service, frame-evaluation, control-record, and catch-display fixtures first:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-CODE-DISPLAY.LISP"))
(lispm-code-display-test:run)
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-LARGE-CODE-DISPLAY.LISP"))
(lispm-large-code-display-test:run)
```

The first fixture checks Show Function's isolated * assignment, every branch-label definition, actual call bytes and instruction boundaries, active redefinition, replay, rejected arguments, unchanged selection, generic-associated functions, missing lexical scope, invalid-argument helper identity and bindings, unknown decoding in unexecuted owned code, printer child Abort and repair, moving constants, continuation, cleanup, and release.  Its missing-scope case clears and restores the scope table of its owned TARGET function, checking expression rejection and unchanged function/code/instruction output.  The large fixture checks complete disassembly above 64 KiB through its final instruction, unchanged history, multiple values, and continuation effects.  The generic-function cases exercise first and cached calls with full GC.  The existing frameless fixture checks an interrupted instruction's exact saved PC.  Tests execute native x86-64 code at DEBUG 3, SAFETY 3, SPEED 1.  Service compilation uses DEBUG 1 with SAFETY 3 and SPEED 1.

The generic-frame fixture uses the same service, frame-evaluation, and catch-display helpers:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-GENERIC-FRAMES.LISP"))
(lispm-generic-frame-test:run)
```

It checks initial, specialized, and six-argument fallback single-dispatch activations, reader slot-unbound entry, writer type errors, cached calls, active global redefinition, full GC, associated generic and executing-code identities, function history, selection, continuation, typed Abort, and release.  CLOS discriminator constructors preserve their bindings at DEBUG 3 even under the bootstrap DEBUG 1 compilation policy.  Recompiling a constructor changes future closures.  A clean rebuild tests the policy throughout the image.

The invalid-argument binding case requires current binding, location, and source metadata.  Tests cover the bootstrap DEBUG 1 helper and DEBUG 3 compilation.  Recompiling an older helper or rebuilding the image replaces its earlier records.  Loading all of system/error.lisp reinitializes debugger-hook globals, so isolated helper recompilation uses its canonical definition and restores its source pathname and top-level-form index.  The [function and instruction reference](../../doc/debugger.md#functions-and-instructions) states the supported behavior and remaining compatibility work.

The dynamic-binding fixture uses the same helpers:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DYNAMIC-BINDINGS.LISP"))
(lispm-dynamic-bindings-test:run)
```

It checks per-frame ownership, shadowed values, bound NIL and unbound cells, selected/all-frame output, case-sensitive name filtering, parser defaults, invalid options, copied request strings, replay, unchanged history and selection, printer failure with nested Abort, full GC, continuation, and cleanup.  Its compiled condition-stop scope is x86-64 at DEBUG 3, SAFETY 3, SPEED 1.  See [special bindings](../../doc/debugger.md#special-bindings).

The handler-scope fixture uses the debugger-service and frame-evaluation helpers:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-HANDLERS.LISP"))
(lispm-debugger-handlers-test:run)
```

It verifies that application handlers cannot intercept errors from debugger evaluation, printers, or normally returning restart functions.  Handlers installed by evaluated forms remain active.  Nested BREAK, child Abort, continuation, and unwind cleanup test restoration of the original handlers.  These native x86-64 tests use DEBUG 3, SAFETY 3, SPEED 1 and release their owned jobs and stops.

The control-record fixture observes internal catch and handler records through the existing frame-binding reader:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-CONTROL-RECORDS.LISP"))
(lispm-control-records-test:run)
```

It checks nested and repeated catch tags, exit functions, handler-cluster identity and frame ownership, an ordinary BREAK, a BREAK within a selected handler, full GC, multiple-value THROW, unwind cleanup, continuation after the inner catch, and release of owned jobs and stops.  It uses the same test helpers and native x86-64 DEBUG 3 policy.  It also tests Show Condition Handlers defaults and completion, selected/all-frame output, active/inactive state, invalid options, replay, unchanged history and selection, and a valid callable-instance handler whose printer raises a condition.  Printer Abort, accepted replay, repaired display, and restored handler invocation must pass.

The catch-display fixture uses the debugger-service, frame-evaluation, and control-record helpers:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-CATCH-DISPLAY.LISP"))
(lispm-catch-display-test:run)
```

It checks selected/all-frame output, defaults and completion, repeated tags, destination function and byte offset, legacy unavailable metadata, rejected malformed options, accepted replay, unchanged history and selection, moving GC, tag-printer failure with child Abort, repaired display, multiple-value THROW, cleanup, and release.  The fixtures use x86-64 condition stops at DEBUG 3, SAFETY 3, SPEED 1, plus a DEBUG 0 legacy-layout target.  Two captured blocks with the same internal name must resolve to distinct destinations by binding identity, with different continuation effects.  The frameless interruption fixture checks unavailable catch locations in the interrupted activation.

The captured-control metadata fixture checks compiled-file loading, closure/source identity sharing, nested same-name blocks and tagbodies, variable-layout compatibility, DEBUG 0/1/3, nonlocal multiple values, destination function and offset through moving GC, and redefinition of the active function:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-CONTROL-METADATA.LISP"))
(lispm-control-metadata-test:run)
```

The fixture executes x86-64 code at SAFETY 3 and SPEED 1.  Captured-variable availability checks use DEBUG 3.  DEBUG 1 tests control identities while allowing optimized variable values.  ARM64 execution and control-destination lookup remain untested or unavailable as described in the [compiler reference](../../doc/debugger.md#compiler-guarantees).

The parked-control fixture tests live catch destinations across image restoration.  It uses the debugger-service, frame-evaluation, and control-record helpers:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-CONTROL-CONTEXT-RESTORE.LISP"))
(lispm-control-context-restore-test:prepare-restore-test)
```

Preparation also retains Show Function's * assignment, selection, and completed code/instruction strings.  After saving and restarting the image, `(lispm-control-context-restore-test:finish-restore-test)` checks expired old handles, prior-boot command results and replay rejection, preserved function history, fresh code/instruction output and catch destinations before and after GC, multiple-value THROW to the inner repeated-tag catch, cleanup, continuation, and release.  These tests cover an x86-64 parked condition stop.

## Inspection reference tests

The reference fixture tests the internal object-retention layer.  Load the debugger-service and frame-evaluation fixtures first:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-INSPECTION-REFERENCES.LISP"))
(lispm-inspection-reference-test:run)
```

It checks EQ identity, cycles, shared objects, NIL, kind and owning-thread validation, foreign stops, full GC, Clear, monotonically increasing IDs, continuation, and release.  It requires the native x86-64 debugger service.  This fixture does not exercise component enumeration, mutation, or public inspector commands.

For saved-state acceptance, call `(lispm-inspection-reference-test:prepare-restore-test)` before saving and `(lispm-inspection-reference-test:finish-restore-test)` after restoration.  The test rejects old references, obtains fresh references with the preserved object IDs, checks retained sharing and cycles after full GC, continues the stopped computation, and releases its state.

## Inspector tests

Load the debugger-service and frame-evaluation fixtures, then compile and run the Inspector fixture:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-INSPECTOR.LISP"))
(lispm-inspector-test:run)
```

The native x86-64 test checks cons, array, symbol, hash-table, CLOS, and structure components, fixed-vector elements, unbound versus NIL, shared identity after full GC, page bounds, shrinking arrays, removed keys, changed classes, read-only fields, and rejected types.  Retained-command tests check selected-frame modification, reader and printer history bindings, duplicate input and command submission, nested type and reader errors, input cleanup after reader Abort, a completed store followed by printer failure, Clear, continuation, and owned cleanup.

For a parked-stop restoration test, call `(lispm-inspector-test:prepare-restore-test)` before saving and `(lispm-inspector-test:finish-restore-test)` after restoration.  It checks historical pages, expired references, prior-command rejection, fresh inspection, full GC, modification through retained input, continuation, and cleanup.

## CLOS method replacement tests

The compiled fixture checks calls overlapping method replacement, method and specializer references, notification order, reader/writer and ordinary dispatch, old discriminators, changes in cache representation, cache publication, lock identity after GC, and error unwinding:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-METHOD-REPLACEMENT.LISP"))
(lispm-method-replacement-test:run)
```

The overlap tests arrange a cache miss during a removal notification and a replacement during cache construction.  They require the competing thread to wait on the generic function's mutex.  A separate running method waits for another thread to replace it, testing that dispatch releases the lookup mutex before invocation.  Recursive lookup tests replace a method from applicability, effective-function construction, and long-form method-combination callbacks, initialize the replacement cache through a recursive call, and require subsequent calls to use the replacement.  Run the fixture again after image restoration to test the saved implementation.

## Snapshot tests

Run the following forms in Mezzano with the source tree available as `SYS:SOURCE;`.  The synchronization fixture inspects kernel queues with interrupts disabled, so its compiled code requires `:WIRED T`.

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-SNAPSHOT-SYNC.LISP")
      :wired t)
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-PAGE-RESERVATIONS.LISP"))
(lispm-snapshot-sync-test:prepare)
(lispm-page-reservation-test:run :snapshot t)
```

The reservation test checks transient mappings and runs three full collections with a concurrent statistics reader.  Its :COLLECTIONS argument changes that count.  With :SNAPSHOT T, it forces the snapshot worker to use its retry timer after collection, and samples reservations concurrently with the save.  Wait for the evaluation to return before restarting the image.  After restoration:

```lisp
(assert (mezzano.supervisor:event-state
         mezzano.supervisor::*snapshot-state*))
(lispm-snapshot-sync-test:finish)
(lispm-page-reservation-test:run)
```

The synchronization test checks notification, timer expiration, mutex reacquisition, and cleanup of its own waiters.  The reservation test requires a writable hosted image.  [Backing-store reservations](../../doc/internals/memory-layout.md#backing-store-reservations) defines the counted states.

To test a restart argument reader across restoration, compile the control fixture and prepare its waiting evaluation before saving:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DEBUGGER-CONTROL.LISP"))
(lispm-debugger-control-test:prepare-argument-restore)
(lispm-page-reservation-test:run :snapshot t)
```

After the saved image restarts, call `(lispm-debugger-control-test:finish-argument-restore)`.  It verifies expired control, rejected prior-boot replay, the preserved input wait, completion after full GC, and one argument evaluation, restart invocation, and cleanup.  Successful completion releases its job and stop.

The x86-64 copy-on-write test compiles into wired memory and uses a private page to check protection transitions.  Its save test pauses snapshot writeback, runs a minor collection, and changes an 8192-element vector after capture:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-SNAPSHOT-COW.LISP")
      :wired t)
(lispm-snapshot-cow-test:run)
(lispm-snapshot-cow-test:save-with-collection)
```

Wait for the save call to return, then restart that image and call (lispm-snapshot-cow-test:finish-restore).  The restored test invocation removes its writeback hook without repeating the collection or mutation.  FINISH-RESTORE checks that all 8192 values retain their pre-save value, 1111.  The live values after the completed save are 2222.
