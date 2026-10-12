# Remote evaluation and debugging

The host tools run on SBCL with its bundled socket library.  `lispm-eval` evaluates source through ordinary SWANK requests.  `debugger-client.lisp` controls guest-owned debugger stops and evaluation jobs.

The [debugger design](../../doc/debugger.md) defines current capabilities and limitations.  The [protocol reference](https://github.com/jsmorph/slime/blob/debugging/contrib/swank-mezzano-debugger.md) specifies RPCs and errors.  [Build and VM operations](minideb2/README.md) provides dependency revisions, startup, snapshots, and test commands.

## Web Listener

The [Web Listener and Debugger](web/README.md) serves a browser interface on [minideb2 port 8765](http://minideb2:8765/).  Its Python standard-library server translates HTTP requests to the existing SWANK retained-service API on port 4006.  The browser retains its session identity across reloads.  The guest owns evaluations, output, stops, and command results.

The interface supports the [Lisp Command Processor](../../doc/command-processor.md), source evaluation, interactive input, interruption, condition and backtrace inspection, local values, and zero-argument restarts.  The component guide records launch commands, tests, original Symbolics references, and remaining visual work.  The guest compiler and debugger remain implemented in Lisp.  The [Document Examiner](../../doc/document-examiner.md) presents the project documentation through guest Lisp topic lookup and search.

## Evaluate source

From the Mezzano repository root on `minideb2`:

```sh
tools/swank/lispm-eval --port 4006 '(+ 20 22)'
printf '%s\n' '(format t "hello~%")' '(values 42 :done)' |
  tools/swank/lispm-eval --port 4006
```

The client accepts one source argument or reads standard input when the argument is absent or `-`.  It prints program output followed by each value returned by the last form.  Definitions persist across connections.  Saving them across VM restarts requires a Mezzano snapshot.

Defaults are host `127.0.0.1`, port `4005`, package `CL-USER`, and a 60-second timeout.  The development VM uses port `4006`.  Options are `--host`, `--port`, `--package`, and `--timeout`.  Exit status is 0 for success, 1 for a guest condition, 2 for a client/transport error, and 124 for timeout.

A guest condition enters SLDB.  This client reports it and requests the evaluation's abort restart.  A client timeout closes the connection, and the remote computation may continue.  Standard input within this evaluation is an empty stream.

The tested deployment forwards SWANK to host loopback.  From another machine:

```sh
printf '%s\n' '(+ 20 22)' |
  tailscale ssh minideb2 /home/somebody/src/mezzano-boot/Mezzano/tools/swank/lispm-eval --port 4006
```

## Retain an evaluation across connections

The batch job API owns its worker, supplied input, output, and results in the guest.  Conditions enter the retained debugger.  Input receives EOF after the supplied string.

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
   :port 4006)
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
   :port 4006))
```

Keep the generated name if the creation reply can be lost.  Repeating the same name, source, package, and input in the same boot returns the existing job.  `:jobs` discovers unreleased jobs through any attached session.  `:job-information` returns active stop tokens in `:stops`, which use the inspection and restart operations below.  Job state remains `:running` while a condition is stopped.

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

After an unread reply, query the retained ID or repeat that ID in the same boot.  Reading a new `:next-interrupt-id` and submitting it creates a different request.  A pending or running request rejects a second request.  Delivery waits while footholds are inhibited.  A job already in a retained stop records cancellation with `:already-stopped`.

## Debug a background computation

This example starts a compiled function with two arguments, stops at a continuable error, inspects its locals, disconnects, reconnects, and invokes the continuation.  Its assertions check application values and cleanup.

### Start the guest computation

Run from the Mezzano checkout on `minideb2`:

```sh
tools/swank/lispm-eval --port 4006 <<'LISP'
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
 :port 4006 :seconds 30)
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
 :port 4006 :seconds 30)
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

Evaluation jobs and the explicit debugger wrapper retain condition stops.  Numbered job interruption supports computing and input-waiting workers.  Interruption of running debugger commands, public binding mutation, lexical frame evaluation, arbitrary frame return/reinvocation, breakpoints, and integrated stepping also remain pending.

The [capability and test tables](../../doc/debugger.md#capability-and-evidence) state the evidence for each operation.  The [operations guide](minideb2/README.md#tests) gives the test commands and restore sequence.  The [development journal](devnotes.md) records diagnoses and historical runs.
