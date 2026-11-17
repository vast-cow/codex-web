# Static delivery deployment and bootstrap diagnostics

## Build and deploy

Work on the existing branch. Build with the project's existing Node/Nix environment:

```sh
npm ci --ignore-scripts
npm run build
```

The build needs `HOSTED_CODEX_APP_ZIP` (provided by the Nix shell); `npm run prepare` instead downloads the pinned archive. `build:browser` now finishes by generating `.js.br`, `.js.gz`, `.css.br`, and `.css.gz` siblings throughout `scratch/asar/webview`. This runs **after** upstream patching and Vite's preload output, including for `npm run server`'s pre-hook. Nix's existing build and installation move the complete prepared tree, including siblings. No new dependency is required. Deploy the complete build together; never edit an identity asset without regenerating its siblings. For an already prepared tree, regenerate with `node scripts/precompress-assets.cjs`.

Use the host's existing deployment/service procedure and listener arguments. Record the Git revision, Node version, process identity, asset hashes, proxy identity/configuration, and UTC time. Preserve the current TLS proxy and WebSocket compression settings. Only packaged webview static responses enable `preCompressed`; `/@fs`, uploads, upstream fetches and WebSockets retain their delivery settings. `Vary: Accept-Encoding` also covers identity responses and 304s. The framework derives MIME type from the requested name and length/weak ETag from the selected sibling; siblings retain the source mtime, so Last-Modified represents the same source revision. Cache policy is unchanged.

Precompression uses Brotli quality 9 and gzip level 9, sequentially to bound build memory. The existing preparation pipeline already owns large, stable assets; this avoids runtime CPU/memory competition with bootstrap and uses the installed Fastify plugin's negotiation and conditional-request support. Size savings are measured locally; network/startup savings remain predictions.

Validate on the host before and after publishing:

```sh
npm run build:server
node scripts/diagnostics/validate-static-compression.cjs scratch/asar/webview/assets
```

The check deliberately requires the recorded 12,152,991-byte shared asset; update that assertion deliberately if upgrading the upstream application. It verifies Brotli/gzip negotiation including q=0, identity, byte equality, MIME, Content-Length, Vary, ETags, Last-Modified revalidation, empty 304 bodies and cross-representation ETag misses. At the public URL also use `curl --raw -H 'Accept-Encoding: br' -D headers -o asset.br URL/assets/app-shared-8bd9d0399038.js` and repeat for gzip/identity, then repeat with the returned `If-None-Match`; proxies may behave differently from the local Fastify listener.

## Activate diagnostics

Default is off. Set `CODEX_BOOTSTRAP_DIAGNOSTICS=1` in the existing server service environment **before starting the process**, and rebuild both server and browser. An equivalent foreground invocation on a prepared host is:

```sh
umask 077
CODEX_BOOTSTRAP_DIAGNOSTICS=1 CODEX_CLI_PATH="$(command -v codex)" \
  node src/server/main.js --host 127.0.0.1 --port 8214 \
  2> /tmp/bootstrap-host.log
```

Use the service's existing address/port and logging sink in production. Collect CPU/RSS and service/proxy identity alongside the log, e.g. `pidstat -rud -p SERVER_PID 1` if installed. Disable the flag and restart after collection. Compare diagnostic and normal runs if logging overhead is material. The wrapper does not tee, buffer a whole body, or prefetch ahead of consumer pulls. It logs only metadata; the existing full browser capture includes private application payloads and must remain private.

The opt-in global fetch wrapper catches direct fetches and Electron `net.fetch` / `net.request`. AsyncLocalStorage carries the original HTTP-service UUID from the MessagePort fetch invocation. If propagation is lost, `correlated:false` identifies a new generated trace UUID rather than pretending it is the original UUID. A local-only response header `x-codex-bootstrap-trace` links the upstream response to the serialized RPC response/pull and readable-stream ID. It is not sent upstream. It adds a response header only in diagnostic mode.

Every tagged downstream message carries connection ID, request ID, stream ID, chunk sequence, operation, decoded byte count and cumulative byte count. Upstream reads have their own sequence: read boundaries and RPC chunks can differ. Match cumulative byte ranges, **not sequence numbers across different boundaries**. Browser receipt/dispatched events preserve the bridge sequence. Empty close messages carry the final cumulative byte count. Maps are per connection and cleared on close; completed streams are removed.

Host events distinguish:

