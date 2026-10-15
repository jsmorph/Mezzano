# Notes on the second iteration of the compiler (aka "the new compiler"/"backend")

## Design

This sits behind the original compiler, taking in the processed & optimized AST, producing
a list of IR instructions, then finally generating assembly from that.

Instructions all linked together with an intrusive doubly-linked list. Basic blocks are
implicit.

Instructions are standard-objects that all derive from `backend-instruction`.
Instructions that end a basic block derive from `terminator-instruction`. Basic blocks are
started by a `label` instruction.

The first instruction in a function must always be an `argument-setup-instruction`.

Data flow is represented using `virtual-register` objects (vreg).
Instructions can take any number of vregs as inputs, and produce any number of vregs
as outputs. When in SSA form a vreg is defined by exactly once by one instruction. After
SSA deconstruction a vreg may be defined by multiple instructions. Instructions can
also directly reference physical registers (preg), though the compiler is less able to
reason about data-flow in this case. pregs are not permitted to be live over basic block
boundaries until after register allocation.

Local lexical variables can be represented as bound variables, these are named using
the `lexical-variable` class and can be loaded & stored normally. They are never in SSA
form, and are explicitly bound & unbound. Lexical variables are not immediatly converted
to SSA form because this loses debug lifetime information, and some hairy control-flow
involving NLX regions make this difficult. Bound variables must only be local (not captured)
and lexical (not special).

Common Lisp's multiple values are handled specially, outside the vreg/preg system.
Instructions specify that they consume or produce multiple values. These values, along
with the count of values, exist in the target's multiple value registers. Multiple
values can only be live over a small set of instructions.

Register allocation allocates registers for each virtual register, assigning them a
physical register. It may also insert stack spill/fill instructions as required.

Scoping of NLX regions, saved multiple values, and bindings...

Scoping of `make-dx-<foo>` instructions...

### Basic instruction functions

* `first-instruction` - Returns the first instruction in a function.
* `last-instruction` - Returns the last instruction in a function.
* `next-instruction` - Returns the instruction following the given instruction.
* `prev-instruction` - Returns the instruction preceeding the given instruction.
* `insert-before` - Insert a new instruction immediately before the given instruction.
* `insert-after` - Insert a new instruction immediately after the given instruction.
* `remove-instruction` - Unlink the given instruction from the instruction list.

* `instruction-inputs` - Returns a list of registers used as inputs.
* `instruction-outputs` - Returns a list of registers used as outputs.
* `produces-multiple-p` - True when the instruction produces multiple values.
* `consumes-multiple-p` - True when the instruction consumes multiple values.
* `multiple-value-safe-p` - True if this instruction permits multiple values being live over it.
* `instruction-pure-p` - True if this instruction has no side effects (does not access memory or other state).
* `successors` - Returns a list of instructions that succeed this instruction.

* `replace-all-registers` - Modify the instruction's registers, using the supplied substitution-function to transform them.
* `instruction-clobbers` - Returns a list of pregs that are used as temporaries.
* `instruction-inputs-read-before-outputs-written-p` - Returns true if this instruction reads all input registers before writing them. In other words, can inputs and outputs be safely assigned to the same register.
* `allow-memory-operand-p` - Does this instruction support using a memory operand for this instruction.

### General instructions

* `backend-instruction` - Base class of all instructions.
* `terminator-instruction` - Base class of all terminator instructions.
* `base-call-instruction` - Base class of all call instructions.
* `label` - Pseudo-instruction marking the start of a basic block or branch target, except fo. Labels have arguments, which are used to implement SSA phi nodes.
    * Outputs an arbitrary number of values (the arguments).
    * Multiple-value safe

* `argument-setup-instruction` - First instruction in a function. Performs argument setup, creating the `&rest` list. Primarily exists to act as a source for function argument values.
    * Outputs the `&closure` value.
    * Outputs the `&count` value.
    * Outputs the required arguments as a list of values.
    * Outputs the optional arguments as a list of values.
    * Outputs the `&rest` value.
    * Optionally outputs the original supplied-argument snapshot.
* `bind-local-instruction` - Establish a new lexical binding, with an initial value.
    * Inputs the initial value.
    * Multiple-value safe.
* `unbind-local-instruction` - Disestablish a lexical binding. Must be scoped correctly.
    * Multiple-value safe.
