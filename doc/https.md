# HTTPS and OpenAI requests

Mezzano's HTTPS integration uses Drakma for HTTP, pure-tls for TLS 1.3, Ironclad for cryptography, and [Jzon](json.md) for JSON.  TLS and cryptographic operations execute in Lisp.  The guest obtains entropy from a VirtIO entropy device and trust anchors from a PEM CA bundle.

The libraries compiled and loaded on x86-64 QEMU.  Guest tests passed full and resumed TLS handshakes, certificate rejection checks, blocked-I/O cancellation, HTTP cleanup, an unauthenticated GET, and an invalid-credential POST.  Authenticated guest inference remains untested.  The reusable Responses client passed authenticated inference under SBCL on Linux.

## Installation

The [HTTPS installation and test guide](../tools/https/README.md) specifies pinned sources, portability edits, guest source preparation, the QEMU entropy device, and CA installation.  After preparing those files, load the client in the guest:

```lisp
(load "SYS:SOURCE;TOOLS;HTTPS;LOAD-MEZZANO.LISP")
```

The loader gives the separate HTTPS dependency directory precedence over MBuild's older libraries.  Compilation can take substantial time.  The CA bundle is a host-maintained file copied into the guest's accessible filesystem.  Refresh that copy when the host's trust anchors change.

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

Mezzano snapshots save the Lisp heap.  A snapshot taken after supplying a credential can therefore contain that credential, including copies beyond the caller's string.  Retained evaluation source, input, and debugger locals can also retain credentials.  The SBCL test runner accepts a key through standard input and ends the process after the test.  The [test guide](../tools/https/README.md#openai-request) describes that runner.

## Tests and limits

The combined guest test covers entropy, atomic operations, fractional deadlines, cancellation during blocked input and handshakes, cancellation-monitor cleanup, HTTP close failures, certificate verification, and invalid-credential response handling:

```lisp
(load "SYS:SOURCE;TOOLS;HTTPS;TEST-MEZZANO.LISP")
(lispm-https-guest-test:run
 :ca-file "SYS:HOME;HTTPS-CA-CERTIFICATES.CRT")
```

The combined guest test passed, including full and resumed handshakes with one chain verification per connection, rejection of mismatched hostnames and empty trust stores, rejection of a ticket without peer certificates, HTTP 401 JSON parsing, and normal TLS close.  The corresponding SBCL tests passed, including an authenticated Responses request that returned HTTP 200, completed status, and "Lisp HTTPS works."

These tests cover the OpenAI endpoint and the stated error cases.  Streaming responses, certificate revocation, the upstream TLS test suite, ARM64 execution, and bare-metal entropy remain untested.
