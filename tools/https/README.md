# Lisp HTTPS tests

These tests run Drakma over pure-tls under SBCL on Linux.  Jzon encodes and decodes JSON.  The TLS implementation and cryptographic algorithms run in Lisp.  SBCL supplies sockets and the operating system supplies entropy, clocks, and trusted CA certificates.  CFFI supports precise-time's Linux clock calls.

## Installation

Use the MBuild layout described in [Installation and operation](../../doc/installation.md).  Run these commands from the Mezzano checkout.  The pinned TLS sources occupy a separate directory so they take precedence over MBuild's older Bordeaux-Threads without replacing it.

MBUILD_ROOT denotes the directory containing Mezzano, home, and quicklisp.  TLS_SOURCES selects the separate library directory.

    MBUILD_ROOT="$(cd .. && pwd)"
    TLS_SOURCES="$MBUILD_ROOT/https-sbcl/sources"
    mkdir -p "$TLS_SOURCES"
    while read -r project repository revision
    do
      git clone "$repository" "$TLS_SOURCES/$project" || exit "$?"
      git -C "$TLS_SOURCES/$project" checkout --detach "$revision" || exit "$?"
    done < tools/https/sources.tsv
    export CL_SOURCE_REGISTRY="(:source-registry (:tree \"$TLS_SOURCES/\") (:tree \"$MBUILD_ROOT/home/\") :ignore-inherited-configuration)"

The source manifest pins pure-tls, Drakma, Ironclad, cl-cancel, atomics, precise-time, Bordeaux-Threads, Jzon, float-features, documentation-utils, and trivial-indent.  Quicklisp supplies the remaining dependencies.  The tested distribution is 2026-01-01.  Its additional releases are cl-base64-20201016, idna-20120107, usocket-0.8.9, global-vars-20141106, puri-20201016, chunga-20260101, and cffi-20260101.  Existing MBuild sources supply Alexandria, Babel, Chipz, CL-PPCRE, Flexi Streams, split-sequence, trivial-features, trivial-garbage, trivial-gray-streams, and Closer-MOP.

The loader initializes pure-tls's CL+SSL compatibility system and registers it with ASDF before loading Drakma.  Start a fresh SBCL process for each command.

## Transport tests

    sbcl --noinform --non-interactive \
      --load "$MBUILD_ROOT/quicklisp/setup.lisp" \
      --load tools/https/load-sbcl.lisp \
      --load tools/https/test-sbcl.lisp \
      --eval '(lispm-https-test:run-transport-tests)'

The tests connect to api.openai.com.  They require a verified handshake, reject a mismatched hostname while retaining the correct SNI hostname, reject an empty trust store, and require an unauthenticated Drakma GET to return HTTP 401 with a JSON error.  The tests need network access and the system CA store.

## OpenAI request

