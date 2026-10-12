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
