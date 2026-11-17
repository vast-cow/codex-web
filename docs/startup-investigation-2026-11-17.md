# Running deployment startup investigation — 2026-11-17

## Scope and outcome

Measured `https://z170-1.tailddb1d3.ts.net:8214/` without changing application behavior. The deployment is reachable. The approximately 32.6-second post-bootstrap gap is reproduced: the fallback Statsig SDK waits for **three 10-second initialization attempts and 0.5/2-second retry delays**. It then becomes ready without usable evaluations, selects the default runtime, and mounts routes. The existing bootstrap retry patch does not remove these SDK retries.

The measured connection also delivers large HTTP and WebSocket payloads slowly. Bootstrap headers arrive quickly, but a multi-megabyte streamed body misses its deadline. A warm reload exposes large, repeated app-catalog notifications on the same socket, delaying other startup responses even with cached JavaScript. These are separate, observable contributors; a single timeout change does not fix all of them.

This establishes the mechanism on the investigator's connection, **not a controlled reproduction of the user's specific WAN-versus-LAN comparison**. The physical path and Tailscale direct status cannot be verified here. No LAN control, server process access, or host logs are available in this isolated workspace.

## Environment and provenance

- Inspection checkout: `704590431654ed216cb06d73d6a6771d0c5a9ae7`, branch `main`, initially clean.
- Browser: Chromium 156, headless Linux, running in workspace host `CFFV5`, address `192.168.207.112`; route to `100.71.85.42` via `192.168.192.1`, `eth0`. Label all recordings **remote tailnet access, physical path unclassified**, not LAN, verified affected WAN, or emulated networking.
- Persistent runs use the same browser process/profile/context, server-provided authenticated session, normal cache, and no throttling. Persistent run 1 starts with a fresh dedicated profile; run 2 reloads it. No application commands or conversations were submitted.
- Earlier exploratory runs used a temporary browser context, normal cache, 155-second windows, and did **not** reach readiness. A concurrent curl download overlapped part of exploratory run 1. Do not treat those runs as clean complete baselines. Persistent runs have no competing bulk download from this investigation.
- Served preload reports upstream application `26.1007.30912`, also pinned by `default.nix`. This is not proof of the running server's Git revision.
- Served assets: `index-44a69cb8b3cd.js`, `app-shared-8bd9d0399038.js` (12,152,991 bytes), `app-initial-6350d04672d0.js` (18,311,126 bytes), `preload.js` (603,642 bytes).
- SHA-256: entry `bd10e3c9056f5dc7f6a9ce750d6cfb6a99343e20e9a206bef6d61d4b70df6dea`; app-initial `662b23e65e264082798da83334cc219f72f5141ded3b282723b7b19988e1a2e0`; preload `1b08aa2d5c7fa0fb35687a602e59e86ed1dcec1e120dbac774353683ad498fd4`.
- App-initial last-modified `2026-11-17 01:52:21 GMT`, ETag `W/"11767d6-1a1e7348748"`. HTML retains a placeholder build tag. Deployed generated code also contains startup diagnostic logging. Full patch inventory and running Git/build identity are not recoverable from these identifiers.
- HTTPS terminates somewhere before the repository's plain HTTP Fastify listener. Responses look like Fastify static responses, but headers do not establish the proxy product/configuration. No Tailscale executable or deployment process is visible in this process namespace.

## Timing origin and complete cold startup

Persistent run 1 starts at Unix seconds `1794882384.313663`, CDP monotonic seconds `1737.425643`. All relative times below use the first top-level navigation request, not the first console message. The mount message's `performance.now()` agrees within milliseconds. The earlier supplied recording and its time origin were unavailable; its 4.2/17.7/50.3/52.5 values cannot be independently re-zeroed.

