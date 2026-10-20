# Foothold binding prototype

This x86-64 prototype retains previous and active foothold states on the [special stack](../../../doc/internals/abi.md#the-special-stack).  Its helpers restore the counter and allow flag for their dynamic bindings during unwinding and continuation transfers.  The optional macro and mutex modules replace shared foothold management and mutex transitions in the disposable guest.

Loading these files replaces the unwinder and three resident continuation functions.  The prototype requires a disposable guest.

| Test group | Cases | Behavior |
|---|---:|---|
| Restoration interleavings | 10 | Return/termination cleanup at five mask-restoration boundaries |
| Continuation state and values | 50 | Different masks/allow flags, zero/one/five/eight values, nested prompts, identities and moving GC |
| Returning queued callbacks | 8 | Four suspension/resumption cases, with and without collection in the callback |
| Callback exits | 16 | THROW/ABORT, mask zero/one, suspension/resumption, and collection before exit |
| Prompt return | 52 | Ordinary/resumed return, mask zero/one, value identities, collection, THROW, and ABORT |
| Captured-state restore | 2 | One/two prompts, pending callback, moving GC, value identities, and restored masks |

Compile and load the resident definitions before the ordinary test modules:

```lisp
(dolist (name '("KERNEL" "UNWINDER" "NATIVE"))
  (load (compile-file
         (format nil "SYS:SOURCE;TOOLS;SWANK;FOOTHOLD-PROTOTYPE;~A.LISP" name)
         :parallel nil)
        :wired t))
(dolist (name '("INTERLEAVINGS" "CONTINUATIONS" "DELIVERY" "PROMPT-RETURN" "SAVED"))
  (load (compile-file
         (format nil "SYS:SOURCE;TOOLS;SWANK;FOOTHOLD-PROTOTYPE;~A.LISP" name)
         :parallel nil)))
(lispm-foothold-binding-test:run)
(lispm-foothold-binding-test::check-values)
(lispm-foothold-binding-test::check-delivery)
(lispm-foothold-binding-test::check-delivery-with-gc)
(lispm-foothold-binding-test::check-delivery-exits)
(lispm-foothold-binding-test::check-prompt-return)
```

Prepare the captured-state tests, then save the guest:

```lisp
(lispm-foothold-binding-test::prepare-saved-bindings)
(mezzano.supervisor:snapshot)
(mezzano.supervisor:wait-for-snapshot-completion)
```

After restarting that saved image, run `(lispm-foothold-binding-test::check-saved-bindings)`.  The check requires two live captured continuations and two still-pending callbacks before releasing the workers.

The resident modules use DEBUG 1/SAFETY 3/SPEED 1.  The test modules use DEBUG 3/SAFETY 3/SPEED 1.  The value tests join their workers and record elapsed time for forced collection.  Run the group through a retained evaluation with an overall deadline.

The source includes thread-qualified test gates and collection hooks.  Production macro and mutex integration, a cold rebuild, and debugger acceptance tests remain required work.  The accepted Web guest has none of these prototype definitions.  The [development journal](../devnotes.md#continuation-aware-foothold-binding-revision) records its evidence and limitations.

## Macro and mutex integration tests

After loading the binding prototype, compile and load `MACROS` with default allocation, then `MUTEX` with `:WIRED T`.  Compile and load `MUTEX-TESTS` and `COMPILER-REPLY` with default allocation.  Run `(lispm-mutex-binding-test:run)`.

The release and compiler-worker tests also require the resident definitions in `diagnose-mutex-termination-kernel.lisp` and the ordinary definitions in `diagnose-mutex-termination.lisp`.  Run the latter package's `RUN` with `:EXPECT-STRANDED NIL` for each `:CLEANUP-ENTRY` value, `:RETURN` and `:TERMINATE`, clearing its owned `*STATE*` between calls.  Run `(lispm-mutex-binding-test::compiler-worker-reply)` to test the unchanged worker against the corrected reply-lock release.
