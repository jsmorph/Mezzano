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

Evaluation jobs and the explicit debugger wrapper retain condition stops.  Numbered job interruption supports computing and input-waiting workers and executing debugger commands.  Local-variable mutation, lexical frame evaluation, arbitrary frame return or reinvocation, breakpoints, and integrated stepping remain planned for the remote API.  Local-variable availability depends on compiler debug metadata and the selected frame.  The [debugger guide](../../doc/debugger.md) describes those limits and the supported stopping states.

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

The evaluation cases run through both the full interpreter and compiled functions.  Environment queries also check symbol-macro shadowing.  Stopped-frame lexical evaluation remains a separate implementation task.

The local-macro fixture exercises enclosing macro and symbol-macro definitions, shadowing, assignment, and macro environment arguments through interpretation, compilation, and compiled-file loading:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-MACRO-ENVIRONMENTS.LISP"))
(lispm-macro-environment-test:run)
```

The parameter fixture compares interpreted and compiled results for special bindings, initializer order and declaration scope, optional and keyword parameters, supplied-p values, rest and auxiliary bindings, keyword precedence, multiple values, closure writes, and dynamic unwinding:

```lisp
(load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-EVALUATOR-PARAMETERS.LISP"))
(lispm-evaluator-parameters-test:run)
```

For snapshot coverage, call PREPARE-RESTORE-TEST in that package before saving and FINISH-RESTORE-TEST after restoration.  The test retains interpreted closures containing a local macro and a shared typed binding, then checks reads and writes after full GC.

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
