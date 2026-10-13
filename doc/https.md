# HTTPS and OpenAI requests

Mezzano's HTTPS integration uses Drakma for HTTP, pure-tls for TLS 1.3, Ironclad for cryptography, and [Jzon](json.md) for JSON.  TLS and cryptographic operations execute in Lisp.  The guest obtains entropy from a VirtIO entropy device and trust anchors from a PEM CA bundle.

The libraries compiled and loaded on x86-64 QEMU.  Guest tests passed full and resumed TLS handshakes, certificate rejection checks, blocked-I/O cancellation, HTTP cleanup, an unauthenticated GET, and an invalid-credential POST.  The reusable Responses client passed authenticated inference in the guest and under SBCL on Linux: HTTP 200, completed status, and "Lisp HTTPS works."

## Installation

The [HTTPS installation and test guide](../tools/https/README.md) specifies pinned sources, portability edits, guest source preparation, the QEMU entropy device, and CA installation.  After preparing those files, load the client in the guest:

```lisp
(load "SYS:SOURCE;TOOLS;HTTPS;LOAD-MEZZANO.LISP")
```

The loader gives the separate HTTPS dependency directory precedence over MBuild's older libraries.  Compilation can take substantial time.  The CA bundle is a host-maintained file copied into the guest's accessible filesystem.  Refresh that copy when the host's trust anchors change.

## Listener functions

The loader defines COMPLETE and CURL in CL-USER, the Listener's default package:

```lisp
(complete "Explain dynamic binding in Common Lisp.")
(complete "Explain dynamic binding in Common Lisp." "gpt-4.1-nano")

(curl "https://example.org/")
```

COMPLETE accepts a prompt string and an optional model string, defaulting to gpt-4.1-nano.  It returns the response's output text as one string.  It sets store to false and signals an error if the response is incomplete or contains no output text.

Each call reads the key from `openai-api.key` in USER-HOMEDIR-PATHNAME.  That private file contains the key on its first line and stays outside the repository.  A host file served through MBuild uses mode 0600.  The caller supplies only the prompt and optional model.  The function overwrites its key string on exit, subject to the persistence limits below.

CURL performs GET and returns three values: the body, integer HTTP status, and header alist.  Drakma decodes `text/*` bodies as strings using the response's charset.  Other content types, including `application/json`, return octet vectors.  CURL decompresses encoded content and follows at most five redirects.  A 404 or another HTTP error status is returned with its body and headers.  Transport and TLS errors signal conditions.

```lisp
(multiple-value-bind (body status headers)
    (curl "https://api.openai.com/v1/models")
  (values (com.inuoe.jzon:parse body) status headers))
```

Both functions use the guest CA bundle and a 60-second cancellation context.  CURL limits connection establishment to 15 seconds.  Cancellation closes blocked TLS I/O.  Plain HTTP socket reads do not observe that context, so a plain HTTP request can continue until a socket operation returns.

## Responses API

LISPM-OPENAI:CREATE-RESPONSE sends one non-streaming POST to the OpenAI Responses endpoint.  The caller supplies an API key string and a Jzon request hash table:

```lisp
(let ((request (make-hash-table :test 'equal)))
  (setf (gethash "model" request) "gpt-4.1-nano"
        (gethash "input" request) "Explain dynamic binding in Common Lisp."
        (gethash "store" request) nil)
  (lispm-openai:create-response
   api-key request
   :timeout 60
   :ca-file "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT"))
```

The function returns the parsed response hash table and the HTTP x-request-id header as two values.  It sends the caller's request fields unchanged.  The caller selects the model and storage policy and examines the response's status and output fields.  STREAM must be absent or NIL.  The client performs no automatic retry.