| Navigation-relative seconds | Evidence/event |
| --- | --- |
| 0 | Navigation begins |
| 7.962 | `/__backend/ipc` handshake completes, HTTP 101 |
| 72.541 | Shared JS finishes, request `122.8`, 12,153,306 encoded bytes including headers |
| 146.560 | Initial JS finishes, request `122.79`, 18,311,442 encoded bytes including headers |
| 147.436 | App-host MessagePort connection starts exchanging RPC messages |
| 171.075 | `ipc_bridge_2`: React root render requested |
| 175.638 | HTTP service fetch `97924681-b401-439f-8cac-e691a713fa15`: POST `/wham/statsig/bootstrap` |
| 176.152 | RPC `resolve` pull 17 supplies response headers and readable stream 7; upstream `content-encoding: br` |
| 176.153 | First stream-7 body write |
| 235.636 | `ipc_bridge_41`: post-login bootstrap times out, attempt 1 |
| 235.637 | Browser sends HTTP-service cancellation for that bootstrap UUID |
| 235.665 | Fallback SDK initialization attempt 1 sent |
| 236.127 | Last observed late stream-7 write, after cancellation; no complete successful bootstrap body |
| 245.661 | Attempt 1 cancelled after its 10-second timer fires |
| 246.164 | Attempt 2 sent after 0.5-second backoff |
| 256.164 | Attempt 2 cancelled |
| 258.165 | Attempt 3 sent after 2-second backoff |
| 268.169 | Attempt 3 cancelled |
| 268.393 | Statsig execution evaluations published with status Ready |
| 268.441 | `ipc_bridge_55`: default runtime configuration selected |
| 271.101 | `ipc_bridge_192`: routes mounted; message says `after 271102ms` |

The post-timeout gap is **32.805 seconds**. Its first 32.5 seconds are the SDK's measured timeouts/backoffs, followed by initialization/render overhead. `c_c` selects the runtime after the provider permits its children to mount. The presence of an `n_c` refresh function that awaits `updateUserAsync` is not evidence that this separate function caused this gap.

Fallback request UUIDs, in order: `69160f8c-9120-4df5-a6c5-9d5b11f8c8b4`, `3b4fc5c8-4bd4-41ca-be42-a1a9dd2ff626`, `ef4b564f-f7d8-4287-af6a-b011aff5f7d2`. All target `https://ab.chatgpt.com/v1/initialize`; the first returns response headers at +236.130, but its stream also fails to complete before timeout. This is not a simple upstream connection timeout.

The bootstrap stream delivered 6,488,064 decoded bytes / 8,665,814 JSON-envelope bytes before it stopped, over about 60 seconds. Its final writes arrive after cancellation. They remain identifiable as the old stream; startup does not recover by accepting a complete late bootstrap. The abort path in `kxn` disposes the fetch RPC and rejects its race. A separately reported earlier disposal-related Statsig abort was not observed in this run and must not be conflated with this deadline.

## What the blank interval contains

HTTP waterfall entries do not represent service fetches tunneled through the long-lived WebSocket. The interval +235.636 to +268.441 has active WebSocket body traffic, browser cancellations, and retry timers, without new browser HTTP requests for these service calls.

Trace evidence on renderer main thread PID/TID 122:

| SDK timer ID | Scheduled | Delay ms | Meaning |
| --- | --- | --- | --- |
| 105 | 235.659 | 10000 | Attempt 1 deadline |
| 130 | 245.661 | 500 | First backoff |
| 131 | 246.162 | 10000 | Attempt 2 deadline |
| 152 | 256.164 | 2000 | Second backoff |
| 157 | 258.165 | 10000 | Attempt 3 deadline |

Corresponding TimerFire events and cancellations are in the trace. During this 32.8-second interval main-thread RunTasks total about 2.47 seconds, maximum 558 ms. During the preceding bootstrap wait the maximum main-thread task is about 20 ms. Neither interval is one long JavaScript execution stall. Script streaming/background parsing must also not be mistaken for continuous main-thread execution.

## Warm reload: the cache-independent startup blocker

Persistent run 2 has navigation origin Unix `1794882701.261905`, CDP `2054.373932`. Both large scripts revalidate in under a second; React root render is requested at +1.480 seconds. Nevertheless routes mount at +301.983 seconds.

