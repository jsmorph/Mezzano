# Long-division experiment

[The implementation](long-division.lisp) provides `mezzano-long-division:divide`, which takes two integers and returns the quotient and remainder specified by `truncate`.  It uses normalized long division with base 2^30 digits in unsigned 32-bit arrays.  Digit products and two-digit quotient estimates fit in fixnums on the tested x86-64 systems.  Its temporary arrays hold copies of the operands.

The algorithm follows [GMP's description of basecase division](https://gmplib.org/manual/Basecase-Division), which cites Knuth Algorithm D.  The implementation estimates each quotient digit, corrects the estimate using the next divisor digit, subtracts the product, and adds the divisor back if subtraction borrows beyond the current dividend segment.

This is a standalone experiment.  Runtime integration is deferred.

## Tests and compilation

[The tests](test-long-division.lisp) passed 7,276 cases under Mezzano and SBCL.  Both quotient and remainder agreed with each system's existing `truncate`.  The tests also checked the division identity, remainder bounds, signs, and division by zero.  Cases cover digit boundaries, normalization, one-digit divisors, quotient-estimate correction, add-back correction, exact division, and deterministic generated operands through 6,144-bit dividends.

Both runs loaded compiled files.  A subsequent fresh SBCL process loaded only the three FASLs and passed the tests.  Mezzano reloaded its three compiled LLF files and passed the tests.  `compiled-function-p` succeeded for every function defined by the three source files, the operand-generator closure, and the installed `truncate` function.

The source files declare `(optimize (speed 3) (safety 3) (debug 1))`.  Mezzano's compiler restrictions were `nil`.  Each system's installed `truncate` retains its runtime compilation policy.

Compile on the host from the repository root:

```sh
sbcl --noinform --non-interactive \
  --eval '(load (compile-file "tools/long-division.lisp" :output-file "/tmp/long-division.fasl"))' \
  --eval '(load (compile-file "tools/test-long-division.lisp" :output-file "/tmp/test-long-division.fasl"))' \
  --eval '(load (compile-file "tools/bench-long-division.lisp" :output-file "/tmp/bench-long-division.fasl"))'
```

Start a fresh process using those compiled files:

```sh
sbcl --noinform --non-interactive \
  --load /tmp/long-division.fasl \
  --load /tmp/test-long-division.fasl \
  --load /tmp/bench-long-division.fasl \
  --eval '(mezzano-long-division-test:run)' \
  --eval '(mezzano-long-division-bench:run)'
```

Compile and load inside Mezzano:

```lisp
(dolist (name '("LONG-DIVISION" "TEST-LONG-DIVISION" "BENCH-LONG-DIVISION"))
  (multiple-value-bind (file warnings failure)
      (compile-file (format nil "SYS:SOURCE;TOOLS;~A.LISP" name)
                    :output-file (format nil "SYS:HOME;~A.LLF" name))
    (declare (ignore warnings))
    (assert (and file (not failure)))
    (load file)))

(mezzano-long-division-test:run)
(mezzano-long-division-bench:run)
```

## Measurements

The whole-function measurements below record revision 80db48c1.  Measurements taken on 2026-10-12 used an AMD Ryzen 3 PRO 7330U host.  SBCL 2.5.2.debian ran on Linux on that host.  Mezzano ran in its x86-64 KVM guest with two virtual CPUs and 2 GiB of memory.  The guest reported image version `devel 68a15834cba4fcf6f9f90da0713f31806006e92e`.  Both implementations have 62 positive fixnum bits.

[The benchmark](bench-long-division.lisp) uses 32 identical deterministic operand pairs per size on both systems.  Each row reports five samples lasting at least one second each.  The order of the two functions alternates between samples.  SBCL and Mezzano ran sequentially.  Timings include integer-to-array conversion, array-to-integer conversion, allocation, collection, function calls, and scheduling.  Operand generation occurs before measurement.

Times are microseconds per division.  Each cell gives the median followed by the minimum and maximum in parentheses.

| System | Dividend/divisor bits | Long division | Existing TRUNCATE |
| --- | ---: | ---: | ---: |
| SBCL | 512/256 | 1.101 (1.090–1.126) | 0.158 (0.156–0.159) |
| SBCL | 768/384 | 1.828 (1.782–1.890) | 0.215 (0.214–0.218) |
| SBCL | 1024/512 | 2.837 (2.757–2.854) | 0.284 (0.282–0.289) |
| SBCL | 2048/1024 | 8.248 (7.966–8.310) | 0.650 (0.631–0.654) |
| SBCL | 4096/2048 | 26.757 (26.153–27.904) | 1.772 (1.751–1.782) |
| Mezzano | 512/256 | 49.416 (40.957–94.379) | 114.469 (102.796–126.488) |
| Mezzano | 768/384 | 98.270 (74.940–315.657) | 202.922 (167.112–679.348) |
| Mezzano | 1024/512 | 173.611 (153.302–190.549) | 306.373 (244.141–592.105) |
| Mezzano | 2048/1024 | 861.486 (844.595–2229.167) | 885.417 (861.486–2604.167) |
| Mezzano | 4096/2048 | 5312.500 (4642.857–9218.750) | 3039.773 (2840.909–6160.714) |

For 768/384-bit operands, the ratio of existing division's median to the new routine's median is 2.06.  For 4096/2048-bit operands, the new routine takes 1.75 times as long.  The same 768/384-bit Lisp routine runs 53.8 times faster under SBCL.

The guest's sample ranges show substantial variation.  These measurements establish the cost of the complete standalone function in the running systems.  Separating compiler output, integer conversion, allocation, collection, and scheduling costs requires further measurement.  Certificate verification and HTTPS behavior remain untested with this algorithm.

The build-directory logs are `long-division-sbcl-bench.log`, `long-division-mezzano-bench.log`, `long-division-sbcl-compiled.log`, and `long-division-mezzano-compiled.log`.

## Preallocated division loop

These measurements record revision 97444acd.

The integer wrapper and [array benchmark](bench-long-division-kernel.lisp) now share `divide-digits`.  It mutates a normalized dividend array U and writes quotient digits into Q.  V holds the normalized divisor.  Each array element is below 2^30.  V's highest digit is at least 2^29.  U includes one leading work digit, and Q has `(- (length u) (length v))` elements.  The remainder occupies the low `(length v)` digits of U.

The array benchmark prepares all operands and result arrays before timing.  Each division restores U from a saved array.  Restoration alone is measured separately.  Both operations use the same 32 cases, five one-second samples, and alternating order.  Tests compared the prepared-array quotient and remainder with TRUNCATE before and after timing.  The refactored integer wrapper passed all 7,276 cases under both implementations.

Times are microseconds per operation, with median followed by minimum and maximum.

| System | Operand bits | Restore plus divide | Restore only |
| --- | ---: | ---: | ---: |
| SBCL | 768/384 | 0.698 (0.690–0.698) | 0.016 (0.016–0.016) |
| Mezzano | 768/384 | 16.259 (16.200–17.898) | 1.161 (1.159–1.186) |
| SBCL | 4096/2048 | 15.373 (15.343–15.388) | 0.054 (0.054–0.054) |
| Mezzano | 4096/2048 | 351.124 (339.674–351.124) | 5.917 (5.805–5.947) |

Both counters reported zero allocation during every timed array sample.  Mezzano uses its current thread's allocation counter.  SBCL uses its process allocation counter.  Restoration plus division takes 23.3 times as long in Mezzano at 768/384 bits and 22.8 times as long at 4096/2048 bits.

The integer wrapper's allocation was measured separately over 320 divisions per size.  These measurements use the extracted loop, with the conversion code unchanged.

| Operand bits | SBCL bytes/division | Mezzano bytes/division |
| ---: | ---: | ---: |
| 768/384 | 3,070.4 | 56,940.0 |
| 4096/2048 | 45,041.2 | 5,533,784.5 |

Input conversion calls LDB at successive 30-bit offsets.  [LDB](../system/numbers/logical.lisp) performs a right shift followed by a mask.  Mezzano's [large-integer shift wrapper](../system/numbers/bignum.lisp) implements a large right shift as repeated 32-bit shifts.  Each [x86-64 shift step](../system/numbers/bignum-x86-64.lisp) allocates a new integer.  This creates repeated copying during input conversion.  The allocation table measures the complete integer wrapper.

### Generated code and profile

SBCL emitted 1,059 instruction bytes for `divide-digits`.  Mezzano emitted 5,016.  Mezzano's loop contains calls to general array accessors and arithmetic routines.  SBCL uses direct indexed loads and stores in the division loop.

A Mezzano profile of 32,000 prepared divisions at 4096/2048 bits recorded 1,047 samples.  Of the 1,013 samples within `divide-digits`, 790 descended into array-access functions.  Those paths include AREF-1, its setter, ARRAY-RANK, ARRAY-DIMENSION, and row-major accessors.  The profiler sampled the benchmark thread and excluded collection.

[The compiler probes](long-division-probes.lisp) isolate one reason for the general array calls.  With V declared as a simple unsigned-32-bit array and I and J declared as fixnums, these expressions compile differently:

```lisp
(aref v (+ i j))
(aref v (the fixnum (+ i j)))
```

The first calls AREF-1.  The second emits a direct indexed load with type and bounds checks.  Both use SPEED 3, SAFETY 3, and DEBUG 1.  The [array transforms](../compiler/transforms.lisp) require a known fixnum index.  The compiler does not infer that result type for the first sum.  The declarations and bounds available in the division loop therefore leave general array calls in its generated code.

A separate probe confirmed that file-level OPTIMIZE proclamations and local OPTIMIZE declarations both select the requested policy.  The observed gap persists in compiled code with the requested policy.

The measured costs justify separate work on large-integer shifting and checked array-access optimization.  Both runtime and compiler changes require review and tests before integration.

### Reproduction

After loading the compiled implementation and test files, compile and load `bench-long-division-kernel.lisp` and `long-division-probes.lisp` through the same procedure used above.  Then evaluate:

```lisp
(mezzano-long-division-kernel-bench:run)

(mezzano-long-division-kernel-bench::integer-allocation 768 384)
(mezzano-long-division-kernel-bench::integer-allocation 4096 2048)

(disassemble #'mezzano-long-division::divide-digits)
(disassemble #'mezzano-long-division-probes::read-sum)
(disassemble #'mezzano-long-division-probes::read-checked-sum)
```

The Mezzano sampling profile used:

```lisp
(let ((cases (mezzano-long-division-kernel-bench:prepare
              (mezzano-long-division-test:operands 4096 2048 32))))
  (mezzano.profiler:with-profiling
      (:thread t :path "SYS:HOME;LONG-DIVISION-KERNEL-PROFILE.TXT")
    (dotimes (i 1000)
      (mezzano-long-division-kernel-bench:exercise cases t))))
```

Build-directory evidence includes `long-division-kernel-{sbcl,mezzano}-bench.log`, `long-division-allocation-{sbcl,mezzano}.log`, and `long-division-compiler-probe.log`.  Disassemblies are `long-division-kernel-sbcl.asm`, `long-division-probes-sbcl.asm`, `home/long-division-kernel-mezzano.asm`, and `home/long-division-probes-mezzano.asm`.  The sample profile is `home/long-division-kernel-profile.txt`.

## Type declarations

Revision bc591b1b added FIXNUM declarations to the two inner-loop counters and THE FIXNUM assertions to computed array indices.  The arithmetic, array representation, and compiler policy remain unchanged.  All 7,276 cases passed in both implementations, and prepared-array results matched TRUNCATE before and after timing.

Times below are microseconds per restoration plus division, with median followed by minimum and maximum.  SBCL and Mezzano ran sequentially on the same host as the preceding measurements.

| System | Operand bits | Original declarations | Index declarations |
| --- | ---: | ---: | ---: |
| SBCL | 768/384 | 0.698 (0.690–0.698) | 0.697 (0.691–0.701) |
| Mezzano | 768/384 | 16.259 (16.200–17.898) | 9.467 (9.438–9.513) |
| SBCL | 4096/2048 | 15.373 (15.343–15.388) | 15.297 (15.245–15.373) |
| Mezzano | 4096/2048 | 351.124 (339.674–351.124) | 194.099 (194.099–195.313) |

The ratios of the original and updated Mezzano medians are 1.72 and 1.81.  The updated Mezzano/SBCL ratios are 13.6 and 12.7.  Restoration-only medians were 1.183 and 5.911 microseconds in Mezzano, and 0.016 and 0.053 in SBCL.  Both implementations reported median allocation of zero in each row.

The computed-index assertions follow from the array bounds.  During each access, J lies between zero and SIZE-N, and I lies between zero and N-1.  Consequently J+I, J+N, J+N-1, and the guarded J+N-2 fit in FIXNUM and identify elements of U.  N-1 and the guarded N-2 identify elements of V.  The loop-counter declarations also admit their termination values.

Evidence is in the build-directory logs `long-division-indices-{sbcl,mezzano}-{build,bench}.log` and disassemblies `long-division-indices-sbcl.asm` and `home/long-division-indices-mezzano.asm`.

### Bounded arithmetic

The second step declared 30-bit digits and quotient estimates, 60-bit products and numerators, signed 31-bit differences, and one-bit carries.  Digit reads carry THE assertions because the arrays store unsigned 32-bit elements.  The algorithm stores values below 2^30 in those elements.

Let B=2^30.  The bounds supporting the declarations are:

| Value | Range |
| --- | --- |
| Digit, TOP, ESTIMATE | 0 through B-1 |
| NUMERATOR, PRODUCT, REMAINDER | 0 through B^2-1 |
| BORROW | 0 through B |
| DIFFERENCE | -B through B-1 |
| CARRY | 0 or 1 |
| SUM | 0 through 2B-1 |

The product bound follows from (B-1)^2+B = B^2-B+1.  Its high digit plus a subtraction borrow is at most B, preserving the borrow bound for the next iteration.  The initial remainder is between zero and the numerator.  Correction increments occur only while the remainder is below B and leave it below 2B.

All 7,276 cases passed under both implementations.  A separate Mezzano compilation enabled `mezzano.compiler::*the-checks-types*` and passed those cases with explicit THE checks.  The timed Mezzano compilation used NIL, the compiler's default setting for that switch.  Both timed implementations retained speed 3, safety 3, debug 1 and passed prepared-array checks before and after measurement.

Times are microseconds per restoration plus division, with median followed by minimum and maximum.

| System | Operand bits | Index declarations | Index and arithmetic declarations |
| --- | ---: | ---: | ---: |
| SBCL | 768/384 | 0.697 (0.691–0.701) | 0.452 (0.452–0.454) |
| Mezzano | 768/384 | 9.467 (9.438–9.513) | 9.438 (9.376–9.522) |
| SBCL | 4096/2048 | 15.297 (15.245–15.373) | 9.192 (9.192–9.246) |
| Mezzano | 4096/2048 | 194.099 (194.099–195.313) | 194.099 (194.099–195.313) |

The arithmetic declarations improved SBCL's medians by factors of 1.54 and 1.66.  Mezzano's sample ranges overlap, with identical larger-case medians.  The final Mezzano/SBCL ratios are 20.9 and 21.1.  Restoration-only medians were 1.180 and 5.891 microseconds in Mezzano, and 0.016 and 0.053 in SBCL.  Both implementations reported median allocation of zero in each row.

### Compiler costs after declarations

After the index declarations, Mezzano emitted direct element accesses and expanded the function from 5,016 to 9,591 instruction bytes.  Each of the 16 element-access sites calls ARRAY-DIMENSION, checks the dimension bound, and checks the storage bound.  The arithmetic declarations left the instruction count, byte count, and call-site counts unchanged.  SBCL's arithmetic declarations reduced its function from 1,059 to 1,007 instruction bytes.

A profile of 64,000 prepared 4096/2048-bit divisions recorded 1,216 samples.  Within DIVIDE-DIGITS, 262 of 1,163 samples descended into ARRAY-DIMENSION, and 901 remained in DIVIDE-DIGITS.  The profile sampled the benchmark thread and excluded collection.  It measures function-level costs and does not divide the remaining time among inline checks, arithmetic, branches, and memory operations.

At that revision, the [array transforms](../compiler/transforms.lisp) routed a typed one-dimensional AREF through ARRAY-ROW-MAJOR-INDEX and ROW-MAJOR-AREF, producing two bounds checks.  [ARRAY-DIMENSION simplification](../compiler/simplify.lisp) and the fast bounded-arithmetic transforms are restricted to safety 0.  The numeric declarations therefore leave specific optimization opportunities at safety 3.

This measurement led to the checked array specialization described below.  Arithmetic specialization using checked or derived bounds remains pending.

Evidence is in `long-division-types-{sbcl,mezzano}-{build,bench}.log`, `long-division-types-mezzano-checked.log`, `long-division-types-sbcl.asm`, `home/long-division-types-mezzano.asm`, and `home/long-division-types-profile.txt`.  The profile used the preceding reproduction form with 2,000 iterations and a separate output path.

## Checked array specialization

The compiler now specializes one-dimensional AREF and its setter at speed 3 with nonzero safety for the existing direct-access element types.  It checks the array type, checks the index against the vector length once, and accesses the element.  Stores also check the value.  Character and bit arrays retain their existing paths.

[The compiler tests](test-array-transforms.lisp) passed 608 cases at safety 3 with debug 1 and 3.  Functions compiled before and after the change agreed on values, evaluation order, and condition details.  The cases cover all 12 supported element types, boundary values, invalid arrays and indices, empty arrays, invalid stored values, and failure before mutation.  The count includes four declared-dimension and element-type checks at debug 1.  The existing traced setter at debug 3 does not enforce those declarations.  The division implementation passed all 7,276 cases after recompilation.

Times below are microseconds per restoration plus division.  Each cell gives the median followed by the minimum and maximum.  The Lisp division source and speed 3, safety 3, debug 1 policy are unchanged.

| Operand bits | Previous Mezzano compiler | Checked array specialization | SBCL |
| --- | ---: | ---: | ---: |
| 768/384 | 9.438 (9.376–9.522) | 6.105 (6.096–6.761) | 0.452 (0.452–0.454) |
| 4096/2048 | 194.099 (194.099–195.313) | 119.275 (118.821–119.275) | 9.192 (9.192–9.246) |

The updated Mezzano compiler improves these medians by factors of 1.55 and 1.63.  The Mezzano/SBCL ratios are 13.5 and 13.0.  Mezzano's restoration-only medians are 1.175 and 5.891 microseconds.  Every timed sample reported zero allocation.  Prepared-array results agreed with TRUNCATE before and after timing.  The SBCL column repeats the preceding measurement of the same division source.

The compiled division function shrank from 9,591 to 8,372 instruction bytes and from 2,447 to 2,135 instructions.  Each of its 16 element-access sites retains one bounds check.  The disassembly contains no ARRAY-DIMENSION calls or second storage-bounds checks.  Arithmetic checks and overflow paths remain.  Certificate verification still uses the existing runtime division, so these loop measurements do not establish a new certificate-verification time.

To compare compiler behavior in a running development guest, compile and load the test file, call CAPTURE before loading the updated compiled transforms, and pass its result to RUN afterward:

```lisp
(defparameter *array-reference* (mezzano-array-transform-test:capture))
;; Load the updated compiler transforms here.
(mezzano-array-transform-test:run *array-reference*)
```

RUN without an argument checks the current compiler's behavior without comparison to a previous compiler.  Evidence is in the build-directory logs `array-transform-reference.log`, `array-transform-load.log`, and `long-division-array-compiler.log`.  The disassembly is `home/long-division-array-compiler.asm`.

A fresh x86-64 image built from an empty target-code directory and booted to the CI completion marker with QEMU exit status 3.  Build and boot evidence is `array-compiler-build.log`, `array-compiler-ci-serial.log`, and `array-compiler-ci.exit`.  ARM64 execution and snapshot restoration of this compiler increment have not been tested.

## Runtime arithmetic

The x86-64 runtime now shifts a bignum by computing its word offset and residual bit count once.  It fills the result in one pass and passes that result to the existing canonicalizer.  The canonicalizer can allocate a shorter result.  ARM64 retains its previous shift implementation.

[The runtime tests](test-bignum-runtime.lisp) use SBCL-generated results for 4,278 shifts through 4,096-bit inputs.  They cover both signs, fixnum and word boundaries, zero shifts, counts that discard the entire input, input immutability, and canonical representation.  The installed shifts also passed the 7,276 division cases.  Candidate assembly functions passed the shift cases before runtime installation.

Generate the reference file under SBCL, then make it available to the guest:

~~~lisp
(mezzano-bignum-test:write-shift-cases "/path/to/bignum-shift-cases.sexp")
~~~

After compiling and loading the test file in each implementation:

~~~lisp
(mezzano-bignum-test:run-shifts "/path/to/bignum-shift-cases.sexp")
~~~

The [certificate benchmark](https/bench-certificates.lisp) takes a parsed chain and trust roots and measures the existing Lisp verifier.  READ-DATA reads the public DER fixture produced during the certificate investigation, returning the chain, roots, and verification time.  RUN excludes parsing, hostname checking, network traffic, and TLS key exchange.  SBCL reports process allocation.  Mezzano reports allocation by the current thread.

~~~lisp
(multiple-value-bind (chain roots now)
    (lispm-certificate-bench:read-data "/path/to/certificate-benchmark-data.sexp")
  (lispm-certificate-bench:run chain roots :now now))
~~~

Two measurements before replacing the shifts took 12.31 and 8.99 seconds and allocated about 7.908 GB per verification.  Three measurements afterward took 8.71, 8.24, and 8.30 seconds and allocated about 7.659 GB.  The sample variation limits the timing comparison.  These shift measurements precede the multiplication change below.  The certificate target is below 100 milliseconds.

Evidence is in the build-directory logs `bignum-shift-sbcl.log`, `bignum-shift-candidates.log`, and `bignum-shift-installed.log`.

Four tests forced a full collection at the allocation call inside a shift and checked the returned value.  They covered both signs and both directions.  Evidence is `bignum-shift-gc.log`.  Fresh-image boot and snapshot restoration of these runtime changes remain pending.

### Word multiplication

The x86-64 unsigned multiplication loop now uses MUL and ADD/ADC on raw words and register carries.  It allocates a work result and uses the existing canonicalizer afterward.  The signed Lisp wrapper retains sign handling and its zero and unit cases.  ARM64 retains the previous multiplication loop.

The candidate and installed function passed 1,824 SBCL-generated cases through 8,192-bit by 4,096-bit operands, including word boundaries, mixed digit patterns, both signs, input immutability, and canonical representation.  Two tests forced full collection at multiplication's allocation call.  The 7,276 division cases also passed.

Three certificate checks after installation took 7.38, 7.21, and 7.21 seconds, allocating approximately 6.992 GB per call.  Division still uses the bit-at-a-time routine.  Evidence is in `bignum-multiply-sbcl.log`, `bignum-multiply-candidate.log`, and `bignum-multiply-installed.log`.

### Word division

The x86-64 runtime now uses normalized Algorithm D with 32-bit digits and 64-bit machine arithmetic.  Lisp handles signs and allocation.  Assembly copies and normalizes operands, performs quotient estimation and correction, and converts the result digits back to integers.  The digit loop allocates no objects.  ARM64 retains its previous division implementation.

The candidate passed 1,824 SBCL-generated cases, twelve signed estimate-correction/add-back cases, and division-by-zero condition checks.  The installed runtime passed the 1,824 cases, full collection at result allocation, and all 7,276 comparisons with the standalone implementation.  The generated division fixture now includes the twelve additional cases.

Five certificate checks took 140, 100, 220, 100, and 110 milliseconds and allocated approximately 66.9 MB each.  These checks include collection and scheduling during the call.  The target remains below 100 milliseconds.  A follow-up profile identifies allocation and result canonicalization as remaining costs.

Evidence is in `bignum-divide-{sbcl,candidate,installed}.log`, `bignum-native-profile.log`, and `home/bignum-native-certificate-profile.txt`.  Fresh-image boot and snapshot restoration remain pending.
