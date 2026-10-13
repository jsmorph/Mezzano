# Lisp HTTPS tests

The [HTTPS and OpenAI reference](../../doc/https.md) documents the guest API, credential persistence, and current execution limits.

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

The source manifest pins pure-tls, Drakma, Ironclad, cl-cancel, atomics, precise-time, Bordeaux-Threads, Jzon, float-features, documentation-utils, trivial-indent, and the existing Mezzano fork of trivial-garbage.  Quicklisp supplies the remaining dependencies.  The tested distribution is 2026-01-01.  Its additional releases are cl-base64-20201016, idna-20120107, usocket-0.8.9, global-vars-20141106, puri-20201016, chunga-20260101, and cffi-20260101.  Existing MBuild sources supply Alexandria, Babel, Chipz, CL-PPCRE, Flexi Streams, split-sequence, trivial-features, trivial-garbage, trivial-gray-streams, and Closer-MOP.

The loader initializes pure-tls's CL+SSL compatibility system and registers it with ASDF before loading Drakma.  Start a fresh SBCL process for each command.

## Transport tests

    sbcl --noinform --non-interactive \
      --load "$MBUILD_ROOT/quicklisp/setup.lisp" \
      --load tools/https/load-sbcl.lisp \
      --load tools/https/test-sbcl.lisp \
      --eval '(lispm-https-test:run-transport-tests)'

The tests connect to api.openai.com.  They require full and resumed handshakes to verify the certificate chain exactly once.  Both paths must reject a mismatched requested hostname with correct SNI and an empty trust store.  A cached ticket without peer certificates must also fail verification.  The HTTP GET must return 401 with a parsed JSON error and supply a session ticket for the resumption checks.  The tests need network access and the system CA store.

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

## Reusable Responses function