| Seconds | Event |
| --- | --- |
| 4.458–95.725 | `app/list/updated`, transfer `a2d51176-cd8f-4f68-9183-b4bb8cc33efc`: 16 chunks plus start/end, **13,731,467 JSON bytes** |
| 104.188–201.542 | Another `app/list/updated`, transfer `114f94db-32f2-408c-8ee6-e0e307de10f0`: same byte count |
| 201.569 | `remoteControl/status/read` completes after a browser-measured 197,100 ms |
| 201.898 | `config/read` completes after 197,426 ms |
| 201.902–201.920 | `account/read` / `getAuthStatus` complete after about 192 seconds |
| 201.934 | Post-login bootstrap is finally sent |
| 202.438 | Bootstrap headers arrive (readable stream 7, pull 18) |
| 261.935 | Bootstrap reaches the 60-second deadline |
| 261.949 / 272.448 / 284.450 | Fallback initialization attempts begin |
| 271.948 / 282.449 / 294.453 | Corresponding deadline cancellations |
| 294.596 | Default runtime selected: **32.661 seconds after bootstrap timeout** |
| 301.983 | Routes mounted |

The first catalog's typical chunk is about 867 KB and takes 5–7 seconds to deliver. Chunk ACKs follow delivery in roughly 10–20 ms. Small invoke responses arrive immediately after chunks (for example `ipc_bridge_4`, shared-object subscription, waits 5.372 seconds). The actual account RPC `6b063120-41e7-420c-8a64-41cf3c915008` is dispatched at about +9.93 and completes at +201.902; `getAuthStatus` UUID `7c20f5c9-cf46-42c1-a96f-7b72e2c12339` has the same dependency. These browser waits are **not server processing durations**.

Two catalog transfers occupy about 188.6 seconds before these startup responses resume. This strongly links warm startup to bulk notification delivery/ordering on the shared bridge. It does not prove exactly where the server holds the account response; host handler/enqueue timestamps are still needed. Changing feature initialization alone would leave this earlier bottleneck. During +4.458 to +201.542, renderer main-thread RunTasks total 7.86 seconds, maximum 45 ms; this is not a 197-second main-thread stall. The warm fallback gap similarly totals 1.58 seconds of main-thread tasks, maximum 269 ms. Exact TimerInstall/TimerFire excerpts and these aggregates are in `trace-excerpts.json`.

Warm bootstrap UUID: `d32dedd4-c6c2-42ab-8e17-613b35b181e6`. Its partial body reaches 6,307,840 decoded bytes / 8,424,256 envelope bytes; the last write at +262.415 is again late. See `summary.json` for all fallback UUIDs and response stream IDs.

Both persistent recordings continue through a visible composer and an additional 15 seconds, with screenshots of the usable interface. Console collection was enabled; application log messages in this build primarily travel as outgoing `log-message` IPC, so those are included in the timeline rather than assuming an empty console means no startup activity. The later Git watcher dependency was not connected to either measured gating interval and was not investigated as a startup cause.

## Delivery and cache measurements

- First HTML curl: DNS 11 ms, TCP 39 ms, TLS ready 302 ms, first byte 333 ms, total 740 ms for 13,600 bytes.
- Standalone continuation download: 11,495,382 bytes / 82.378 seconds = 139,543 bytes/s, approximately **1.12 Mbps**. Its initial 40-second request received 6,815,744 bytes before the measurement cap. This is endpoint throughput, not a generic speed test.
- Persistent cold shared script: about 72.4 seconds for 12.15 MB; initial script: about 73.4 seconds for 18.31 MB. Both have prompt response headers and slow body completion. CSS and preload add transfer contention; sum-of-file-size divided by a single duration is not a controlled capacity measurement.
- Twenty WebSocket protocol pings on a separate connection while the cold browser loaded: median 25.96 ms, range 23.84–49.72 ms. This measures the same host/port and protocol, but does not bound queuing behind a large data frame in the browser's existing socket.
- TCP snapshot reports approximately 25–26 ms RTT, PMTU 1280, and receive out-of-order packets. Those counters alone do not establish packet loss or its cause.
- An ordinary HEAD offering `Accept-Encoding: gzip, br` still returns the full 18,311,126-byte Content-Length and no Content-Encoding. Actual browser large-script responses are also uncompressed, `cache-control: public, max-age=0`.
- Persistent warm reload revalidates both large scripts: extra-info status 304, body bytes absent (about 246/247 header bytes), completed at +0.278/+0.932 seconds. CDP responseReceived may expose effective cached status 200; inspect responseReceivedExtraInfo for actual 304.
- WebSocket upgrade response has no `Sec-WebSocket-Extensions`: compression was not negotiated. Browser HTTP-service response bodies contain decoded JSON even though upstream headers retain `content-encoding: br`; body bytes are then encoded as base64 in JSON RPC messages. Compression upstream does not carry through the bridge.

