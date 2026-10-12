# Web interface tests

The Python tests exercise HTTP and SWANK transport behavior.  The Chromium drivers exercise browser interaction against a running Web server and Mezzano guest.  Font and layout measurements have separate tools in the [font testing guide](fonts/README.md).

## HTTP and SWANK tests

Python 3.13 or later is required.  From the Mezzano checkout:

```sh
uv run --no-python-downloads --python python3 tools/swank/web/test_server.py
```

The isolated tests create local fake peers and HTTP servers.  They exercise framing, encoding, typed arguments, request-origin checks, error classification, connection cleanup, and session serialization.  They do not require a running guest.

The live suite connects to SWANK on loopback.  The port is configurable:

```sh
uv run --no-python-downloads --python python3 tools/swank/web/test_server.py \
  --live-port 4005
```

It starts a temporary HTTP server and exercises evaluation, Unicode output offsets, returned values, replay, interactive input, condition stops, frame and local inspection, restart continuation, interruption, and child stops.  Its cleanup removes the functions, classes, jobs, stops, and session it created.

## Browser tests

The drivers require Node 24 or later and Chromium.  They use Node's built-in WebSocket API and require no npm packages.  `CHROMIUM` selects the browser executable when its name is not `chromium`.

The first argument is the Web server URL.  The second is the output directory for screenshots and diagnostics.  These examples target a server on loopback:

```sh
node tools/swank/web/test-browser.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-listener-test
node tools/swank/web/test-document-examiner.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-examiner-test
node tools/swank/web/test-private-document.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-private-document-test
node tools/swank/web/test-peek.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-peek-test
```

The Listener driver covers command assistance, evaluation and input history, guest file commands, Unicode presentations, interactive input, debugger commands and restarts, retained-request recovery, and release reconciliation.  The Examiner driver covers topics, mouse operations, candidate history, search options, bookmarks, named viewers, reload, reading positions, and print dispatch.  The private-document driver covers command menus, defaults, bookmark order, Save replay, Load, Read, Hardcopy, and file cleanup.

Each driver starts a separate headless browser profile and removes that profile on exit.  Successful runs release their owned guest sessions and fixtures.  Failed interactions save session state and fixture identities for inspection and cleanup.  The Listener and private-document tests create guest files and evaluation jobs.  They require a writable guest home directory.  Other clients' retained objects must remain untouched.

Lost-reply tests discard a completed HTTP response after server dispatch.  They exercise saved-request recovery rather than every possible transport failure point.  Print tests intercept print dispatch.  They do not verify physical printer output.  Browser screenshots require separate comparison before supporting a visual-fidelity claim.

## Peek and activity navigation

The Peek driver tests SELECT navigation, input preservation, product-guide links, live process fields, 980-pixel column bounds with a 160-character name, Describe, retained-stop selection, Show Processes, and continuation/cleanup of its own condition fixture.  It creates one named worker and two retained evaluations, then releases their objects and its session.  The `--navigation-only` option exercises activity selection and product documentation without creating guest jobs.

The separate fixture driver replaces every API response before the application loads, so it requires the static Web files but no guest.  It exercises duplicate names, text rendering, expired-session stop links, delayed nonoverlapping requests, failed-sample retention, automatic retry after a released-stop error, and reconnection after a transport error.  It also verifies polling suppression in Help mode, another activity, and a simulated hidden-tab event.  The latter does not establish scheduling behavior for every browser's background-tab throttling.

```sh
node tools/swank/web/test-peek-fixtures.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-peek-fixtures
```

The fixture capture includes original process strings for selected font and position comparisons.  It labels its results as fixture-only and records zero guest requests.  The [Peek layout comparison](fonts/compare-peek-layout.py) measures those selected rectangles against the recorded source font rasters and original positions.

## Missing documentation references

The focused test retains an absent document, an absent child heading, and a valid document in one viewer.  It checks unavailable entries, the valid content, bookmark preservation, and reload.  Separate constructed responses verify that a transport failure remains a connection error and that a later successful lookup replaces an unavailable entry.

```sh
node tools/swank/web/test-missing-document.mjs \
  http://127.0.0.1:8765/ /tmp/mezzano-missing-document-test
```

The test creates no guest jobs or files and releases its session.  Its four live missing-topic requests must produce HTTP 409 responses.  Constructed error responses do not generate browser network errors.  The driver rejects unexpected browser errors and preserves its session record on failure.