- `bridge-request`, `upstream-start`, `upstream-headers` (status plus allowlisted content headers/request ID).
- `upstream-read-start`, `upstream-read`, `upstream-end`, error/cancel. These observe decoded Node fetch-reader availability, not raw upstream TCP packet arrival. Compare read-start→read waits with gaps before read-start to distinguish upstream waits from consumer backpressure.
- `serialize-start`, `send-queue-insert`, `send-queued`, 250-ms `queue-progress` while tagged writes are pending, and `local-write-complete` with errors and `bufferedAmount`. Buffer observations include other traffic on the socket. A write callback is local progress, **never proof of browser receipt**.

Browser console events prefixed `[bootstrap-delivery]` distinguish receipt at WebSocket message callback entry (before JSON parsing), dispatch into the MessagePort, final write and explicit close. This is complete-message receipt, not first network packet arrival. `evaluations-published` and `routes-mounted` are downstream application milestones associated with the latest observed bootstrap, explicitly labeled as such; they do not assert an exact fetch-JSON parse completion or a UUID-specific SDK completion when bootstraps overlap. Use the existing Ready/runtime logs and captured stream consumption as additional evidence.

## Collect and interpret

On the measurement client use the existing two-load harness, no concurrent bulk requests:

```sh
PLAYWRIGHT_MODULE=/tmp/codex-startup-tools/node_modules/playwright \
CAPTURE_SECONDS=360 READY_SELECTOR='textarea, [contenteditable="true"]' \
node scripts/diagnostics/capture-startup.cjs \
  https://z170-1.tailddb1d3.ts.net:8214/ /tmp/startup-with-host-spans
```

The harness enables Runtime console collection, so it records browser diagnostics as `Runtime.consoleAPICalled` entries, alongside actual WebSocket receipt, Ready logs and application milestones. Save host stderr covering the same UTC interval. First confirm `upstream-start`, tagged response headers and matching stream-close/browser-receipt events exist and final byte totals agree. Missing events mean incomplete coverage, not zero duration. In particular, a packaged HTTP service that bypasses Node fetch requires an additional hook at that service's actual response-reader boundary before attributing upstream timing.

Host `hostMs` and browser `browserMs` are different monotonic clocks. Every five seconds a tiny opt-in probe records host send time H0, browser receipt B, and host reply receipt H1 (`clock-sample`). The offset **host minus browser lies in [H0−B, H1−B]**, without assuming symmetric latency. Use nearby samples and show this uncertainty when comparing enqueue→browser receipt. Prefer the smallest RTT sample, check drift across the run, and do not interpret sub-RTT differences as proven delays. `epochMs`/`timeOrigin` help select recordings; do not subtract their wall clocks as if synchronized. The browser clock reply is calibration only; per-chunk browser console/CDP events are the explicit receipt evidence.

For the same bootstrap UUID and cumulative byte range, compare upstream first/last reads, bridge enqueue/write times, calibrated browser first/last receipt and close, then evaluations/runtime completion. Long read waits distributed across ~20 seconds implicate upstream availability; an early upstream end with late bridge enqueue implicates bridge/consumer pacing; early enqueues with growing buffers and late browser receipt implicate downstream delivery. Mixed intervals require mixed attribution. Do not add overlapping waits or confuse browser local MessagePort dispatch with SDK consumption. If consumer pulls themselves are sparse, downstream backpressure may delay reads; the read timestamps alone cannot prove slow upstream production. Collect the missing boundary rather than forcing attribution.

Reproduce on the user's **original affected WAN path**, recording Tailscale direct/relay status, browser/account/profile/cache state, build/hash identity and screenshots. That validation remains outstanding until measured there. Run an independent fresh-profile LAN control only for an actual WAN/LAN comparison. A successful local loopback smoke test does not satisfy it.

## Reproduce instrumentation checks

```sh
npm run build:server
CODEX_BOOTSTRAP_DIAGNOSTICS=1 node scripts/diagnostics/validate-bootstrap.cjs
CODEX_BOOTSTRAP_DIAGNOSTICS=1 \
PLAYWRIGHT_MODULE=/tmp/codex-startup-tools/node_modules/playwright \
node scripts/diagnostics/validate-bootstrap-browser.cjs
```

The browser test bundles the actual shim with the production defines, launches Chromium (optional `CHROMIUM_PATH`), and verifies tagged header/write/close receipt and dispatch. The host test uses a delayed local HTTP response and real WebSockets to verify UUID propagation, byte totals, sequence, body-end, cancellation, local callbacks, clock samples and header redaction. These are synthetic instrumentation checks, not live bootstrap performance measurements.
