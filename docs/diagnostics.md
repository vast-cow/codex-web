# Local diagnostics

Diagnostics are off by default. They add no telemetry endpoint and leave Sentry disabled.
Enable server diagnostics before starting the server:

```sh
CODEX_WEB_LOG_LEVEL=trace CODEX_CLI_PATH="$(command -v codex)" node src/server/main.js 2>server-diagnostics.log
```

Structured records go to stderr as one JSON object per line. Upstream software may
also write to stderr; select JSON records with `source: "server"`. Do not assume
other upstream output has the same privacy guarantees. Levels are `error`, `warn`,
`info`, `debug`, `trace`; each includes less verbose levels. Use `debug` for
lifecycle investigation and `trace` to see queue, send, receive and port traffic.
Unset `CODEX_WEB_LOG_LEVEL` (or use `off`) and restart to disable.

In browser DevTools, enable logging and reload:

```js
localStorage.setItem("codex-web:logLevel", "trace");
location.reload();
```

This setting survives reconnect reloads. Disable with
`localStorage.removeItem("codex-web:logLevel")` and reload. Browser JSON records
use `console.debug`; enable the DevTools Verbose filter. Export locally with:

```js
copy(window.codexWebDiagnostics.export()); // Chrome DevTools copy helper
window.codexWebDiagnostics.clear();
```

Paste the returned JSON into a local file. Other browsers can evaluate
`window.codexWebDiagnostics.export()` and copy the returned string. No data is
uploaded. Clear removes the in-memory and persisted tail, not console history.

The buffer holds at most 400 records and 110,000 bytes measured conservatively as
twice the serialized character count. Persistence is batched every two seconds
and flushed before intentional reload and on pagehide. `dropped` counts evicted
records; `suppressed` counts sampled trace records. For each trace event, the first
20 occurrences and every hundredth occurrence are retained. Application queues
are never bounded, retried, or dropped by the logger. Slow warnings report the
oldest pending request every ten seconds after ten seconds; they never settle it.
Storage and sink errors are swallowed; blocked or full storage can prevent tail
retention. With unavailable sessionStorage, identity continuity is unavailable.
Some browsers copy sessionStorage when duplicating tabs: page and connection IDs
still distinguish those tabs even when their session IDs match.

## Reading a capture

Records have timestamp, source, level, event and runtime-local sequence number.
Join on `connectionId`, then `requestId` or `portId`, never on a local request ID
alone. `sessionId` survives reload; `pageId` changes each load. The server adds its
`serverId` on every record, and `renderer.ready` associates connection, window and
webContents IDs. Metadata in the WebSocket handshake is bounded and validated;
it is diagnostic context, not authentication. No Electron or app-host payloads
are changed.

Durations use each runtime's monotonic clock. Do not subtract browser and server
wall times. `transport.send-api` means only that send returned; the peer's
`transport.receive` or `ipc.dispatch` provides evidence of receipt. On the server,
receipt is logged before waiting for renderer readiness; dispatch afterward
provides decoded request/port IDs. A long `renderer.wait-complete` duration points
to initialization waiting. `handler.start` / `handler.complete` bracket invoke
and directory work. `request.settle` records browser settlement.

Illustrative abbreviated trace (IDs shortened here only):

```text
browser connection=C1 page=P1 queue.enqueue request=ipc_bridge_1
browser connection=C1 transport.send-api request=ipc_bridge_1
server  connection=C1 server=S1 renderer.ready windowId=2 webContentsId=2
server  connection=C1 ipc.dispatch request=ipc_bridge_1
server  connection=C1 handler.start request=ipc_bridge_1
browser connection=C1 socket.close code=1006 pending=1
browser connection=C1 request.disconnect request=ipc_bridge_1
server  connection=C1 socket.close
server  connection=C1 renderer.cleanup
browser reconnect.scheduled
browser connection=C2 socket.attempt page=P1
browser connection=C2 socket.open
browser connection=C2 page.reload
browser connection=C3 socket.attempt page=P2
server  connection=C3 server=S2 renderer.ready windowId=2 webContentsId=2
```

Collect the browser export immediately after recovery and the server stderr from
before the interruption through recovery. Filter matching connection IDs, keeping
server-start records to distinguish backend restarts. The browser retains old
page events with their original page IDs and sequences.

## Privacy and limits

Metadata uses explicit field and value allowlists: generated IDs, counters,
booleans, normalized route categories and numeric application versions. No raw
IPC arguments, port data, channel names, URLs, queries, file names, filesystem
paths, upload data, credentials or prompt content are logged. Error text, stacks
and close reasons are omitted entirely, rather than relying on heuristic secret
redaction. Error event names identify stages. This sacrifices detailed exception
messages to keep arbitrary application data out of captures.

Hooks run when the diagnostics dependency of the shim evaluates. They cannot
observe failures that prevent that module or its dependencies loading, or errors
before it evaluates. The HTTP events can help identify asset requests returning
HTML via SPA fallback. They report route category, status, duration and a
normalized content category. The server's uncaught-exception monitor and socket
error monitor observe errors without consuming them or changing exit behavior.
Versions are reported when already available; no CLI version command runs.

No instability root cause has been established. The existing combined browser
parse/dispatch catch demonstrably mislabeled listener exceptions as parse errors;
its reporting is separated while keeping listener iteration and the outer catch
behavior. No independent application defect is fixed here. The Statsig fallback
patch and reconnect cleanup/reload strategy are unchanged. Investigate these
possibilities using evidence:

- Startup: `renderer.factory-wait`, `renderer.create`, `renderer.ready`, or
  `renderer.initialize-failure`, plus browser/resource errors.
- Transport: compare enqueue, send-api, receipt, close, cleanup and reload events.
- Handler stall: readiness completes, handler starts, slow warnings continue,
  handler completion is absent.
- Port stall: registration, listener/queue/flush events and sampled traffic counts
  distinguish waiting for registration from forwarding/listener failures.

## Validation and manual checklist

Run `npm run test:diagnostics`, `npm run build:server`, and
`npm run build:browser`. The last command requires prepared upstream assets.
The focused tests use TypeScript's transpiler and isolated browser mocks; they do
not replace a real browser/backend exercise. Server runtime diagnostics live
under `src/server`, covered by the existing package JavaScript allowlist.

With both loggers enabled, check:

1. Initial load and deep-link refresh: route category, resource status, readiness.
2. Back/Forward: history/pop and memory-route events, without query/path content.
3. Offline/online and backend restart: pending rejection, port cleanup, reconnect,
   intentional reload, retained tail, new page/connection/server identities.
4. Background/foreground: visibility state and request ages.
5. Two tabs issuing overlapping local request IDs: distinct connection/page IDs.
6. Picker cancel, successful upload, upload failure and directory failure:
   outcome/timing records with no filenames or paths.
7. At trace level, exercise app-host RPC: port registration, listener flush,
   traffic and disconnect; use a throwing test listener and malformed JSON only
   in an isolated development session to compare failure stages.
