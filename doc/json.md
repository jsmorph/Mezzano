# JSON

[Jzon](https://github.com/jsmorph/jzon/tree/8f8099ae762d54de9cbe2a084fc52ae3de96ee7d) provides JSON parsing and generation through the `COM.INUOE.JZON` package.  New images load Jzon during startup.  The [installation guide](installation.md#json-libraries) specifies its source checkouts.  Load the system in an existing image after installing those sources:

```lisp
(asdf:clear-source-registry)
(asdf:load-system :com.inuoe.jzon)
```

## Reading and writing

PARSE accepts a string, a UTF-8 octet vector, a character stream, a UTF-8 binary stream, or a pathname.  STRINGIFY returns a JSON string, or writes JSON to its `:stream` argument.

```lisp
(let ((object (com.inuoe.jzon:parse "{\"input\":\"Hello\",\"stream\":false}")))
  (gethash "stream" object))
;; NIL, T

(com.inuoe.jzon:stringify #(t nil null))
;; "[true,false,null]"
```

GETHASH's second value distinguishes a present key whose value is NIL from a missing key.  The JSON representation uses these types:

| JSON | Lisp |
|---|---|
| Object | Hash table with EQUAL keys. |
| Array | Vector. |
| String | String. |
| Integer | Integer, including bignums. |
| Fraction or exponent | Double float. |
| `true` | T. |
| `false` | NIL. |
| `null` | The symbol CL:NULL. |

The token `-0` becomes negative double-float zero.  An empty vector represents `[]`.  An empty hash table represents `{}`.  String keys preserve their spelling and case.

```lisp
(let ((request (make-hash-table :test 'equal)))
  (setf (gethash "input" request) "Hello"
        (gethash "stream" request) nil)
  (com.inuoe.jzon:stringify request))
```

Object member order follows hash-table iteration.  Code requiring a particular output order can use Jzon's writer:

```lisp
(with-output-to-string (stream)
  (com.inuoe.jzon:with-writer (writer :stream stream)
    (com.inuoe.jzon:with-object writer
      (com.inuoe.jzon:write-key writer "input")
      (com.inuoe.jzon:write-value writer "Hello")
      (com.inuoe.jzon:write-key writer "stream")
      (com.inuoe.jzon:write-value writer nil))))
```

## Limits and errors

PARSE defaults to a nesting limit of 128 and a string-length limit of 1,048,576 characters.  A caller can set smaller limits:

```lisp
(com.inuoe.jzon:parse "{\"input\":\"Hello\"}"
                      :max-depth 16
                      :max-string-length 65536)
```

These limits apply to nested arrays and objects and to each string, including object keys.  Total input size requires a separate caller limit.  The default parser rejects comments, trailing commas, and additional top-level values.  Jzon defines `COM.INUOE.JZON:JSON-PARSE-ERROR` for syntax errors and its subtype `COM.INUOE.JZON:JSON-PARSE-LIMIT-ERROR` for configured limits.  This release can signal `TYPE-ERROR` for empty input.  The writer detects recursive object references and signals `COM.INUOE.JZON:JSON-RECURSIVE-WRITE-ERROR`.

Decimal conversion can signal `FLOATING-POINT-OVERFLOW` or `FLOATING-POINT-UNDERFLOW`.  The installed revision bounds extreme exponents before constructing a power of ten.  Values near binary64 rounding boundaries use Jzon's existing conversion.  Zero retains its sign regardless of exponent size.  Mezzano masks hardware floating-point overflow by default.  Conversion paths using FLOAT can then return signed infinity for an out-of-range number.  Callers requiring finite results must reject infinities.

[Upstream API documentation](https://github.com/Zulu-Inuoe/jzon/blob/v1.1.4/README.md) describes incremental parsing, writer methods, and additional serialization options.

## Tests

The repository's Lisp API tests cover JSON type distinctions, character and UTF-8 streams, Unicode escapes, finite numeric round trips, extreme exponents, rounding boundaries, malformed input, and limits.  The corpus runner reads the JSONTestSuite fixtures included in the pinned Jzon checkout.  Files prefixed `y_` must parse.  Files prefixed `n_` must fail.  Files prefixed `i_` permit either result and receive separate counts.

Run from a guest Listener:

```lisp
(load "SYS:SOURCE;TOOLS;TEST-JSON.LISP")
(mezzano-json-test:run)
(mezzano-json-test:run-corpus
 (merge-pathnames "jzon/JSONTestSuite/test_parsing/" (user-homedir-pathname)))
```

The x86-64 QEMU guest passed the API tests, a fresh image boot, and the API and corpus tests after snapshot restoration.  The corpus accepted all 95 required-valid inputs and rejected all 188 required-invalid inputs.  Of 35 implementation-defined inputs, it accepted 3 and rejected 32.  The tests include all 66 Unicode noncharacters through native character construction and UTF-8 decoding.  ARM64 execution remains untested.

## HTTP clients

Jzon supplies JSON encoding and decoding.  An HTTP client supplies transport, headers, status handling, and response framing.  Mezzano's existing HTTP filesystem client supports plaintext GET requests.  The [HTTPS and OpenAI reference](https.md) describes the Drakma/pure-tls integration, reusable Responses API, and current guest test status.
