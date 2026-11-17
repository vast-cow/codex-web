# Desktop RPC flow diagnostics

Diagnostics are disabled by default. This phase changes observation only: window
constants, ACK generation, chunk values, and existing await points are preserved.
The installer targets Desktop 26.1007.30912 and fails if expected AST sites differ.
It instruments the host startup-requirements bundle and browser app-shared bundle.
Normal future Desktop preparation installs the hooks into its private cache output;
changing either diagnostic script invalidates that preparation cache.

## Events and interpretation

Enable host telemetry with `CODEX_RPC_DIAGNOSTICS=1`. Enable read-gap events with
**both** that flag and `CODEX_BOOTSTRAP_DIAGNOSTICS=1`. Enable browser telemetry
with localStorage `codex:rpc-diagnostics=1` before loading the page.

Host records go to stdout as JSON; existing bootstrap records go to stderr.
Browser records go to the console. Filter on `diagnostic: "rpc-flow"` and
`diagnostic: "bootstrap"` rather than retaining arbitrary application console
output, which can contain sensitive information. No diagnostic records contain
payloads, URLs, headers, credentials, or exception messages. RPC diagnostics cover
all RPC streams in the instrumented realm, not only the Statsig stream.

| Event | Meaning |
| --- | --- |
| `window-send` | State after `st.onSend`: window, estimated bytes in flight, startup state, token ID, shouldBlock |
| `window-ack` | State after `st.onAck`: same fields plus ACK RTT and minimum RTT |
| `credit-wait-start/end` | Existing credit promise begins and its resolve/reject callback runs; paired by windowId/waitId |
| `stream-send` | RPC stream operation submitted, with sessionId/operationId/streamId |
| `writer-start/end` | Browser or host writer.write invocation and settlement, including failure boolean and duration |
| `ack-send` | Successful RPC resolution submitted to the transport, after the existing write promise settles |
| `upstream-read-gap` | Bootstrap read completion to the next pull's read-start boundary; includes the final EOF read |
| `event-loop` | Host mean/p99/max loop delay for the preceding approximately one second, sampled at 20 ms resolution |
| `dropped` | Records lost after the bounded buffer filled; invalidate completeness assumptions |

`ms` is monotonic and local to a process/page; `epochMs` is wall-clock metadata.
Do not subtract browser and host monotonic timestamps. Use the existing bootstrap
clock probes for clock bounds. Window token sentTime uses the existing algorithm's
clock. IDs are scoped to one helper instance. `operationId` matches the sender's
import slot and receiver's export slot on the corresponding RPC session; it is
not globally unique. Match streamId to the existing bootstrap bridge trace, and
identify the corresponding session/connection before joining concurrent tabs.
A window-send/ack record carries the synchronous send operation associated with
that token; writer records carry the operation evaluated when that write began.

Window sizes measure the RPC size estimator, including base64 strings and its
string estimate. They are not decoded body bytes or wire bytes. The initial
window remains 262144, minimum 65536, maximum 1073741824. There is no new credit,
pull, ACK, queue, timeout, or stream strategy in the data path.

Hooks enqueue metadata synchronously into a maximum 2048-record buffer and flush
every 250 ms. Logging has measurement overhead. On the host timers are unref'ed;
records can be lost on exit. Host event-loop sampling is process-wide, not an
attribution to a particular request. Read gaps require the pre-existing bootstrap
wrapper, whose zero high-water mark propagates demand. No additional body wrapper
is added by RPC instrumentation.

Compare host credit-wait intervals to read gaps and event-loop samples. On the
browser compare writer-end to ack-send for the same operation; on the host compare
token ACK RTT with credit release. A successful ACK means remote writer settlement,
not that JSON parsing or application initialization has completed. Failed writes
log writer-end with failed=true and reject the existing RPC promise; ack-send
covers successful resolutions only. Intervals overlap and must not be added.

## Isolated validation

Run from the source checkout. These tests bind only ephemeral loopback listeners,
execute RPC cores extracted from the actual Desktop bundles, and never launch the
Desktop app or contact the production endpoint:

```bash
node --test scripts/diagnostics/rpc-flow.test.cjs scripts/asset-cache.test.cjs
```