The authenticated test sends one POST to the [Responses endpoint](https://developers.openai.com/api/docs/quickstart), using gpt-4.1-nano and the prompt "Reply with exactly: Lisp HTTPS works."  It sets store to false, disables redirects and header logging, requires certificate verification, and applies a 60-second cancellation deadline.  A successful test requires HTTP 200, response status completed, and nonempty text.  It prints the model, text, and token counts.

Supply a file containing only the API key on its first line:

    sbcl --noinform --non-interactive \
      --load "$MBUILD_ROOT/quicklisp/setup.lisp" \
      --load tools/https/load-sbcl.lisp \
      --load tools/https/test-sbcl.lisp \
      --load tools/https/openai-stdin.lisp < /path/to/private/openai-key

The key enters through standard input.  The runner redacts the key from reported errors and exits with status 1 on failure.  It overwrites its key and Authorization strings after use.  Lisp allocation and library internals can retain other copies until process exit.

A Lisp caller can use:

    (lispm-https-test:run-openai-test key :model "gpt-4.1-nano")

The function returns the parsed response object.  Drakma's :VERIFY :REQUIRED is essential: its default VERIFY argument is NIL.

## Tested scope and Mezzano work

On 2026-10-12, the Linux SBCL tests negotiated TLS 1.3 with TLS_CHACHA20_POLY1305_SHA256.  Both certificate-rejection tests passed.  The authenticated POST returned HTTP 200 and "Lisp HTTPS works.", with 15 input tokens and 6 output tokens.

These tests cover one service and the two stated verification failures.  Streaming responses, cancellation during blocked I/O, certificate revocation, and the upstream TLS test suite remain untested.

Mezzano integration requires an Ironclad entropy backend, a trust-store installation, and testing of the existing portability backends.  USOCKET's Mezzano backend rejects explicit connection timeouts.  Guest compilation and execution of this TLS/HTTP stack remain pending.

## Guest entropy

The Lisp VirtIO entropy driver supplies fresh octet vectors through MEZZANO.DRIVER.VIRTIO-ENTROPY:RANDOM-DATA.  It signals ENTROPY-UNAVAILABLE if the device is missing, belongs to an earlier boot, or returns an invalid completion.  One worker serializes requests through a nonpersistent DMA buffer.  A caller receives its private result after the device has supplied every byte.

Add these arguments to the x86-64 QEMU command:

    -object rng-random,id=rng0,filename=/dev/urandom \
    -device virtio-rng-pci,rng=rng0

Compile and load the driver before testing an existing image.  New image builds include it.  Inside the guest:

    (load (compile-file "SYS:SOURCE;TOOLS;HTTPS;TEST-ENTROPY.LISP"))
    (lispm-entropy-test::device-tests)

Loading the test checks completion lengths, descriptor IDs, queue index wraparound, and missing-device errors.  DEVICE-TESTS runs four concurrent 8,193-byte reads.  To exercise partial completions, run QEMU with max-bytes=17,period=5 on the virtio-rng-pci device.

With that test rate limit, save an incomplete request:

    (lispm-entropy-test::prepare-restore-test)
    (mezzano.supervisor:snapshot)
    (mezzano.supervisor:wait-for-snapshot-completion)

Restart QEMU from the saved image, then evaluate:

    (lispm-entropy-test::finish-restore-test)

The completion test requires the saved request to fail with ENTROPY-UNAVAILABLE and a new request to receive bytes from the current device.  These tests passed on x86-64 QEMU.  ARM64 and bare-metal entropy remain untested.

## Guest connection control

MEZZANO.NETWORK.TCP:TCP-STREAM-CONNECT accepts :CONNECT-TIMEOUT in seconds.  It applies one deadline to DNS resolution and TCP establishment.  The default remains ten seconds.  The existing :TIMEOUT parameter controls connection inactivity.  Expiration signals MEZZANO.NETWORK:NETWORK-TIMEOUT or its TCP subtype.

CLOSE with :ABORT T closes local TCP state and wakes a blocked reader with a connection error.  The network queue sends a reset when the TCP state requires one and removes the connection's timers and dispatch sources.

Inside the guest:

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-NETWORK.LISP")
    (lispm-network-test::run)

The tests cover DNS and connection deadlines, an expired queued connection, interrupted establishment, refusal, octet transfer, EOF, blocked-read abort, and removal from the connection list.  To test snapshot invalidation:

    (lispm-network-test::prepare-restore-test)
    (mezzano.supervisor:snapshot)
    (mezzano.supervisor:wait-for-snapshot-completion)

After restarting QEMU from that snapshot:

    (lispm-network-test::finish-restore-test)

These tests passed on x86-64 QEMU.  They do not exercise a route disappearing while an abort reset is being sent.

## Guest library source edits

The files in ports/ contain source edits against the revisions and releases listed above.  Apply each file from its corresponding library's source directory with git apply.  For example:

    git -C "$TLS_SOURCES/pure-tls" apply /path/to/Mezzano/tools/https/ports/pure-tls.diff

The edits cover Ironclad entropy, USOCKET and Drakma connection timeouts, a Bordeaux-Threads declaration error, cl-cancel clock units and monitor cleanup, and TLS stream cleanup.  Bordeaux-Threads uses Mezzano's native CAS and fixnum arithmetic macros, with its existing mutex implementation for full-width ATOMIC-INTEGER values.  Trivial-garbage maps Mezzano's existing weak hash tables.  Its source revision is d3e470cb2385f7564147367452cb6237d3bd9818 from MBuild.  The guest atomic tests passed.  Guest HTTPS execution remains incomplete.

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-ATOMICS.LISP")
    (lispm-atomics-test:run)

The cancellation test requires the edited cl-cancel and pure-tls sources.  After loading the HTTPS libraries:

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-CANCELLATION.LISP")
    (lispm-cancellation-test:run)

For SBCL, load tools/https/test-cancellation.lisp and call the same function.  The tests passed under SBCL on Linux.  They check that early cleanup preserves the parent context and stream, close failures reach the caller, deadlines interrupt a blocked read and handshake, and monitor threads terminate.
