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

The loader defines COMPLETE and CURL in CL-USER, the Listener's default package.

### COMPLETE

COMPLETE sends one synchronous request to the OpenAI Responses endpoint.  It reads the configured private key and sets store to false.

```lisp
(complete "Explain dynamic binding in Common Lisp.")

(complete '((:role :developer :content "Use Common Lisp examples.")
            (:role :user :content "Explain dynamic binding."))
          :model "gpt-4.1-nano"
          :max-output-tokens 500
          :temperature 0.3)
```

INPUT accepts a prompt string, a nonempty proper list of message property lists, or a vector of Responses input objects.  Each message property list contains exactly :ROLE and :CONTENT.  Roles are :SYSTEM, :DEVELOPER, :USER, or :ASSISTANT.  Content is a string.  Either property order is accepted.  Native Responses objects use [Jzon's representation](json.md): hash tables with string keys and vectors for arrays.  They support structured content, previous response items, and function-call results.  COMPLETE preserves caller-owned input and schema data.

```lisp
(complete input
          &key (model "gpt-4.1-nano") instructions max-output-tokens
               temperature top-p reasoning-effort verbosity text-format
               tools (tool-choice :auto) (parallel-tool-calls nil)
               (timeout 60))
```

| Keyword | Accepted value and effect |
|---|---|
| :MODEL | Nonempty model name string.  Defaults to gpt-4.1-nano. |
| :INSTRUCTIONS | Instruction string for this request. |
| :MAX-OUTPUT-TOKENS | Integer of at least 16.  Limits generated output, including reasoning tokens. |
| :TEMPERATURE | Finite real number from 0 through 2. |
| :TOP-P | Finite real number from 0 through 1. |
| :REASONING-EFFORT | :NONE, :MINIMAL, :LOW, :MEDIUM, :HIGH, :XHIGH, or :MAX.  Maps to reasoning.effort. |
| :VERBOSITY | :LOW, :MEDIUM, or :HIGH.  Maps to text.verbosity. |
| :TEXT-FORMAT | Jzon object for text.format, including JSON Schema configuration. |
| :TOOLS | List or vector of Jzon tool-definition objects. |
| :TOOL-CHOICE | :AUTO, :NONE, :REQUIRED, or a nonempty string naming a required function tool. |
| :PARALLEL-TOOL-CALLS | T permits multiple function calls.  NIL sends JSON false. |
| :TIMEOUT | Finite positive duration in seconds.  Defaults to 60.  Uses the cancellation semantics below. |

The [Responses request reference](https://developers.openai.com/api/reference/python/resources/responses/methods/create) specifies these API fields.  Individual models accept different settings.  The service validates model support and native JSON schemas.  Optional generation settings default to omission, and NIL omits them.  Numeric zero is sent.  Rational sampling values such as 1/2 are converted to double floats.  Tool-choice and parallel-call controls are sent with their stated defaults.

The model argument uses :MODEL.  The former second positional model argument must be changed to that keyword form.

COMPLETE returns four values:

| Value | Representation |
|---|---|
| Text | Output-text parts concatenated in response order, or NIL when absent.  JSON output remains a string. |
| Response | Complete parsed response hash table, including output items, model, status, and usage. |
| Request ID | HTTP x-request-id string, or NIL when absent. |
| Function calls | Ordered list of property lists containing :CALL-ID, :NAME, and :ARGUMENTS, or NIL.  Arguments are parsed JSON objects. |

An empty output-text part produces an empty string.  A response can contain both text and function calls.  The response object preserves the original argument strings and all other output items.

```lisp
(multiple-value-bind (text response request-id calls)
    (complete "Explain dynamic binding." :max-output-tokens 500)
  (values text (gethash "usage" response) request-id calls))
```

### Function calls

Tool definitions contain JSON data.  The caller supplies functions and decides which requests to execute.  This definition asks the model for a symbol name:

```lisp
(let ((tools
        (com.inuoe.jzon:parse
         "[{\"type\":\"function\",\"name\":\"lookup_symbol\",
            \"description\":\"Look up documentation for a Lisp symbol.\",
            \"strict\":true,
            \"parameters\":{\"type\":\"object\",
              \"properties\":{\"name\":{\"type\":\"string\"}},
              \"required\":[\"name\"],\"additionalProperties\":false}}]")))
  (complete "Look up CONDITION-WAIT."
            :tools tools :tool-choice "lookup_symbol"))
```

A returned call has this shape:

```lisp
(:call-id "call_123" :name "lookup_symbol" :arguments arguments-hash-table)
```

The caller obtains the symbol name with `(gethash "name" (getf call :arguments))`.  Strict function schemas require all properties to be required and additionalProperties to be false on each object.  Optional values use nullable types.  The [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling) specifies tool definitions, selection, and result messages.

For another request, the caller appends the response's full output vector to its previous input vector, followed by function_call_output objects.  Each result object contains the matching call_id and an output string.  Preserve output order and reasoning items, including encrypted reasoning content.  Supply the desired instructions, tools, and generation options on the next COMPLETE call.  The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses) describes continuation with store false.

COMPLETE returns function calls to the caller.  Tool execution and subsequent requests belong to the calling Lisp program.

### Completion errors

Invalid Lisp argument types, ranges, and message structure signal before sending the request.  An HTTP rejection signals LISPM-OPENAI:HTTP-ERROR, preserving the service's response body.  TLS, transport, cancellation, and JSON response-decoding conditions propagate.

An incomplete response, refusal, malformed response or function call, or missing text and function calls signals LISPM-OPENAI:COMPLETION-ERROR.  Duplicate function-call IDs and arguments that fail to decode as a JSON object constitute malformed calls.

| Reader | Value |
|---|---|
| COMPLETION-ERROR-REASON | :INCOMPLETE, :STATUS, :REFUSAL, :MALFORMED-RESPONSE, :MALFORMED-TOOL-CALL, or :MISSING-OUTPUT. |
| COMPLETION-ERROR-RESPONSE | Parsed response, including any partial output. |
| COMPLETION-ERROR-REQUEST-ID | HTTP request ID, or NIL. |
| COMPLETION-ERROR-CAUSE | Original argument-decoding condition, or NIL. |

These readers belong to LISPM-OPENAI.  The condition's report includes its reason and request ID.  :STATUS denotes a response whose status differs from completed and incomplete.  Inspect the response for the service's status, error, and incomplete_details fields.

Each call reads the first line of `openai-api.key` in USER-HOMEDIR-PATHNAME.  The file stays outside the repository and uses mode 0600 on the host.  COMPLETE overwrites its key string on exit, subject to the persistence limits below.

### CURL

```lisp
(curl "https://example.org/")
```

CURL performs GET and returns three values: the body, integer HTTP status, and header alist.  Drakma decodes text/* bodies as strings using the response's charset.  Other content types, including application/json, return octet vectors.  CURL decompresses encoded content and follows at most five redirects.  A 404 or another HTTP error status is returned with its body and headers.  Transport and TLS errors signal conditions.

```lisp
(multiple-value-bind (body status headers)
    (curl "https://api.openai.com/v1/models")
  (values (com.inuoe.jzon:parse body) status headers))
```

CURL uses the guest CA bundle, a 60-second cancellation context, and a 15-second connection limit.  Cancellation closes blocked TLS I/O.  Plain HTTP socket reads do not observe that context, so a plain HTTP request can continue until a socket operation returns.

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

TLS client construction installs socket cancellation and failure cleanup before context, trust-store, or client-credential initialization.  It inherits the caller's cancellation context when no explicit context is supplied.  CA loading checks cancellation between certificates.  A request that disables verification does not initialize the default CA store.  The default context retains its verification-required policy and loads roots when a later request requires them.

Cancellation checks occur at library boundaries.  CPU-bound certificate verification can continue after the socket closes, so TIMEOUT does not guarantee that the Lisp call returns within that duration.  Stop-the-world garbage collection also delays the caller and deadline threads.  A cold x86-64 QEMU test measured 5.45–5.51-second GC pauses during 0.1-second cancellation requests.  Constructors without collection returned in 0.11–0.12 seconds in that repeated test.  These observations do not establish a wall-time bound.  Cancellation also does not establish whether the remote service processed a request.

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
