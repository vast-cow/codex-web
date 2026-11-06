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

For a further reproduction, inspect the failing request at the shared request
client dispatch boundary: method, host, whether an environment is supplied, and
caller stack. Avoid logging file contents or credentials. Match the caller to
its conversation/file context before changing propagation. Missing and unknown
cloud environments must continue to fail; do not default to a global ID.

## Focused verification

Run `node --test tests/file-environment.cjs` after preparing the extracted app.
This probes the shipped hosted-file adapter with a simulated request transport:
valid context is preserved, response bytes decode, absent/empty environments
fail before dispatch, and remote errors propagate. It is a contract check, not a
reproduction of the unidentified logged failure or a live cloud integration test.
No file-operation source change was made pending that reproduction.