The Chromium case is skipped unless Playwright is configured. On z170-1 the
validated command is:

```bash
PLAYWRIGHT_MODULE=/tmp/astro-generator-browser/node_modules/playwright \
CHROMIUM_PATH=/tmp/codex-browsers/chromium-1254/chrome-linux64/chrome \
node --test scripts/diagnostics/rpc-flow.test.cjs scripts/asset-cache.test.cjs
```

Tests cover window-state equivalence, disabled hooks, slow consumer backpressure,
exact bytes/order/EOF, cancellation and credit rejection, writer/ACK correlation,
real Chromium WebSocket/MessagePort delivery, bounded logging, loop sampling,
read-gap opt-in, and installation guards. Synthetic delays establish propagation;
they do not quantify the earlier production capture's 19.161 seconds.

## Prepare an isolated deployment candidate

Run after the instrumentation commit exists. This copies artifacts; do not use
hard links. Do not run the ordinary build/prepare scripts in the live checkout.

```bash
rpc_source=/home/naoto-aoki/Projects/20261116-codex-web
rpc_stage=$(mktemp -d /tmp/codex-rpc-candidate.XXXXXX)
git -C "$rpc_source" archive HEAD | tar -x -C "$rpc_stage"
mkdir -p "$rpc_stage/scratch"
cp -a --reflink=auto "$rpc_source/scratch/asar" "$rpc_stage/scratch/asar"
ln -s "$rpc_source/node_modules" "$rpc_stage/node_modules"
node "$rpc_source/scripts/diagnostics/instrument-rpc.cjs" "$rpc_stage/scratch/asar"
(cd "$rpc_stage" && ./node_modules/.bin/tsc -p src/server/tsconfig.json)
(cd "$rpc_stage" && node scripts/precompress-assets.cjs scratch/asar/webview)
printf '%s\n' "$rpc_stage"
```

Precompression must finish before serving the candidate: an old `.br` or `.gz`
sidecar would otherwise serve the uninstrumented shared bundle. The installer
refuses the source checkout's deployed scratch/asar and symlink/hard-linked target
files, and validates both bundles before writing either. Its idempotence marker
allows a copied candidate to be reprocessed without duplicate hooks. Source maps
for the two patched upstream bundles are not regenerated; inspect emitted JS.

## Enable in production only after explicit deployment/restart approval

There is no live-toggle for host hooks. Merely committing source or exporting a
variable in another shell does not enable the existing process. The current
production artifacts must remain untouched until deployment approval.

After approval, use the service's existing launcher to stop the old process and
launch the prepared candidate with its original settings plus the two diagnostic
flags. Do not run two processes against the same production listener. The earlier
recorded launch settings translate to the following command; verify them against
the actual launcher before executing because it is not visible in this PID
namespace:

```bash
cd "$rpc_stage"
CODEX_RPC_DIAGNOSTICS=1 \
CODEX_BOOTSTRAP_DIAGNOSTICS=1 \
CODEX_CLI_PATH=/home/naoto-aoki/Projects/20261116-codex-web/scripts/codex_remote_proxy \
CODEX_UNIX_SOCKET=/home/naoto-aoki/Projects/20261116-codex-web/codex.sock \
node src/server/main.js --host 127.0.0.1 --port 8214
```

Keep the existing proxy configuration for
`https://z170-1.tailddb1d3.ts.net:8214/`. Preserve any additional launcher environment,
state paths, and lifecycle management; the command above is not a replacement
for discovering the current service manager. A candidate in a different cwd can
change relative state paths, so resolve those from the launcher before cutover.

In DevTools on that exact origin, enable the browser hooks, preserve console logs,
and reload after the instrumented candidate is deployed:

```js
localStorage.setItem("codex:rpc-diagnostics", "1");
location.reload();
```

No new flag is transmitted over the RPC protocol. To disable the browser hooks:

```js
localStorage.removeItem("codex:rpc-diagnostics");
location.reload();
```

Disable host hooks by removing both environment flags and restarting through the
same approved deployment procedure. Retain the previous deployment directory for
rollback. Neither activation nor rollback was performed during this investigation.