Certificate verification is required.  Session tickets retain the peer certificate chain, which each resumed connection checks against its current trust store, validity time, hostname, purpose, and verification depth.  Redirects and Drakma header logging are disabled.  The function rejects an empty key or a key containing carriage returns or newlines.  The [OpenAI API overview](https://developers.openai.com/api/reference/overview) describes Bearer authentication and request IDs.

## Certificate-signature cache

The TLS verifier caches successful certificate-signature checks in Lisp memory.  Each entry expires 24 hours after verification.  Cache hits preserve that original expiration time.  The cache retains at most 1,024 entries and evicts the oldest verified entry when full.  Failed signature checks enter no cache.

A SHA-256 key covers the signed bytes, signature bytes, signature algorithm and parameters, and issuer public-key algorithm and bytes.  EC curve parameters form part of the parsed public-key algorithm.  The verifier copies those inputs before hashing and verification.  It stores the digest as an octet-vector key.

Each connection still checks the hostname, certificate dates, current trust roots, requested purpose, verification depth, and chain constraints.  Resumed TLS sessions repeat those checks.  The handshake's CertificateVerify signature uses the current handshake transcript.  Configured revocation processing follows its existing path.

The cache clears on verifier load and on first use after a new Mezzano boot or snapshot restoration.  Explicit clearing also prevents pending verifications from inserting into the cleared cache:

```lisp
(pure-tls:clear-certificate-signature-cache)
```

## Deadlines and errors

TIMEOUT is a positive real duration in seconds, defaulting to 60.  Its cancellation context starts after JSON request encoding and inherits an existing caller context.  Connection establishment receives the smaller of 15 seconds and the remaining request time.  The TLS cancellation monitor aborts the socket when the context expires.

Cancellation checks occur at library boundaries.  CPU-bound certificate verification can continue after the socket closes, so TIMEOUT does not guarantee that the Lisp call returns within that duration.  Cancellation also does not establish whether the remote service processed a request.

An HTTP status other than 200 signals LISPM-OPENAI:HTTP-ERROR.  Its readers are:

| Reader | Value |
|---|---|
| HTTP-ERROR-STATUS | Integer HTTP status. |
| HTTP-ERROR-REQUEST-ID | Request ID string, or NIL when absent. |
| HTTP-ERROR-BODY | Response body as an octet vector. |

The condition's printed report includes the status and request ID.  A caller can parse its body with Jzon.  Transport, certificate, cancellation, JSON, and connection-close errors propagate.  An HTTP 200 response can still report an application status other than completed.

## Credentials and persistence

The caller owns the API key string.  CREATE-RESPONSE overwrites its Authorization string when the call exits.  Lisp allocation and library internals can retain additional copies.

Mezzano snapshots save the Lisp heap.  A snapshot taken after supplying a credential can therefore contain that credential, including copies beyond the caller's string.  Paging can write copies to the image without a snapshot.  Retained evaluation source, input, and debugger locals can also retain credentials.  The SBCL test runner accepts a key through standard input and ends the process after the test.  The test guide describes the [SBCL runner](../tools/https/README.md#openai-request) and the [guest test procedure](../tools/https/README.md#authenticated-guest-test), which restores a complete pre-credential image after the request.

## Tests and limits

The combined guest test covers entropy, atomic operations, fractional deadlines, cancellation during blocked input and handshakes, cancellation-monitor cleanup, HTTP close failures, certificate verification, and invalid-credential response handling:

```lisp
(load "SYS:SOURCE;TOOLS;HTTPS;TEST-MEZZANO.LISP")
(lispm-https-guest-test:run
 :ca-file "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT")
```

The combined guest test passed, including full and resumed handshakes with one chain verification per connection, rejection of mismatched hostnames and empty trust stores, rejection of a ticket without peer certificates, HTTP 401 JSON parsing, and normal TLS close.  Authenticated Responses requests passed under both Mezzano and SBCL, returning HTTP 200, completed status, and "Lisp HTTPS works."  The guest request used gpt-4.1-nano-2025-04-14, with 15 input tokens and 6 output tokens.  TCP half-close tests, a fresh image boot, and snapshot restoration also passed.

The Listener functions passed a chunked HTTP GET returning text, an HTTPS GET returning an HTTP 401 body as octets, and completions with the default and explicit models.  In-memory tests also cover chunk decoding with raw and already chunked streams.

The HTTPS GET to example.org returned HTTP 200 after the x86-64 arithmetic improvements.  Headless Chromium submitted COMPLETE and CURL through one Web Listener session.  COMPLETE returned text.  CURL displayed the body, status, and headers for both an HTTPS text response with status 200 and an OpenAI octet response with status 401.  All three evaluations returned without a debugger stop or browser error.

Before signature caching, twenty offline checks of the captured three-certificate chain after restoring the saved image had a 90-millisecond median, a 102.5-millisecond mean, and a range of 90–190 milliseconds on x86-64 QEMU with KVM.  Each call allocated approximately 53.65 MB.  These timings exclude certificate parsing, hostname checking, network traffic, and TLS key exchange.  They include collection and scheduling during the call.  The [arithmetic measurements](../tools/long-division.md#runtime-arithmetic) describe the test and its limits.

With signature caching enabled, the same chain and 150 roots took 70–190 milliseconds per cold-cache call and allocated approximately 31.31 MB.  Five batches of 100 warm-cache calls averaged 11.3 milliseconds per call and allocated approximately 64.3 KB per call.  These timings include current chain-policy checks, collection, and scheduling.  Snapshot restoration required fresh signature verification before reuse.  The cache's expiration, input-change, capacity, eviction, concurrency, and policy tests passed in Mezzano.

These tests cover the stated endpoints and error cases.  Streaming responses, certificate revocation, the upstream TLS test suite, ARM64 execution, and bare-metal entropy remain untested.