## Implementation correlation

- `src/browser/shim.ts`: `ensureSocket`, `enqueueMessage`, `handleIncomingMessage` bridge invokes and MessagePorts over one WebSocket. Invoke results resolve their map entries; MessagePort traffic is posted into the local MessagePort. No fixed 32-second browser shim timer exists.
- `src/server/main.ts`: `startIpcBridgeServer` creates `WebSocketServer({ noServer: true })`, awaits renderer readiness, and sends JSON with `socket.send`. Both invoke results and MessagePort traffic use the same connection; no WebSocket compression or traffic-priority scheduler is configured here. The deployed handshake agrees with compression being off. Server processing times cannot be inferred just from these browser durations.
- `src/server/electron/index.ts`: invoke handler awaits its registered handler; `net.fetch` delegates to global fetch. `net-request.ts` streams response bodies. The packaged upstream HTTP-service implementation is not in this checkout, so do not assume every Statsig call uses `NetRequest` specifically.
- Served `app-shared` `kxn` (line 182555): `httpFetch.fetch` RPC with UUID and cancellation. `fetchJson` consumes the body before resolving JSON. `Cxn` reconstructs a response from the RPC stream. Readable-stream identifiers and RPC pull identifiers differ from fetch UUIDs.
- Served `app-initial` `rZs` / `aZs` (504793–504869): bootstrap Promise.race covers the complete safePost operation. **Actual deployed `iZs = 6e4` (60 seconds), not 10 seconds.** `SQs` (506406) and `LQs = 0` (506674) disable general bootstrap retries. `IQs = 5` still allows eligible 401 retries with 500 ms pauses; none occurred in cold run 1.
- `patches/webview-statsig-bootstrap-retry.patch`, applied by `scripts/prepare_asar`, changes only `LQs`. `webview-statsig-override-adapter.patch` is also visible in the served `DQs`. It does not remove SDK initialization retries.
- Served `app-initial` `xQs` error branch → `_Qs` → `vQs` → `yQs` → `useClientAsyncInit`; children remain behind a spinner while async initialization or user matching is pending. `DQs` explicitly permits network traffic through `iQs`.
- Served `app-shared` Statsig NetworkCore (127462–127695): default timeout 10000 ms, Promise.race includes `response.text()`, timer aborts, retry loop. `_fetchEvaluations` (179927) specifies `retries: 2`. Backoff helper `P` (127941) uses `attempt² × 500 ms`, producing 500 and 2000 ms.
- Served app-shared `sre` (14191) reconstructs chunked host messages and sends acknowledgements before delivering the reconstructed message. Served preload exposes `acknowledgeChunkedMessage` (13371). This upstream protocol wraps large catalogs in token arrays, adding substantial JSON overhead.

Line references refer to the recorded served body. For app-shared, the artifact was extracted from Chromium's disk cache and retains a small cache header; verify surrounding function names when comparing another build.

## Smallest remediation supported by these measurements

First test **WebSocket per-message compression** at the existing `WebSocketServer` construction, e.g. `perMessageDeflate: { threshold: 1024 }`, keeping client extension negotiation enabled. This is a small transport change that preserves initialization semantics and addresses both large catalog messages and expanded Statsig bodies. Test with host CPU/memory monitoring and the same two-load capture. The evidence supports this experiment, not a claimed production speedup.

