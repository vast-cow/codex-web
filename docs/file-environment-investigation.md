# File environment investigation

## Evidence and limits

Local server logs (`npm-run-server*.txt`, not committed) contain `fs/readFile
requires an environmentId` with `conversationId=none`, alongside separate
`No such file or directory` responses. They do not record the failing request's
host, path, parameters, or caller stack. The exact initiating operation remains
unidentified. No context injection is justified by this evidence.

The browser bridge's `ipcRenderer.invoke` in `src/browser/shim.ts` forwards ordinary
messages to `invokeMain(channel, args)` unchanged. Its WebSocket uses the page's
origin. It does not select a file environment. The web backend transports IPC to
the extracted Electron main handler; desktop callers use Electron IPC directly.
Both paths use the extracted application's file adapters and request clients.
No browser-specific loss of environment context was confirmed.

In the currently extracted application:

- The hosted file adapter (`fue.readFile` in `.vite/build/main-CqEoQDOU.js`)
  validates `environmentId` using `mg`, then passes the original parameters
  through `pg` to `fs/readFile`.
- The cloud text-file reader (`webview/assets/text-file-storage-*.js`) obtains
  `environmentId` from `cloudFileAccess` and includes it in metadata/read requests.
- The cloud download helper (`webview/assets/save-cloud-file-copy-*.js`)
  uses supplied environment context or resolves the conversation's environment;
  it rejects unavailable cloud context.
- Several shared upstream callers send path-only requests, including pasted-text
  registry loading, plugin inventory, and workspace snapshot reads. Path-only
  local requests must not be globally assigned a cloud environment. The logs do
  not establish which of these callers, if any, caused the error.

## Dispatch trace and remaining boundary

The shared `AppServerRequestClient.sendRequest` calls `enqueueRequest` and
`createRequest`, preserving the original file parameters. Browser IPC transports
these messages through `invokeMain` and the server's `ipcMain` handler stub;
Electron uses its native IPC transport. The extracted main request client
(`_fe.createRequest` / `createExtensionRequest`) also preserves `params`.
The app-host connection sends the request to the app-server backend. The literal
`fs/readFile requires an environmentId` is absent from the extracted JavaScript;
it is observed as backend JSON-RPC error `-32602`, subsequently reported by the
Electron message handler. The backend validation implementation is not available
in this checkout. Its exact internal validation cannot be verified here.

The hosted adapter's missing-context error is instead `No executor is attached
to this cloud task`. Consequently, the observed error alone does not establish
that the hosted adapter ran or dropped an ID. The cloud executor filesystem
adapter (`HMe`) explicitly adds its constructor environment to extension requests.
No propagation correction is supported by current evidence.

## Safe reproduction evidence

`patches/webview-file-environment-diagnostics.patch`, applied by `prepare_asar`,
adds `[codex-web:file-read]` console diagnostics in the shared application:

- `shared-client-dispatch`: host classified as hosted (`durable`), local
  (`local`), or other; environment presence; conversation context presence as
  determined by the existing `Ufn` request helper. This records request creation,
  not confirmation that transport sent it.
- `shared-caller-rejection`: only for the specific missing-environment error,
  labels pasted-text registry, plugin inventory, or workspace snapshot. The
  wrapper preserves the request object, receiver, response, and original error.
  Logging failures do not change request results.

Neither diagnostic emits raw hosts, paths, IDs, payloads, error text, or stacks.
The patches do not assign environments or change validation. Existing application
logs are outside this new diagnostic's privacy guarantee.

Minimum next evidence: reproduce once with the patched prepared app, enable debug
messages in the browser console, and retain only these bounded diagnostic records
plus which predefined UI operation was exercised. A labeled rejection identifies
one of the three candidates without correlating arbitrary identifiers. If only a
dispatch record appears, the caller remains outside these candidates; instrument
that operation with a fixed label next. Concurrent dispatch records alone must
not be used to attribute a rejection. A live failing operation has not been
reproduced, so the original logged error is **not claimed fixed**.

## Focused verification

Run `node --test tests/file-environment.cjs` after preparing the extracted app.
This probes the shipped hosted-file adapter with a simulated request transport:
valid context is preserved, response bytes decode, absent/empty environments
fail before dispatch, and remote errors propagate. It is a contract check, not a
reproduction of the unidentified logged failure or a live cloud integration test.
No file-operation source change was made pending that reproduction.

Task 4 validation: seven focused tests pass, including local path-only behavior,
caller rejection labels, safe metadata, and logger failures. Browser and server
builds pass. Tests simulate backend rejection; they do not reproduce a real
hosted failure. The full archive preparation and live cloud integration were not
run. The maintained patch was checked against the prepared extracted asset.
