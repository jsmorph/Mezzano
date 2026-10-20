# Foothold binding prototype

This x86-64 prototype retains previous and active foothold states on the [special stack](../../../doc/internals/abi.md#the-special-stack).  Its helpers restore the counter and allow flag for their dynamic bindings during unwinding and continuation transfers.  The shared foothold macros still restore thread slots in ordinary cleanup functions.

Loading these files replaces the unwinder and two resident continuation functions.  The prototype requires a disposable guest.  Its recorded native tests passed ten forced restoration interleavings, four queued-delivery cases with and without collection inside the callback, and 50 continuation cases covering different masks and allow flags, zero/one/five/eight values, nested prompts, object identity, and moving GC during switch preparation.

Compile and load the resident definitions before the ordinary test modules:

```lisp
(dolist (name '("KERNEL" "UNWINDER" "NATIVE"))
  (load (compile-file
         (format nil "SYS:SOURCE;TOOLS;SWANK;FOOTHOLD-PROTOTYPE;~A.LISP" name)
         :parallel nil)
        :wired t))
(dolist (name '("INTERLEAVINGS" "CONTINUATIONS" "DELIVERY"))
  (load (compile-file
         (format nil "SYS:SOURCE;TOOLS;SWANK;FOOTHOLD-PROTOTYPE;~A.LISP" name)
         :parallel nil)))
(lispm-foothold-binding-test:run)
(lispm-foothold-binding-test::check-values)
(lispm-foothold-binding-test::check-delivery)
(lispm-foothold-binding-test::check-delivery-with-gc)
```

The resident modules use DEBUG 1/SAFETY 3/SPEED 1.  The test modules use DEBUG 3/SAFETY 3/SPEED 1.  The value tests join their workers and record elapsed time for forced collection.  Run the group through a retained evaluation with an overall deadline.

The source includes thread-qualified test gates and collection hooks.  Normal prompt-return queued delivery, callback nonlocal exits, saved-image restoration, shared macro adoption, and mutex acquisition/release remain required work.  The accepted Web guest has none of these prototype definitions.  The [development journal](../devnotes.md#continuation-aware-foothold-binding-revision) records its evidence and limitations.