Offline zlib level-6, context-preserving per-message deflate of the actual captured JSON frames reduced the 13,731,467-byte app-catalog transfer to 989,808 bytes (about 93%). The partial bootstrap's 8,665,814 envelope bytes reduced to 2,025,388 bytes (about 77%). These are size estimates using the actual payloads; they are **not before/after network timings**, and compression settings/context boundaries affect the result. No application change was deployed or validated live. The only project additions are this report and the capture harness; its syntax check and both complete deployment captures succeeded. No commit was created because Git user.name/user.email are not configured (Git only auto-detects a root identity); the existing branch and unrelated files were preserved.

A separate narrow mitigation is to suppress the fallback SDK's two retries for initial evaluations: the traced sequence would omit 22.5 seconds of deadlines/backoffs on failure, retaining one 10-second attempt. This needs a specific packaged-code patch or supported SDK configuration, not another change to `LQs`. It still leaves body transfer and catalog delays, and may select defaults sooner on transient failures. Do not increase bootstrap timeout or disable feature flags based solely on these recordings.

HTTP compression/precompressed assets is also supported by the cold-load measurements, but cannot by itself repair warm startup over IPC. Avoid combining unrelated changes before testing the smallest transport experiment.

## Reproduction and artifacts

Use `scripts/diagnostics/capture-startup.cjs` with Playwright installed in a separate tools directory. It preserves a dedicated persistent profile, records two consecutive normal-cache navigations, console events, HTTP headers/body-delivery events, explicit WebSocket frames, full Performance traces including timer stacks, final resource timings and screenshots. It does not submit application work.

```sh
npm install --prefix /tmp/codex-startup-tools --ignore-scripts playwright
PLAYWRIGHT_MODULE=/tmp/codex-startup-tools/node_modules/playwright \
CAPTURE_SECONDS=360 READY_SELECTOR='textarea, [contenteditable="true"]' \
node scripts/diagnostics/capture-startup.cjs \
  https://z170-1.tailddb1d3.ts.net:8214/ /tmp/startup-recording
```

Set `CHROMIUM_PATH` if using an existing browser; otherwise install Playwright Chromium. Set `HEADED=1` for visible operation. The selector is only an optional stop condition, followed by 15 seconds of recording; verify the screenshot and mount event. Without a selector, a fixed window is recorded. Extend it if the UI is still unready. This investigation used Chromium at `/tmp/codex-review-browsers/chromium-1248/chrome-linux64/chrome`, Node `/tmp/node-v22.23.3-linux-x64/bin/node`, and extra libnspr/libnss shared libraries extracted under `/tmp/codex-startup-libs`, since the workspace had neither Node on PATH nor those browser libraries.

Artifacts reside in `/tmp/codex-startup-investigation/`: persistent complete recordings under `persistent/`, exploratory captures at the top level, served app-initial and preload bodies, response headers, `ws-probe.py`/log, `tcp-snapshot.txt`, and `summary.json` generated by `summarize.py`. Raw captures and screenshots contain authenticated application data and are kept out of Git; exclude the browser profile when sharing.

For review, load `run-N-trace.json` in Chrome Performance. Filter NDJSON for `Network.webSocketFrameSent/Received`; HTTP service traffic appears under `message-port-message` RPC `push/pull/resolve/stream`, not as normal browser fetches. Use summary.json for UUID-to-stream/time correlation. CDP events can be reported late (notably streaming-compiled JS); use embedded network timing, responseReceivedExtraInfo, and loadingFinished, not file order or collection wall time alone.

The smallest missing external evidence is a two-load recording on the user's affected client/network with the same profile/cache/session, plus the equivalent LAN control. Run the harness there, record Tailscale path status at the same time, and compare the same asset identifiers. To split host work from delivery, the deployment operator must additionally record the server's build/process/proxy identity and timing at: WebSocket receive **before** awaiting rendererReady, handler entry/exit, upstream auth/start/headers/body-end/cancel, socket enqueue/send callback (with bufferedAmount), and browser stream/dispatch resolution. Log monotonic time and connection/fetch UUID/pull/stream IDs; omit bodies and credentials. Per-process durations avoid clock-offset errors; browser RTT is only an upper bound on server work. Current captures cannot distinguish upstream-body production, host buffering/event-loop delay, proxy/network throughput, and socket queue time completely.
