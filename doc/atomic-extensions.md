# Atomic extensions

## Atomic places

The following places support atomic operations:

* Special variables
* Structure slots
* `car`
* `cdr`
* `svref`
* `aref`/`row-major-aref` (except on strings and arrays of complex numbers)
* `standard-instance-access`/`funcallable-standard-instance-access`
* `slot-value`
* `elt`
* `first`/`second`/.../`tenth`
* `rest`
* `nth`
* `gethash`

Lexical variables are unsupported.  Further atomic places may be defined through CAS functions.

## Functions & macros

### `cas`/`compare-and-swap`

`(compare-and-swap place old-value new-value)`

Atomically read the value of `place`, compare with `old-value`, if `eq` then
write `new-value` otherwise do nothing.

`place` must be an atomic place.

Returns the old value of the place.

### `double-compare-and-swap`

`(double-compare-and-swap place-1 place-2 old-1-value old-2-value new-1-value new-2-value)`

Atomically perform a compare-and-swap operation on two places.

Due to machine limitations, the places must be physically contiguous in memory.

The only supported places are `car`/`cdr` (in either order) on the same cons, or
a `:dcas-sibling` pair within a struct (see [structure extensions](defstruct-extensions.md#slot-option-dcas-sibling)).

Returns three values:

1. A generalized boolean indicating if the swap was successful.
2. The old value of `place-1`.
3. The old value of `place-2`.

### `get-cas-expansion`

`(get-cas-expansion place &optional environment)`

Returns a number of values describing how to perform cas operations on `place`,
similar to `get-setf-expansion`.

1. A list of temporary variables.
2. A list of value-forms to whose results those variables must be bound.
3. Temporary variable for the old value of `place`.
4. Temporary variable for the new value of `place`.
5. Form using the aforementioned temporaries which performs the compare-and-swap operation on `place`.
6. Form using the aforementioned temporaries with which to perform an atomic read of `place`.
7. Form using the aforementioned temporaries with which to perform an atomic write of `place`.

### Atomic updates

| Form | Operation and result |
|---|---|
| `(atomic-incf place &optional (delta 1))` | Adds DELTA and returns the old value.  The place and DELTA must contain fixnums. |
| `(atomic-decf place &optional (delta 1))` | Subtracts DELTA and returns the old value.  The place and DELTA must contain fixnums. |
| `(atomic-logandf place integer)` | Applies LOGAND and returns no values.  The operands must be fixnums. |
| `(atomic-logiorf place integer)` | Applies LOGIOR and returns no values.  The operands must be fixnums. |
| `(atomic-logxorf place integer)` | Applies LOGXOR and returns no values.  The operands must be fixnums. |
| `(atomic-swapf place new-value)` | Replaces the value and returns the old value. |

ATOMIC-DECF negates DELTA before calling ATOMIC-INCF.  MOST-NEGATIVE-FIXNUM therefore exceeds that implementation's accepted delta range after negation.  Overflow behavior depends on the compiler's fixnum arithmetic implementation.

## Memory ordering

These macros accept no memory-order argument.  Ordering depends on the target implementation.  The interface does not specify a portable ordering model for all supported architectures.

## Custom cas functions

Further atomic places can be defined via CAS functions, similar to SETF functions.
The function must accept at least two values: the old value to compare against, and
the new value to write.  As with setf functions, it may accept additional parameters.
It must return the existing value that was read from the place.

The function name has the form `(cas accessor-name)`.  Its body must implement an atomic comparison and conditional replacement.  A separate read followed by an ordinary write does not provide that operation.