Loading load-sbcl.lisp also loads openai.lisp.  After loading the same dependencies in another Lisp, load openai.lisp directly.

    (let ((request (make-hash-table :test 'equal)))
      (setf (gethash "model" request) "gpt-4.1-nano"
            (gethash "input" request) "Explain dynamic binding in Common Lisp."
            (gethash "store" request) nil)
      (lispm-openai:create-response key request :timeout 60))

CREATE-RESPONSE takes an API key string and a Jzon request hash table.  It returns the parsed response and the x-request-id header as two values.  The optional CA-FILE argument names a PEM trust bundle.  Certificate verification is required.  Redirects and header logging are disabled.  The function sends the caller's request fields unchanged, including the model and storage policy.  STREAM must be absent or NIL.  No retry is performed.

TIMEOUT is a positive duration in seconds, defaulting to 60.  It starts after request JSON encoding.  Connection establishment receives the smaller of 15 seconds and the remaining request time.  CL-CANCEL supplies the subsequent TLS cancellation context.  Fractional durations require the cl-cancel edit in ports/.  CPU-bound certificate verification can continue after cancellation closes the socket.  TIMEOUT does not guarantee that the Lisp call returns within that duration.  Deadline cancellation does not establish whether the remote service processed a request.

HTTP-ERROR retains the status, request ID, and response octets through HTTP-ERROR-STATUS, HTTP-ERROR-REQUEST-ID, and HTTP-ERROR-BODY.  Its printed report includes only the status and request ID.  Transport, certificate, cancellation, and JSON errors propagate.  A successful HTTP response can have an application status other than completed.  The caller examines the returned JSON.

The function overwrites its Authorization string on exit.  The caller owns the key string.  Lisp allocation and library internals can retain other copies.

The [OpenAI API overview](https://developers.openai.com/api/reference/overview) documents authentication and request IDs.  To test HTTP error handling without a credential, load test-openai.lisp and call LISPM-OPENAI-TEST:RUN.  Its invalid-key request must return a typed HTTP 401 with a JSON error.  This test passed under SBCL on Linux and Mezzano.  Under both SBCL and Mezzano, the reusable function also passed an authenticated request through RUN-OPENAI-TEST: HTTP 200, completed status, and the text "Lisp HTTPS works."

## Tested scope and Mezzano work

On 2026-10-12, the Linux SBCL tests negotiated TLS 1.3 with TLS_CHACHA20_POLY1305_SHA256.  Both certificate-rejection tests passed.  The authenticated POST returned HTTP 200 and "Lisp HTTPS works.", with 15 input tokens and 6 output tokens.

These tests cover one service and the stated verification failures.  Streaming responses, certificate revocation, and the upstream TLS test suite remain untested.  The cancellation tests below check blocked input and handshake cleanup.  The corrected fractional deadline tests passed under SBCL.

The guest entropy, connection controls, and cancellation tests below passed.  Library portability edits are retained in ports/.  The guest TLS/HTTP stack compiled and loaded.  Full and resumed handshakes passed, each verifying the certificate chain once.  Both paths rejected a mismatched hostname and an empty trust store.  A cached ticket without peer certificates also failed verification.  The guest GET and invalid-credential POST returned HTTP 401 with parsed JSON and normal TLS close.  The authenticated guest Responses request returned HTTP 200, completed status, and "Lisp HTTPS works.", using gpt-4.1-nano-2025-04-14 with 15 input tokens and 6 output tokens.

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

TCP supports receiving EOF while its sending direction remains open.  OPEN-STREAM-P remains true in CLOSE-WAIT, and subsequent writes remain subject to normal acknowledgment and retransmission.  Local FIN consumes a sequence number.  A data acknowledgment alone cannot complete local close.

The half-close tests include the connection tests:

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-HALF-CLOSE.LISP")
    (lispm-network-test::run-half-close)

They cover output after EOF, forced retransmission, sequence wraparound, separate data and FIN acknowledgments, invalid acknowledgments, and FIN with buffered data.

Inside the guest:

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-NETWORK.LISP")
    (lispm-network-test::run)

The tests cover DNS and connection deadlines, an expired queued connection, interrupted establishment, refusal, octet transfer, EOF, blocked-read abort, and removal from the connection list.  To test snapshot invalidation:

    (lispm-network-test::prepare-restore-test)
    (mezzano.supervisor:snapshot)
    (mezzano.supervisor:wait-for-snapshot-completion)

After restarting QEMU from that snapshot:

    (lispm-network-test::finish-restore-test)

These tests passed on x86-64 QEMU before and after snapshot restoration.  A saved half-closed connection signaled CONNECTION-STALE after restoration.  The fresh CI image also passed its boot test.  The tests do not exercise a route disappearing while an abort reset is being sent.

## Guest library source edits

The files in ports/ contain source edits against the revisions and releases listed above.  Apply each file from its corresponding library's source directory with git apply.  For example:

    git -C "$TLS_SOURCES/pure-tls" apply /path/to/Mezzano/tools/https/ports/pure-tls.diff

The edits cover Ironclad entropy, USOCKET and Drakma connection timeouts, USOCKET listener addresses, a Bordeaux-Threads declaration error, precise-time's Mezzano clock, cl-cancel clock units and monitor cleanup, TLS stream cleanup, certificate-chain verification on resumption, and propagation of HTTP close errors.  Bordeaux-Threads uses Mezzano's native CAS and fixnum arithmetic macros, with its existing mutex implementation for full-width ATOMIC-INTEGER values.  Trivial-garbage maps Mezzano's existing weak hash tables.  Its source revision is d3e470cb2385f7564147367452cb6237d3bd9818 from MBuild.  The guest atomic tests passed.

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-ATOMICS.LISP")
    (lispm-atomics-test:run)

The cancellation test requires the edited cl-cancel and pure-tls sources.  After loading the HTTPS libraries:

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-CANCELLATION.LISP")
    (lispm-cancellation-test:run)

For SBCL, load tools/https/test-cancellation.lisp and call the same function.  The tests passed under SBCL on Linux for early cleanup, close failures, blocked input, blocked handshake, monitor cleanup, clock continuity, and fractional deadlines.  Timing assertions check both elapsed-time bounds.  Durations cover rational, single-float, and double-float values.  The same tests passed in the x86-64 guest.  They also exercise USOCKET's assigned listener port.

## Guest source preparation

Prepare the pinned Git sources using the installation loop above with TLS_SOURCES set to "$MBUILD_ROOT/home/https-sources".  The guest loader gives that directory precedence over the older MBuild dependencies.  Install the additional Quicklisp libraries through the host loader, then copy their pinned releases:

    while read -r project release
    do
      cp -a "$MBUILD_ROOT/quicklisp/dists/quicklisp/software/$release" "$TLS_SOURCES/$project" || exit "$?"
    done < tools/https/quicklisp.tsv
    for edit in tools/https/ports/*.diff
    do
      project="${edit##*/}"
      project="${project%.diff}"
      git -C "$TLS_SOURCES/$project" apply "$PWD/$edit" || exit "$?"
    done
    cp /etc/ssl/certs/ca-certificates.crt "$MBUILD_ROOT/home/https-ca-certificates.crt"

Use a maintained PEM CA bundle from the host's certificate package.  The copied bundle supplies trust anchors for the guest.  Recopy it when those anchors change.

The guest loader selects the pinned sources and loads the Responses function:

    (load "SYS:SOURCE;TOOLS;HTTPS;LOAD-MEZZANO.LISP")

After loading, the shared transport tests accept the guest CA pathname:

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-SBCL.LISP")
    (lispm-https-test:run-transport-tests
     :ca-file "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT")

The same CA-FILE argument applies to CREATE-RESPONSE, RUN-OPENAI-TEST, and LISPM-OPENAI-TEST:RUN.  The explicit bundle passed the full transport tests under SBCL and Mezzano.

The combined guest test runs entropy, atomics, cancellation, HTTP cleanup, certificate verification, and invalid-credential checks:

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-MEZZANO.LISP")
    (lispm-https-guest-test:run
     :ca-file "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT")

The HTTP cleanup fixture uses in-memory response streams.  It requires an injected close failure to reach the caller and requires abort close after an incomplete response.  Load test-http-cleanup.lisp and call LISPM-HTTP-CLEANUP-TEST:RUN to run it separately.  This fixture passed under SBCL and Mezzano.

## Authenticated guest test

The authenticated runner reads a file whose first line contains the API key:

    (lispm-https-guest-test:run-authenticated-from-file
     "SYS:HOME;OPENAI-TEST.KEY"
     :ca-file "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT")

It uses RUN-OPENAI-TEST, reports the response and token counts, and clears the key string on exit.  A failed call reports the condition type after cleanup.  The test's evaluation source contains only the pathname.  The file remains the caller's responsibility.

The test procedure preserves a complete disk image before credential ingestion, with QEMU stopped during the copy.  It deletes the temporary credential file after the request and restores that image with QEMU stopped.  Restarting from a snapshot in the same modified file would leave possible credential copies written by paging.  The [credential-persistence reference](../../doc/https.md#credentials-and-persistence) describes the guest heap and retained evaluation state.

## Listener function tests

The loader also defines [COMPLETE and CURL](../../doc/https.md#listener-functions) in CL-USER.  COMPLETE reads `openai-api.key` from the guest home directory.  The installed key file contains only the key on its first line, uses mode 0600, and stays outside the checkout.

The GET tests exercise a chunked HTTP text response and a verified HTTPS response from example.org, plus an HTTPS request to OpenAI returning HTTP 401 JSON as octets.  The in-memory tests decode raw and already chunked streams and a complete chunked HTTP response.  The completion tests call the default model and an explicit model:

    (load "SYS:SOURCE;TOOLS;HTTPS;TEST-LISTENER.LISP")
    (lispm-https-listener-test:run-chunked-tests)
    (lispm-https-listener-test:run-get-tests)
    (lispm-https-listener-test:run-completion-tests)

The completion test requires the private key file.  It reports a failed call's condition type after unwinding its credential-bearing frames.

The guest passed the in-memory chunk tests and live chunked HTTP GET after correcting CLOS method ordering.  The portable method-order test checks both method-definition orders, explicit argument precedence, CALL-NEXT-METHOD, nonmatching EQL arguments, and repeated dispatch:

    (load "SYS:SOURCE;TOOLS;TEST-CLOS-METHOD-ORDER.LISP")
    (lispm-method-order-test:run)

Under SBCL, load `tools/test-clos-method-order.lisp` and call the same function.  The test passed under both implementations.  LISPM-METHOD-ORDER-TEST:CHECK-EXISTING checks already defined functions without replacing them, supporting cache-invalidation and snapshot-restoration tests.

The verified HTTPS GET to example.org now passes with the x86-64 arithmetic improvements.  The GET test retains both the HTTP chunked-response assertion and the HTTPS request.  The OpenAI request tests verified HTTPS and an HTTP error response.

The browser completion test requires Node, headless Chromium, the running Web service, and the installed guest key file.  It submits COMPLETE through the Listener, checks the returned state and text, and saves the result and screenshot:

    node tools/swank/web/test-browser-complete.mjs http://lispm.example.net:8765/ browser-complete-results

This test sends one authenticated inference request.  It passed against the x86-64 guest.
