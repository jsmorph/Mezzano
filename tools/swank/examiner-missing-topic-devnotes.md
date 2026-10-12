# Document Examiner missing-topic errors

## Decision and scope

The user approved correction of missing-topic recovery on 2026-10-12.  A saved browser reference can outlive its catalog topic.  Previously, the guest signaled an ordinary error, which entered SWANK's debugger instead of returning a service error that the browser could distinguish from a transport failure.

Use a Document Examiner condition that inherits `MEZZANO.DEBUG:DEBUGGER-SERVICE-ERROR` and supplies the reason `:missing-topic`.  Preserve the existing human-readable report for local Lisp use and command assistance.  Signal it from failed exact lookup and topic resolution.  The existing SWANK reply handler then returns `(:error :missing-topic)`.  Ambiguous names, invalid requests, and transport failures retain their existing behavior.

The browser can retain and identify the unavailable reference while allowing other topics to load.  It must distinguish this reason from transport failures and retain a retry operation for the latter.

## Tests

- [x] Missing IDs in `:topic`, `:contents`, and `:overview` return `:missing-topic` through SWANK.
- [x] The same session accepts a subsequent catalog query without creating a stop or evaluation job.
- [x] Command assistance preserves its missing-topic error text.
- [ ] Chromium tests restore mixed valid and unavailable references and distinguish transport failures.
- [ ] The cold image builds and boots with the correction.

The catalog and transport test also include the approved Peek guide addition, bringing the product catalog to 14 books.  Guest compilation and load succeeded.  The transport suite passed with 14 documents, 110 topics, and 83 references, including catalog structure, search, commands, Unicode cursor offsets, and release of its session.  The logs are `examiner-missing-topic-load.log` and `examiner-missing-topic-test.log` in the development boot directory.  Browser and cold-image tests remain separate checkpoints.
