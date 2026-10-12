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
