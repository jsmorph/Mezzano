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

Measurements taken on 2026-10-12 used an AMD Ryzen 3 PRO 7330U host.  SBCL 2.5.2.debian ran on Linux on that host.  Mezzano ran in its x86-64 KVM guest with two virtual CPUs and 2 GiB of memory.  The guest reported image version `devel 68a15834cba4fcf6f9f90da0713f31806006e92e`.  Both implementations have 62 positive fixnum bits.

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
