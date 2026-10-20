# Notes on the first iteration of the compiler (aka "the compiler")

## Design

Common Lisp source code is accepted, parsed, and canonicalized. It is transformed into
a tree of abstract syntax objects (AST). Various optimizations are performed on the tree.

## Function properties, future directions

The compiler need to know various things about functions in the world. Currently these
properties are scattered around various global variables and a few hard-coded lists.
These should all be found and centralized.

Non-exhaustive list of properties that exist for a function:

* name
* constant-fold-mode (unconditional or arg type match or commutative-arithmetic)
* transforms
* pure-functions
* pure-functions-at-low-safety
* inline-info
* macro
* compiler-macro
* declared type
* associated fref
* mod-n-arithmetic
* atomic-struct-slots/etc
* architecture-specific builtins
* backend primitives(?)
* plist

There's been some small work towards this in the form of `function-info`.

## Checked array access

At speed 3 with nonzero safety, the array transforms specialize one-dimensional AREF and its setter when the array has a known direct-access simple-array type and the index has known type FIXNUM.  They validate the declared array type, read the length from the object header, and check the index once through %COMPLEX-BOUNDS-CHECK.  A setter checks its value after the bounds check.  The transform machinery preserves argument evaluation order.

The element-accessor table covers T, FIXNUM, signed and unsigned 8-, 16-, 32-, and 64-bit integers, SINGLE-FLOAT, and DOUBLE-FLOAT.  Character and bit arrays use the existing paths.  The specialized transforms register after the general AREF transforms because the compiler tries the most recently registered transform first.

[The array tests](../../tools/test-array-transforms.lisp) compare compiled reads and stores with functions captured before a compiler update.  [The long-division report](../../tools/long-division.md#checked-array-specialization) records the measured effect and test limits.

## Compilation results

COMPILE and COMPILE-FILE return a primary result, a warning flag, and a failure flag.  A WARNING or ERROR sets the warning flag.  An ERROR or a WARNING other than STYLE-WARNING also sets the failure flag.  Diagnostic observation preserves condition signaling, handlers, restarts, and nonlocal exits.

Each invocation records its own flags.  Nested compilation also contributes to its enclosing invocation.  File-compilation workers share their invocation's flag cells through the compiler's existing initial bindings.  Independent compilation threads retain separate cells.  The file compiler reads the flags after receiving the workers' completion messages.  Normal file compilation sends :FINISHED and joins every worker before writing the output file.  Exceptional exits request worker termination through one enclosing cleanup.  Asynchronous interruption of mutex cleanup remains a known synchronization defect.

When COMPILE receives a function name, it installs the result and returns that name, including when the supplied definition is already compiled.  A NIL name returns the compiled function.

## Source parameter identities

At function DEBUG 3, LAMBDA-INFORMATION retains the source required, optional, rest, and keyword bindings separately from the argument slots that lowering rewrites.  The layout also retains declared supplied-p bindings and the keyword/allow-other-keys flags.  Source lexical bindings use the existing preservation policy.

COPY-FORM initializes the copied lambda's layout from the source layout.  COPY-VARIABLE replaces each matching binding by identity in the copied layout when it creates that binding.  This includes parameters lowered into LET nodes, whose replacement-list scope ends before control returns to the lambda copier.  Copies retain hidden-variable flags and receive fresh debug binding descriptors.

For each special parameter, LOWER-SPECIAL-BINDINGS preserves the special-stack cell immediately after its existing %%BIND, through one hidden lexical variable.  The descriptor therefore identifies the parameter's cell despite later rebinding of the same symbol.  Before parameter binding, that location is unavailable.  The additional value uses existing debug liveness and GC roots.  [The backend metadata reference](compiler-backend.md#source-parameter-metadata) describes its emitted representation.

PASS1 reuses each explicit special parameter object when extending the body environment for declarations.  The parameter record and instruction type table therefore retain the same compiler binding identity.  Per-instruction [parameter type scopes](compiler-backend.md#parameter-type-scopes) preserve declarations for a parameter hidden by a later same-name binding.

## Global definition provenance

The internal declaration (LAMBDA-NAME name :GLOBAL T) identifies a global definition separately from its display name.  Native and cross DEFUN expansions emit it.  Named COMPILE adds it when compiling nonmacro lambda source.  Installing an already compiled function under another name preserves that function's source provenance.

PASS1 retains the immutable #(:GLOBAL-FUNCTION name) record in the lambda plist.  Existing AST copying preserves it.  The [backend metadata reference](compiler-backend.md#callable-provenance-metadata) defines emission and current-definition resolution.  Local and anonymous functions receive the explicit exact-callable marker when compiled at DEBUG 3.
