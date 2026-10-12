# Document Examiner missing-topic errors

## Decision and scope

The user approved correction of missing-topic recovery on 2026-10-12.  A saved browser reference can outlive its catalog topic.  Previously, the guest signaled an ordinary error, which entered SWANK's debugger instead of returning a service error that the browser could distinguish from a transport failure.

Use a Document Examiner condition that inherits `MEZZANO.DEBUG:DEBUGGER-SERVICE-ERROR` and supplies the reason `:missing-topic`.  Preserve the existing human-readable report for local Lisp use and command assistance.  Signal it from failed exact lookup and topic resolution.  The existing SWANK reply handler then returns `(:error :missing-topic)`.  Ambiguous names, invalid requests, and transport failures retain their existing behavior.

The browser can retain and identify the unavailable reference while allowing other topics to load.  It must distinguish this reason from transport failures and retain a retry operation for the latter.

## Tests

- [x] Missing IDs in `:topic`, `:contents`, and `:overview` return `:missing-topic` through SWANK.
- [x] The same session accepts a subsequent catalog query without creating a stop or evaluation job.
- [x] Command assistance preserves its missing-topic error text.
- [x] Chromium tests restore mixed valid and unavailable references and distinguish transport failures.
- [x] The cold image builds and boots with the correction.

The catalog and transport test also include the approved Peek guide addition, bringing the product catalog to 14 books.  Guest compilation and load succeeded.  The transport suite passed with 14 documents, 110 topics, and 83 references, including catalog structure, search, commands, Unicode cursor offsets, and release of its session.  The logs are `examiner-missing-topic-load.log` and `examiner-missing-topic-test.log` in the development boot directory.  The Chromium test passed missing-root and missing-heading recovery, retained bookmarks, and separate transport-error recovery.  It released its session.  The subsequent fresh x86-64 build and CI boot passed, with QEMU exit status 3 and the CI success marker.  The catalog and transport suite passed again after restoring the development snapshot.  Evidence is peek-pager-build.log, peek-pager-ci-serial.log, peek-pager-ci.exit, and peek-examiner-restored-test.log.

## Literal documentation text

The missing-topic browser test exposed `#1=` and `#1#` in a three-line code block.  `JOIN` used `FORMAT` with `~{~A~}` on a list containing the same separator string twice.  A guest call with `*PRINT-CIRCLE*` true and a repeated line string reproduced labels for both the line and newline: `#1=line#2=` followed by a newline and `#1##2##1#`.  Host SBCL produced the expected literal text from the same format call.  The observed failure is specific to the guest printer path.

Replace formatted object output in `JOIN` with `WRITE-STRING` calls for each input string and separator.  Documentation joining requires literal characters and must not depend on printer settings.  Preserve empty input, single input, and empty-separator behavior.  The focused guest test binds `*PRINT-CIRCLE*` true and reuses the same line and separator objects.  The catalog test compares the Getting started code block with its three source lines, and a browser test checks the rendered text.

- [x] The shared-string guest test and Examiner suite pass after recompilation and catalog reload.
- [x] Chromium displays the three command lines without printer labels.

The updated module compiled and loaded, and the catalog was rebuilt.  The focused joining assertions, exact Getting started code block, and Examiner suite passed with 14 books, 110 topics, and 83 references.  The test released its session.  The logs are `examiner-join-before.log`, `examiner-join-load.log`, and `examiner-join-test.log` in the development boot directory.

The focused Chromium check matched all three source command lines, reported no browser errors, and released its session.