* `load-local-instruction` - Read the current value of a lexical binding.
    * Outputs the binding value.
    * Multiple-value safe.
    * Pure (but maybe shouldn't be?).
* `store-local-instruction` - Set the current value of a lexical binding.
    * Inputs the new value.
    * Multiple-value safe.
* `move-instruction` - Set a register to the value of another register.
    * Inputs the source value.
    * Outputs the destination value.
    * Multiple-value safe.
    * Pure.
* `swap-instruction` - Swaps the values of two registers.
    * Inputs & outputs a pair of registers.
    * Not SSA safe.
    * Pure.
* `spill-instruction` - Store a physical register into a virtual register's spill slot.
    * Inputs a physical register.
    * Outputs a virtual register with a spill slot.
    * Multiple-value safe.
    * Not SSA safe.
* `fill-instruction` - Load a physical register from a virtual register's fill slot.
    * Inputs a virtual register with a spill slot.
    * Outputs a physical register.
    * Multiple-value safe.
    * Not SSA safe.
* `constant-instruction` - Load a constant value.
    * Outputs the value.
    * Multiple-value safe.
    * Pure.
* `values-instruction` - Produce multiple values from a list of single values.
    * Inputs many values.
    * Produces multiple values.
* `multiple-value-bind-instruction` - Unpack multiple values into a list of single values.
    * Outputs many values.
    * Consumes multiple values.
* `save-multiple-instruction` - Save current multiple values.
    * Consumes multiple values.
* `restore-multiple-instruction` - Restore current multiple values. Must be matched in a stack-like way with a save instruction.
    * Produces multiple values.
* `forget-multiple-instruction` - Forget an unused set of multiple-values.
    * Multiple-value safe.
* `jump-instruction` - Unconditionally transfer control to the target label.
    * Inputs a values to use as arguments to the target label.
    * Multiple-value safe.
    * Terminator instruction.
* `branch-instruction` - Conditionally transfer control based on a value.
    * Inputs a generalized boolean value.
    * Terminator instruction.
* `switch-instruction` - Transfer control to the label indexed by the value.
    * Inputs a value to select which target to jump to.
    * Terminator instruction.
* `call-instruction` - Call the named function with the given arguments and produce a single result value.
    * Inputs a list of arguments.
    * Outputs a single result.
* `call-multiple-instruction` - Call the named function with the given arguments and produce multiple values.
    * Inputs a list of arguments.
    * Produces multiple values.
* `tail-call-instruction` - Tail-call the named function with the given arguments.
    * Inputs a list of arguments.
    * Terminator instruction.
* `funcall-instruction` - Call the function object with the given arguments and produce a single result value.
    * Inputs a function to call.
    * Inputs a list of arguments.
    * Outputs a single result.
* `funcall-multiple-instruction` - Call the function object with the given arguments and produce multiple values.
    * Inputs a function to call.
    * Inputs a list of arguments.
    * Produces multiple values.
* `tail-funcall-instruction` - Tail-call the function object function with the given arguments.
    * Inputs a function to call.
    * Inputs a list of arguments.
    * Terminator instruction.
* `multiple-value-funcall-instruction` - Call the function object with the current multiple values and produce a single result value.
    * Inputs a function to call.
    * Consumes multiple values.
    * Outputs a single result.
* `multiple-value-funcall-multiple-instruction` - Call the function object with the current multiple values and produce multiple values.
    * Inputs a function to call.
    * Consumes multiple values.
    * Produces multiple values.
* `return-instruction` - Return a single value from the function.
    * Inputs a value to return.
    * Terminator instruction.
* `return-multiple-instruction` - Return multiple values from the function.
    * Consumes multiple values.
    * Terminator instruction.
* `unreachable-instruction` - An instruction that should never be reached. Used to terminate control after calls to no-return functions.
    * Terminator instruction.
* `begin-nlx-instruction` - Create a non-local-exit context for the given branch targets.
    * Outputs an NLX context.
* `finish-nlx-instruction` - Tear down the given NLX context.
    * Multiple-value safe.
* `invoke-nlx-instruction` - Jump to the indexed target in the given context.
    * Inputs an NLX context.
    * Inputs an index into the context.
    * Inputs a value to pass to the target.
    * Terminator instruction.
* `invoke-nlx-multiple-instruction` - Jump to the indexed target in the given context.
    * Inputs an NLX context.
    * Inputs an index into the context.
    * Consumes multiple values.
    * Terminator instruction.
* `nlx-entry-instruction` - Mark the entry point of an NLX target that accepts a single value.
    * Inputs an NLX context.
    * Outputs a value.
    * Also tracks the `begin-nlx-instruction` instruction that starts this NLX region.
* `nlx-entry-multiple-instruction` - Mark the entry point of an NLX target that accepts multiple values.
    * Inputs an NLX context.
    * Produces multiple values.
    * Also tracks the `begin-nlx-instruction` instruction that starts this NLX region.
* `push-special-stack-instruction` - Push an entry on the special stack.
    * Inputs a low-half value to push.
    * Inputs a high-half value to push.
    * Outputs a newly pushed entry.
* `flush-binding-cache-entry-instruction` - Update the binding cache entry for a symbol.
    * Inputs a symbol to use.
    * Inputs a new value for the cache.
* `unbind-instruction` - Pop the special stack and unbind the associated special value.
    * Multiple-value safe.
* `disestablish-block-or-tagbody-instruction` - Pop the special stack and clear the env node for this NLX entry.
    * Multiple-value safe.
* `disestablish-unwind-protect-instruction` - Pop the special stack and invoke the unwind protect cleanup function in it.
* `make-dx-simple-vector-instruction` - Allocate a fixed-size simple-vector with dynamic-extent.
    * Outputs a new simple-vector.
    * Pure.
* `make-dx-typed-vector-instruction` - Allocate a fixed-size object with dynamic-extent.
    * Outputs a new object.
    * Pure.
* `make-dx-cons-instruction` - Allocate a cons with dynamic-extent.
    * Outputs a new cons.
    * Pure.
* `make-dx-closure-instruction` - Allocate a closure with dynamic extent.
    * Inputs a closure function.
    * Inputs a closure environment.
    * Outputs a new closure.
* `spice-instruction` - Extend the life of a value.
    * Inputs a value to keep live.
    * The spice extends life.
    * The spice expands consciousness.
    * The spice is vital to space travel.

### Box instructions

Box/unbox instructions convert between boxed and unboxed values. A boxed value is a value represented using the normal value representation (a tagged pointer). An unboxed value is an integer, floating point, or simd value that is untagged and represented directly as-is, and not examined by the GC.

* `box-instruction` - Base class of all box instructions.
    * Inputs an unboxed value.
    * Outputs a boxed value.
    * Pure.
* `box-fixnum-instruction` - Box a `fixnum` value.
* `box-unsigned-byte-64-instruction` - Box an `(unsigned-byte 64)` value.
* `box-signed-byte-64-instruction` - Box a `(signed-byte 64)` value.
* `box-single-float-instruction` - Box a `single-float` value.
* `box-double-float-instruction` - Box a `double-float` value.
* `unbox-instruction` - Base class of all unbox instructions.
    * Inputs a boxed value.
    * Outputs an unboxed value.
    * Pure.
* `unbox-fixnum-instruction` - Unbox a `fixnum` value.
* `unbox-unsigned-byte-64-instruction` - Unbox an `(unsigned-byte 64)` value.
* `unbox-signed-byte-64-instruction` - Unbox a `(signed-byte 64)` value.
* `unbox-single-float-instruction` - Unbox a `single-float` value.
* `unbox-double-float-instruction` - Unbox a `double-float` value.

### Debug instructions

Pseudo-instructions that do nothing except annotate the function's debug information.

* `debug-instruction` - Base class of all debug instructions.
    * Multiple-value safe.
* `debug-bind-variable-instruction` - Indicates that a lexical variable has been bound with the given value.
    * Inputs the new value of the variable.
* `debug-unbind-variable-instruction` - Indicates that a lexical variable has been unbound and is no longer live.
* `debug-update-variable-instruction` - Indicates that a lexical variable's value is now in another register.
    * Inputs the new value of the variable.

## Future directions

Only a few instructions produce more than one value. `label`, `argument-setup-instruction`,
and `multiple-value-bind`. A higher-level pure-SSA IR might get away with wiggling things
around so that all instructions produce a single "value", and values are referred to by
pointing directly at their defining instruction. That'd allow virtual-register to be
completely eliminated at that IR level, being fully implicit.

`instruction-inputs`/`instruction-outputs` cons up fresh lists each call. A better
representation of operands and outputs would reduce allocation in the compiler.

## Entry argument metadata

At function DEBUG 3, argument setup preserves every supplied argument before optional/default/key processing.  It reuses the target's stack rest-list builder with a zero fixed-argument prefix, gives the snapshot its own DX root, and restores the incoming count before ordinary argument setup.  The program's rest spine is separate.  Snapshot construction adds O(argument count) stack work and storage.  Original argument references remain live through the activation.

ARGUMENT-SETUP-INSTRUCTION's optional ORIGINAL output defaults to NIL.  Both target emitters include it in data flow and reserve the incoming-count slot when either argument list needs construction.  Preserved hidden debug bindings retain that output and an ordinary closure's exact incoming callable.  Lower debug levels use the existing entry path.  Compiler-generated unwind cleanup functions use a separate environment convention and receive no entry record.

The backend function stores its entry record separately from the source AST.  The assembler retains it as function debug-info field 12, whose zero-based list index is 11:

| Vector index | Value |
| --- | --- |
| 0 | :ENTRY-ARGUMENTS |
| 1 | The original-argument snapshot's existing binding descriptor |
| 2 | The exact closure callable's binding descriptor, or NIL for the executing nonclosure function |

A NIL record means unavailable entry data, including older compiled functions.  Existing precise debug locations, descriptor identities, constant-pool references, hidden-local filtering, and compiled-file serialization carry the record and its bindings.  The runtime reads through descriptor identity and READ-FRAME-SLOT.  FRAME-ENTRY-CONTEXT validates the live x86-64 frame through FRAME-RETURN-CONTEXT, then returns a copied argument-list spine, the callable, and an unavailability reason.  Zero arguments return NIL with a callable and no reason.  Referenced object mutations remain visible.  Malformed metadata signals an error.
