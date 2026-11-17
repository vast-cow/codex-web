# Running deployment startup investigation — 2026-11-17

## Scope and outcome

**Repository follow-up:** static Brotli/gzip precompression and opt-in bootstrap boundary diagnostics are implemented and locally validated. The public shared-asset HEAD at **04:37:23 UTC** still returns 12,152,991 bytes without Content-Encoding when offered Brotli/gzip; no deployment containing this change is established. The previous “compression now negotiates” finding below concerns **WebSocket** compression. See [Implementation and local validation](#implementation-and-local-validation) and [deployment/collection instructions](bootstrap-delivery-diagnostics.md). No live speedup or attribution of the remaining bootstrap interval is claimed.

**Latest recording analysis:** the warm bootstrap independently takes **21.103 s**, including **20.626 s** waiting for its complete streamed body, the longest remaining dependency. Current catalogs follow `app/installed` → `app/read` with a populated lifecycle gate; no large catalog broadcasts occur in the captured windows. See [Warm dependency and catalog analysis](#warm-dependency-and-catalog-analysis-of-existing-recordings) for the complete 43.387-second accounting, extraction controls, static-delivery evidence and prioritized measurement.

**Latest live check (2026-11-17 03:42–03:47 UTC): compression now negotiates, both complete bootstrap responses succeed, and neither load activates the fallback. Routes mount at 181.132 seconds cold and 43.387 seconds warm.** See [Live deployment verification follow-up](#live-deployment-verification-follow-up) for measurements and limits. Authenticated deployment-host access remains unavailable; the running revision and deployment procedure are unverified. Earlier deployment/compression statements below describe the earlier recordings.

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

## Compression implementation and validation follow-up

Implemented against clean checkout `e3a799a82a1ab36a33091856dac699b049c11719` on the existing `main` branch. The production change is limited to `src/server/main.ts`'s IPC WebSocketServer options:

```ts
perMessageDeflate: {
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  threshold: 1024,
}
```

The lockfile and the locally installed library both specify `ws` **8.20.0**. The existing `noServer: true` upgrade routing stays in place. All six server send sites use `socket.send(JSON.stringify(...))`, without an override disabling compression. In `ws/lib/websocket.js`, sends default to `compress: true` when the extension is negotiated. In `ws/lib/sender.js`, the 1024-byte threshold is applied when the sending endpoint has no context takeover. Thus server messages below 1 KiB remain uncompressed; bulk catalog and HTTP-service stream messages are compressed. The no-context options reset compression history between messages in each direction, avoiding dependencies on prior catalog messages. They do not change message boundaries or dispose zlib allocations after each message. The browser controls its own outbound compression policy. Other library defaults remain unchanged: zlib defaults and the shared compression concurrency limit of 10. No send-path, timeout, retry, flag, catalog, static-asset, or reconnection policy changes are included.

### Local negotiation and actual frame measurements

Tests instantiated the literal options from the patched constructor using installed `ws`, without loading the upstream application. A noServer HTTP upgrade fixture used `/__backend/ipc`. Node clients and native **Chromium 156.0.8078.4** negotiated:

```http
Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover
```

Validation replayed one complete baseline warm catalog (18 messages: start, 16 chunks, end) and all 119 messages from the baseline cold **partial** bootstrap stream. These are the original captured JSON WebSocket messages, in their original boundaries; the catalog was not concatenated before compression. The same installed library sent them once with compression off and once with the patched options. Each received string was checked against the original, including ordering. A parser on the client's TCP socket measured the actual WebSocket frame lengths and RSV1 bits before inflation; handshake bytes, TCP/IP overhead and TLS overhead are excluded. This loopback fixture uses plain WS, so socket data contains the actual compressed WebSocket frames. CDP's decoded `payloadData` lengths were **not** treated as compressed wire bytes.

| Local replay, same decoded messages | Compression off | Patched compression |
| --- | ---: | ---: |
| Decoded catalog JSON bytes | 13,731,467 | 13,731,467 |
| Catalog transport bytes, including WS framing | 13,731,635 | 976,908 |
| Decoded partial bootstrap JSON-envelope bytes | 8,665,814 | 8,665,814 |
| Partial bootstrap transport bytes, including WS framing | 8,666,866 | 2,169,438 |
| Total transport bytes | 22,398,501 | 3,146,346 |
| Loopback replay elapsed | 125.08 ms | 299.04 ms |
| Combined fixture process user/system CPU | 105.11 / 21.61 ms | 370.47 / 64.11 ms |
| Combined fixture process RSS start / sampled peak | 397,729,792 / 426,016,768 bytes | 432,177,152 / 465,436,672 bytes |

These frame measurements represent approximately **92.9% catalog reduction, 75.0% partial-bootstrap reduction, and 86.0% total reduction** with the effective per-message settings. The CPU and RSS figures include both endpoints, JSON checking, and retained baseline fixtures in one Node process; they are single observations, not isolated production-server resource estimates. Compression costs CPU and makes this fast loopback replay slower. It does not establish a WAN startup speedup or show that the complete bootstrap body fits the deadline.

Assertions also checked that sub-threshold messages have RSV1 clear, large messages have RSV1 set, request/reply IDs survive, fresh connections renegotiate, and clients that do not offer compression still work. Native Chromium exercised two successive connections with header/write/close messages, a 1 MiB streamed body, and correlated request IDs. The full application reconnect/reload flow cannot be exercised against the patched deployment without deploying it; its existing shim and handlers are unchanged.

`npm ci --ignore-scripts --no-audit --no-fund`, `npm run build:server`, Prettier on `main.ts`, protocol tests, Chromium interoperability tests, and diff whitespace checks passed. Generated TypeScript build outputs were removed from the working tree. The capture harness remains unchanged.

### Live deployment status and before/after startup comparison

The live URL was probed again with an explicit `permessage-deflate; client_max_window_bits` offer. It returned HTTP 101 **without** `Sec-WebSocket-Extensions`; the patched configuration is not deployed there. Probe time: Unix `1794883800.1257384`. This workspace still has an isolated process view, no deployment process, no configured SSH host access, and no packaged upstream app available for a full local application launch. No deployment/restart was performed. Repeating the live capture now would measure the unpatched deployment, so it is not presented as an after-change run.

| Startup event, navigation-relative seconds | Baseline cold | Baseline warm | Live after patch |
| --- | ---: | ---: | --- |
| React render requested | 171.075 | 1.480 | Pending deployment |
| Catalog transfer 1 start–end | After mount; recording ends during transfer | 4.458–95.725 | Pending |
| Catalog transfer 2 start–end | Not observed before mount | 104.188–201.542 | Pending |
| account/read browser completion | 175.610 | 201.902 | Pending |
| getAuthStatus browser completion | 175.612 | 201.920 | Pending |
| Bootstrap request | 175.638 | 201.934 | Pending |
| Bootstrap headers | 176.152 | 202.438 | Pending |
| Complete bootstrap body | Not received | Not received | Pending |
| Bootstrap timeout | 235.636 | 261.935 | Pending |
| Fallback first attempt–last cancellation | 235.665–268.169 | 261.949–294.453 | Pending |
| Runtime selected | 268.441 | 294.596 | Pending |
| Routes mounted | 271.101 | 301.983 | Pending |

**Whether bootstrap now succeeds and the 32.6-second fallback delay disappears remains unmeasured.** The baseline connection is remote tailnet access with physical path unclassified; it is not verified as the user's affected WAN or a LAN control. Its approximately 1.1 Mbps endpoint throughput is not substituted for the user's reported external speed.

### Catalog duplication and next candidate

Both complete warm-run `app/list/updated` transfers contain exactly the same ordered **340,741 tokens**, after excluding transfer-envelope IDs and sequence fields. Canonical concatenated-token JSON SHA-256 is `c4847cc21d06133626922e917ab75c588758cf964b5c3be8af18707311d2161d`. This compares full content, not just byte counts. They are duplicate catalog data in this baseline; they are not necessary distinct snapshots. The first catalog may still be required for the new renderer.

If catalog delay remains after compression, the next focused experiment is to suppress unchanged `app/list/updated` notifications **per renderer/connection**, retaining the first snapshot and every changed catalog. Inspect the upstream producer/dispatch contract before implementing it. Do not suppress across new connections merely because a previous renderer received the same data. Smaller frames or fair scheduling may additionally reduce response latency behind an individual frame, but they do not remove the measured duplicate transfer. No catalog behavior is changed by this patch.

### Remaining live measurements and reproduction

1. Deploy the server patch through the host's existing build/service mechanism, recording the deployed commit, process, proxy and restart time. Rollback is the single constructor-options change. Keep served asset hashes, application state, and all other startup policies constant; the original baseline is comparable only while those conditions still match.
2. Verify the new browser's actual upgrade contains the extension and effective no-context parameters. Capture a fresh-profile cold load and its consecutive warm reload with the existing harness. Use the same Chromium version, account/session and normal cache conditions as the baseline. A fresh output directory supplies a cold profile; reuse the browser context for the second load, as the harness already does:

   ```sh
   PLAYWRIGHT_MODULE=/tmp/codex-startup-tools/node_modules/playwright \
   CAPTURE_SECONDS=360 READY_SELECTOR='textarea, [contenteditable="true"]' \
   node scripts/diagnostics/capture-startup.cjs \
     https://z170-1.tailddb1d3.ts.net:8214/ /tmp/startup-compressed
   ```

3. Independently measure compressed frame payload lengths/RSV1 and framing at the server's decrypted WebSocket socket, or use a client packet capture decrypted with that browser's TLS key log. Correlate the same TCP connection and message boundaries with CDP decoded frames. CDP payload lengths alone cannot establish compressed transport volume. Keep compressed payload bytes, WS framing, TLS bytes and decoded sizes distinct.
4. Correlate each catalog transfer ID/sequence, account request UUID, and bootstrap UUID/pull/readable-stream ID across response generation, socket enqueue, send callback, browser receipt, and bridge resolution. Record socket `bufferedAmount`, handler durations and upstream auth/headers/body-chunk/body-end/cancel timestamps using process-monotonic clocks. A send callback confirms local transport handoff, not browser receipt. This is still required to decide whether auth results were already generated but queued or generated late because initialization awaited catalog delivery. Browser-only completion times do not resolve it.
5. For bootstrap, compare upstream body chunk/completion timing against corresponding WebSocket chunks and browser body completion. The prompt headers in the baseline do not prove prompt upstream body completion. Record bootstrap success, fallback activation/deadlines, runtime selection and route mount; verify visually usable UI after mount. Sample service CPU/RSS separately from the browser and replay tools.
6. Label new measurements as affected WAN, a different external path, or LAN control only when verified. Repeat the same pair on the affected client and LAN if a WAN/LAN causal comparison is needed.

Local reproducible validation scripts and evidence are in `/tmp/codex-ws-compression/`: `validate.cjs`, `replay-results.json` (per-frame RSV1/lengths), `browser-interop.cjs`, `browser-interop.json`, and `live-handshake.json`. Run the scripts from the repository root with installed dependencies; the replay uses the preserved baseline `persistent/run-{1,2}.ndjson` files. Browser fixture paths are explicit in its script. These are diagnostic artifacts, not runtime dependencies, and raw catalog/body data remain outside Git.

## Live deployment verification follow-up

### Deployment access and running build

This follow-up started from clean checkout `a6db17ceb40de8219775fc0300c942b59c93af60`, on the existing `investigation-20261117-2` branch. That proves the inspection source contains the requested patch, not that the host runs this revision.

The workspace is still `CFFV5`, not `z170-1`. DNS resolves the endpoint to `100.71.85.42`; its route is still via `192.168.192.1` on `eth0`. TCP ports 22 and 8214 are reachable. SSH advertises OpenSSH 9.9, but the following read-only access attempt exits 255:

```sh
ssh -v -o BatchMode=yes -o ConnectTimeout=8 \
  -o UserKnownHostsFile=/tmp/codex-deploy-known-hosts \
  -o StrictHostKeyChecking=accept-new root@z170-1.tailddb1d3.ts.net true
# Permission denied (publickey,gssapi-keyex,gssapi-with-mic,password).
```

The probe actually used `/tmp/codex-deploy-known-hosts` for its temporary host-key record. No `/root/.ssh` directory, configured deployment account/key, SSH agent, or Kerberos credential is available. `root` was the workspace's default account, not an independently established deployment account. The process namespace contains no deployment service; Tailscale CLI is unavailable. Repository inspection found generic npm/Nix build/launch instructions, but no host-specific deployment workflow, service unit, release directory, or rollback procedure. No deployment tool with authenticated host execution is available in this session.

| Required deployment fact | Result |
| --- | --- |
| Previous running Git revision | Unknown; earlier live handshake lacked compression |
| Current running Git revision | Unknown; effective compression options now match the patch |
| Service name, PID, execution/build directory, proxy configuration | Inaccessible without authenticated host execution |
| Build/restart/deployment commands executed | None |
| Existing rollback command/release | Unknown; must be discovered on the host |

**The endpoint changed since the earlier probe, independently of this follow-up.** The live extension proves compatible transport configuration is active on this connection path. It does not identify a commit, prove the 1024-byte threshold, or establish that no other server changes were deployed. Rebuilding the local checkout would not establish the running host's build. No speculative restart, rollback, or catalog modification was attempted.

### Fresh live browser negotiation

At `2026-11-17T03:42:26.108Z`, a fresh native Chromium `156.0.8078.4` browser/profile loaded the target URL and opened `wss://z170-1.tailddb1d3.ts.net:8214/__backend/ipc`. CDP captured the actual browser request and response:

```http
Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover
```

Thus the live browser connection negotiates `permessage-deflate`, with compression context reset in both directions and no explicit window-bit parameter in the response (default window size). A separate direct TLS upgrade at `03:42:18.056 UTC` produced the same extension response. The startup captures independently confirm the extension on their fresh IPC upgrades at cold +8.423 and warm +0.324 seconds. This is live endpoint evidence, not the earlier loopback fixture. Frame RSV1/compressed lengths were not captured on these TLS connections; byte-level compression use for individual live messages remains unmeasured.

### Conditions and before/after observations

Used the unchanged `scripts/diagnostics/capture-startup.cjs`, the same Chromium executable/version, 1440×1000 headless viewport, URL, workspace, remote tailnet route, server-provided authenticated account, normal cache, and no throttling as the earlier persistent pair. A fresh dedicated profile supplies the cold load, followed by a normal reload in the same browser/context/profile; the baseline used its own fresh dedicated profile followed by its reload. No competing investigation download ran during this pair. The readiness selector was `textarea, [contenteditable="true"]`, followed by 15 seconds, with screenshots and explicit route-mount logs checked for both runs.

**The user's affected WAN path was not tested.** These are remote tailnet measurements with physical path unclassified. Tailscale direct/relay status, network capacity stability and the user's client/profile cannot be verified here. Software, asset content, cache procedure and workspace route match the baseline, but host/application state and backend change inventory are uncontrolled. In particular, the baseline's two large catalogs are absent now. This is an observational comparison with the earlier baseline, not an isolated estimate of compression's causal speedup. A controlled uncompressed baseline on the current host state was unavailable before this follow-up because the endpoint already negotiated compression and host access was unavailable.

Cache-body SHA-256 checks match the baseline for entry JS, preload, app-shared and app-initial. In particular, app-initial remains `662b23e65e264082798da83334cc219f72f5141ded3b282723b7b19988e1a2e0`, preload `1b08aa2d5c7fa0fb35687a602e59e86ed1dcec1e120dbac774353683ad498fd4`, and app-shared's 12,152,991-byte body is `8370d130013537f41c3431c9b60a2c1e30d7369c2150fea1416c3eb6ff34a439`. Bodies were located in Chromium disk-cache entries by their known prefix and hashed over their exact original body lengths; cache metadata was excluded. Preload's new last-modified time alone would not have established equality.

All table times are seconds from the first top-level navigation request. New cold origin is Unix `1794886947.990330`; warm origin is `1794887161.454378`.

| Event | Earlier cold | Earlier warm | Live cold | Live warm |
| --- | ---: | ---: | ---: | ---: |
| Shared JS complete | 72.541 | 0.278 | 72.348 | 0.321 |
| Initial JS complete | 146.560 | 0.932 | 135.767 | 0.932 |
| React root render requested | 171.075 | 1.480 | 137.457 | 1.583 |
| Catalog 1 start–end | After mount; incomplete | 4.458–95.725 | Not observed | Not observed |
| Catalog 2 start–end | Not observed before mount | 104.188–201.542 | Not observed | Not observed |
| account/read completion | 175.610 | 201.902 | 147.301 | 11.504 |
| getAuthStatus completion | 175.612 | 201.920 | 147.301 | 11.505 |
| Bootstrap request | 175.638 | 201.934 | 147.317 | 11.516 |
| Bootstrap headers | 176.152 | 202.438 | 147.855 | 11.993 |
| Bootstrap first body write | 176.153 | After headers | 147.858 | 11.993 |
| Bootstrap last body write / stream close | Incomplete | Incomplete | 168.297 / 168.297 | 32.618 / 32.619 |
| Bootstrap deadline timeout | 235.636 | 261.935 | None | None |
| Evaluations published Ready | 268.393 | Before runtime selection | 168.606 | 32.860 |
| Fallback first attempt–last cancellation | 235.665–268.169 | 261.949–294.453 | None | None |
| Runtime selection | 268.441, default | 294.596, default | 168.776, primary | 33.024, primary |
| Routes mounted | 271.101 | 301.983 | 181.132 | 43.387 |

Observed route-mount time decreases by 89.969 seconds cold and 258.596 seconds warm relative to the earlier pair, subject to the state/catalog confounds above. No bootstrap timeout logs or fallback `https://ab.chatgpt.com/v1/initialize` fetches occur in either complete capture. The approximately 32.6-second fallback interval is absent in these runs; this does not establish it is eliminated for every client or network.

### Complete live bootstrap receipt and processing

| Evidence | Cold | Warm |
| --- | --- | --- |
| Fetch UUID | `bf9afb9b-f2a5-43f8-aa56-001761c5448a` | `77298bf7-88fd-4ba0-bc6b-180e8a76d6e9` |
| Response pull / readable-stream ID | 17 / 7 | 17 / 10 |
| Request-to-stream-close | 20.980 s | 21.103 s |
| Complete decoded body | 7,932,274 bytes | 7,932,272 bytes |
| Body SHA-256 | `b39f616009a8529338123a9c9916ac4515e943d333af9ecda86c11a820a0d710` | `7f9572f334018eb150c987f8441eca7ff09c5562d892d13b25dfc7b12b2fd263` |
| Body stream JSON-envelope bytes, including close | 10,593,071 | 10,594,088 |

For each run, the pull-17 response identifies its readable stream. All browser-received stream writes were base64-decoded and concatenated in order through explicit `close`. Both complete outer JSON documents parse, and their `statsigPayload` strings also parse as JSON containing **1,247 feature gates, 2,377 dynamic configs and 481 layer configs**. Browser logs then publish Ready evaluations and choose `codex-primary-runtime` with source `statsig-layer`, followed by route mounting and a visible composer. This validates full reception and application processing beyond the earlier incomplete replay. Cancellation messages at cold +169.198 and warm +33.388 are cleanup after completion, not deadline evidence; the original timeout must not be inferred from a cancel alone.

Bootstrap response metadata records `statusText: OK`, `content-type: application/json`, upstream `content-encoding: br`, and `transfer-encoding: chunked`. Cold upstream request ID is `bca8208b-0272-47bc-b2dc-38f9083b408f`; warm upstream request ID is `0a42e664-0b8b-4b7d-a45c-fec274f5d96b`; full headers are retained in the raw capture. Upstream Brotli headers describe upstream encoding; browser bridge body bytes above are decoded. Header receipt does not timestamp upstream body completion.

### Transfer volume, resources and remaining delay

The byte counts above are actual **browser-received decoded bodies and JSON envelopes**, measured from CDP payload strings with UTF-8 byte lengths and decoded base64 body lengths. They are not compressed wire bytes. Actual large-script HTTP transfer counts from CDP `Network.loadingFinished.encodedDataLength` are 12,153,306 and 18,311,442 bytes cold, including HTTP headers. Neither large script has Content-Encoding. Warm responses revalidate with actual status 304 and 246/247 encoded bytes, rather than redelivering the large bodies. There is no live server socket instrumentation or TLS-decrypted packet capture here, so actual compressed WebSocket transport bytes, framing and TLS overhead remain unavailable; earlier replay reductions cannot substitute for them.

No `codex-host-chunked-message-v1` catalog transfers or `app/list/updated` notifications are present anywhere in either new recording, including its post-mount window. The earlier catalog intervals and byte counts therefore have no corresponding new transfer to compare. Their disappearance requires host-side producer/cache/deployment investigation before attributing warm improvement entirely to transport compression. No notification suppression was implemented in this task.

There is still substantial cold static-delivery delay (135.767 seconds until initial JS completes). Warm React-to-runtime selection takes 31.441 seconds: initial remote-control/config RPCs wait about nine seconds, bootstrap then takes 21.103 seconds, and runtime-to-route mount takes another 10.363 seconds. Large `shared-object-updated` messages for `statsig_evaluations` complete at cold +146.956/+177.896 (5,972,688/5,974,406 decoded JSON bytes), and warm +11.186/+41.580 (5,974,406/5,974,404 bytes). Their receipt precedes initial RPC completions and post-bootstrap mount work. This supports further investigation of repeated large evaluation snapshots on the shared bridge, but does not establish server generation time or queue ordering.

Initial cold account/read UUID `4ce85d43-cd18-4163-a0fe-732f90ea7598` and getAuthStatus UUID `87c926d5-9c81-47f3-843e-1a245d57c290` each complete in a browser-reported 57 ms; warm equivalents `ae0ff197-e58c-4a8e-b6a1-7f60bfdcf089` and `18405f20-72b5-4a12-bd0c-ec14f2ece606` each take 65 ms. These durations are browser request/response measurements, not host processing durations. Host CPU/RSS, host response-generation/enqueue/send progress, and upstream body-end timestamps cannot be measured without host execution. This workspace's CPU/RSS would measure the investigator, so it is not reported as deployment resource usage.

### Remaining deployment and validation steps

1. Provide this task an authenticated deployment-host execution capability: the correct deployment account plus its existing SSH identity/agent or an existing connected host terminal, with permission to inspect and use the current service/build mechanism. Network reachability alone is already working. Obtain the operator's existing deployment/rollback instructions if they are outside the host checkout.
2. On that host, identify the port-8214 listener and TLS proxy, service manager/unit, PID, `/proc/PID/cwd`, command/executable and loaded build path. Record the live source/build revision and artifact hashes, compare its constructor options with `a6db17c`, and discover the existing previous-release rollback command before changing the service. Generic `npm run build:server` emits TypeScript JS; `default.nix` also defines a packaged build. Neither identifies which procedure this host uses.
3. If the actual running build lacks the requested patch, apply it through that discovered workflow on the current deployment branch, build the server, restart the existing service, and verify the new PID uses the intended artifact. If already equivalent, record that evidence without an unnecessary redeployment. Record previous/resulting revisions, exact commands and rollback procedure; these facts remain unknown here.
4. Explain the missing catalog notifications and collect host CPU/RSS alongside request-correlated generation, queue insertion, `bufferedAmount`, local send progress and explicit browser receipt. For bootstrap correlate the UUID, pull and stream IDs above with upstream body completion and bridge delivery. Preserve credentials and bodies outside diagnostic logs. This distinguishes queued responses from initialization dependencies and upstream body delay.
5. Record actual compressed live frame lengths/RSV1 at the decrypted server socket or from a browser TLS-key-log/decrypted packet capture. Repeat the unchanged two-load harness on the user's affected WAN client/profile/path, with matching cache conditions; obtain a contemporaneous pre-change comparison through the established deployment/rollback procedure if needed. Then decide separately whether catalog duplication, evaluation snapshots, or uncompressed static assets warrant the next patch.

New evidence is under `/tmp/codex-live-deployment-check/`: `browser-handshake.json`, `raw-handshake.json`, `asset-hashes.json`, `details.json`, analysis helpers, and `startup/run-{1,2}.{ndjson,png}` with page snapshots and full traces. Raw headers/bodies and profiles contain authenticated data and remain outside Git. The capture harness exited successfully for both loads; both screenshots show the mounted application and composer. The remaining deployment and affected-WAN claims are explicitly unverified.

## Warm dependency and catalog analysis of existing recordings

This analysis reuses the live and persistent baseline NDJSON, page Resource Timing snapshots and full traces listed above; no new navigation or deployment was performed. It supersedes the earlier *candidate* recommendation to suppress duplicate catalogs: the current request path differs, and no current duplicate catalog has been observed.

### Complete 43.387-second warm timeline

Origin: first top-level `Network.requestWillBeSent`, CDP monotonic **6514.566402**, Unix **1794887161.454378**. Times below subtract that origin, rounded to milliseconds. Log events timestamp browser emission, not host execution. Concurrent operations appear on separate rows, not as additive durations.

| Navigation-relative seconds | Event / correlation |
| --- | --- |
| 0 | Navigation request |
| 0.169–0.321 | Shared JS revalidation; actual HTTP 304, 246 header bytes |
| 0.324 | IPC WebSocket upgraded with permessage-deflate |
| 0.679–0.932 | Initial JS revalidation; actual HTTP 304, 247 header bytes |
| 1.583 | React root render requested |
| 2.075 | Subscribe to `statsig_evaluations`, invoke `ipc_bridge_4` |
| 2.077 / 2.078 | Initial `remoteControl/status/read` / `config/read` dispatched; UUIDs `d85cb8ca-c8a8-414a-adae-6af2729fdb89` / `622101cc-5c43-4439-b151-8f448ce2bda4`; browser queue wait 0 ms |
| 11.186 | Initial large `statsig_evaluations` update received |
| 11.395 | Subscription invoke `ipc_bridge_4` resolves |
| 11.426 | Both initial RPC completion logs; durations 9,349 / 9,348 ms |
| 11.436–11.477 | Second `config/read` dispatch-to-completion, 41 ms |
| 11.439 | `account/read` and `getAuthStatus` dispatched concurrently; UUIDs `ae0ff197-e58c-4a8e-b6a1-7f60bfdcf089` / `18405f20-72b5-4a12-bd0c-ec14f2ece606` |
| 11.504 / 11.505 | Account/auth completion logs, 65 ms each; received results +11.503894 / +11.504431 identify authenticated ChatGPT account/method |
| 11.516 | POST bootstrap fetch `77298bf7-88fd-4ba0-bc6b-180e8a76d6e9` |
| 11.993 | Pull 17 response supplies headers and readable stream 10; OK, upstream `content-encoding: br` |
| 11.993294 | First stream-10 body write |
| 32.618162 | Last stream-10 body write |
| 32.618699 | Explicit stream close: complete 7,932,272-byte decoded outer JSON body |
| 32.619–32.860 | Body consumption/JSON decoding/SDK initialization boundary; no individual JSON-parse start/end markers. Complete outer body and nested `statsigPayload` parse offline; Ready log proves application processing by +32.860 |
| 32.860 | Evaluations published Ready |
| 32.952 | Renderer sends `shared-object-set` for the large evaluations snapshot |
| 33.024 | `codex-primary-runtime` selected, source `statsig-layer` |
| 33.206 / 33.417 | Further config reads dispatched (durable/local respectively); completion logs +41.814 / +41.854, durations 8,608 / 8,438 ms |
| 41.580 | Large evaluations snapshot echoed to browser |
| 41.827–41.829 | Two further account/auth pairs dispatched; completions +42.381–42.384 (554–555 ms) |
| 42.277–42.813 | Another config read (536 ms) |
| 43.387 | Routes mounted; diagnostic says `after 43388ms` |

**Warm bootstrap is calculated from warm events independently:** request-to-close **21.103 s**, request-to-headers **0.477 s**, first-to-last body write **20.625 s**, headers-to-close **20.626 s**. The cold request-to-close is separately **20.980 s**. Neither duration is inferred from the other. Close-to-Ready is **0.241 s**, Ready-to-runtime **0.164 s**, runtime-to-mount **10.363 s**. No fallback initialization request or bootstrap deadline fires.

The following nonoverlapping accounting sums to **43.387 seconds**. RunTask measurements use renderer main PID/TID 121, trace microseconds converted to CDP seconds; tasks crossing a boundary contribute only their overlapping duration. RunTask includes browser work beyond application JavaScript and is not a CPU sample or host measurement.

| Interval | Duration | Blocking operation and evidence/classification |
| --- | ---: | --- |
| Navigation → React request | 1.583 s | Asset revalidation, startup execution; about 1.007 s main-thread RunTasks, maximum task 223 ms. Cache responses complete by +0.932 |
| React request → initial RPC dispatch | 0.494 s | Provider/subscription setup and scheduling; 0.061 s RunTasks. Exact remaining scheduling dependency uninstrumented |
| Initial RPC dispatch → replies | 9.349 s | Waiting for bridge operations, overlapping initial evaluation-snapshot delivery. Only 0.494 s RunTasks, maximum 258 ms; not continuous browser execution. Snapshot arrives +11.186, invoke/replies follow. Host work versus queue/network delay cannot be separated |
| Replies → bootstrap request | 0.090 s | Config/auth dependency and browser scheduling; account/auth run concurrently, not two sequential 65-ms waits |
| Bootstrap request → headers | 0.477 s | Waiting for HTTP-service response; upstream work, round trip and bridge scheduling unresolved; 0.053 s RunTasks |
| Headers → complete body | **20.626 s** | **Longest blocking interval: streamed data delivery/body consumption.** Writes continue throughout; 1.011 s RunTasks, maximum 36 ms. Complete-body `fetchJson` dependency prevents Statsig readiness. Upstream production versus host/network delivery remains unresolved |
| Close → primary runtime | 0.405 s | Browser processing and initialization: 0.241 s to Ready plus 0.164 s to selection. 0.405 s overlapping RunTasks; tasks at +32.624 (101 ms) and +32.726 (660 ms, extends past selection). Cannot assign all time to JSON parsing |
| Runtime → first subsequent config completion | 8.790 s | Waiting for bridge/config operations overlapping snapshot publication/echo; 1.292 s RunTasks (includes tail of 660-ms task). Echo received +41.580, config completes +41.814. Ordering supports a delivery/queue hypothesis, not proof that snapshot acknowledgement gates mounting |
| Config completion → mount | 1.573 s | Further concurrent account/config work and render/route setup; 0.764 s RunTasks, maximum 264 ms. No direct route-prerequisite span identifies the final promise |

Bootstrap is approximately **48.6%** of warm startup including its header wait. Early and late snapshot transfers are outside that bootstrap interval; the outgoing snapshot at +32.952 and incoming echo at +41.580 overlap runtime/config work. Do not add snapshot wait times to these already inclusive intervals. CDP timestamps a complete WebSocket message, not the start of its transport delivery; there are no chunk timestamps for either large evaluation message. These are operation waits with observed delivery, **not demonstrated 9- or 10-second timers**. The trace records a 60-second bootstrap deadline installed at +11.513, but it does not expire during the successful fetch. Existing timer events do not establish a timer as the gate for either surrounding wait.

Byte-count correction to the earlier snapshot discussion: its 5,972,688/5,974,406 cold and 5,974,406/5,974,404 warm counts are Unicode string lengths, not UTF-8 bytes. Recounting complete received CDP `payloadData` with UTF-8 gives **6,424,126 / 6,425,846 bytes cold**, **6,425,846 / 6,425,844 bytes warm**. The warm outgoing set is 6,425,874 UTF-8 bytes. These remain decoded JSON-envelope sizes, not compressed transport sizes. Bootstrap base64-envelope and decoded-body counts above are unchanged.

### Catalogs: absent broadcasts and an observed alternative request path

Applied the **same extraction** to all four complete recording files: parse every received/sent CDP WebSocket JSON payload across all sockets (including top-level arrays for pubsub); examine direct `mcp-notification`/RPC objects; group `codex-host-chunked-message-v1` by transfer ID, validate sequence and start/end, and assemble object/array/key/value/string tokens using the served `app-shared` assembler's rules. Correlate request UUIDs with received results, not just outgoing completion logs. Raw substring checks are a supplementary cross-check, not the only detector.

The positive control reconstructs **two complete baseline warm `app/list/updated` messages, each 5,016 catalog entries / 340,741 tokens**, at +4.458–95.725 and +104.188–201.542; their previously measured identical token hash is retained above. It also detects an incomplete third transfer starting +335.256; baseline cold has an incomplete transfer starting +297.621. Both partial token streams identify `mcp-notification`, host `local`, method `app/list/updated`. The current files contain **zero chunk envelopes, zero direct or reconstructed `app/list/updated` notifications**, including after route mounting. Compression cannot conceal them from CDP's inflated payloads.

| Recording | Observable catalog request/result/subscription path | Last recorded WS frame / post-mount coverage |
| --- | --- | --- |
| Baseline cold | `app/list` +283.119, cursor null, limit 1000, forceRefetch false; no complete corresponding result before capture end. `app_notifications` subscribe +287.109, acknowledged +287.248, recovered false | +313.701 / 42.600 s |
| Baseline warm | Early two broadcasts precede this renderer's explicit `app/list` +319.062 with the same parameters; no complete corresponding result before end. Subscription +319.060, acknowledged +319.215, recovered false; third catalog begins +335.256 | +357.313 / 55.330 s |
| Current cold | `app/installed` +182.673 → result +184.166, 10 apps; `app/read` +184.297 → result +185.422, 10 apps, zero missing IDs. Subscription +184.839 → acknowledgement +185.019, recovered false | +204.192 / 23.060 s |
| Current warm | `app/installed` +45.278 → result +46.076, 10 apps; `app/read` +46.678 → result +47.497, 10 apps, zero missing IDs. Subscription +45.897 → acknowledgement +46.068, recovered false | +68.427 / 25.040 s |

No `app/list` request occurs anywhere in either current file. The current small received results have keys `apps` and `apps, missingAppIds`, respectively, rather than a full catalog notification. Their Python JSON serializations are approximately 1.2/4.7 KB (not raw-frame/wire measurements). Subscription success shows capture coverage of the notification channel; it does not guarantee a catalog broadcast should have occurred. No later catalog occurs **within these windows**; later delivery beyond +204.192/+68.427 remains unobserved. Baseline post-mount coverage is longer; its first startup broadcast began at +4.458, inside the current warm recording's absolute duration, while its second began at +104.188, outside it. Compare startup ordering as well as absolute recording length; the captures cannot exclude a current broadcast delayed beyond their end.

Authentication type and account/user identity match across the observed account results/evaluation snapshots; `getAuthStatus` reports `chatgpt`, `requiresOpenaiAuth: true`, authToken null. This is not an observed logout or different-account comparison. Both pairs use a fresh dedicated browser profile then same-context warm reload, with actual 304 asset revalidation. **Host/session cache state differs:** baseline cold subscription initially gets null evaluations and baseline warm gets a small snapshot with null payload; current cold and warm initially receive populated multi-megabyte payloads, SDK key and execution values. Matching user/account identity does not establish identical host caches, stable IDs, evaluations or server initialization state.

There is source support for the changed request path in the unchanged served `app-initial`: `zWt` around lines 80289–80347 selects legacy `app/list` when `shouldUseNewAppLifecycle` is false; when true it uses `app/installed` followed by batched `app/read`, falling back only on unsupported-method errors. Call sites pass gate **`403472035`** (for example line 130995). The current initial shared snapshots' parsed payloads have that gate **true**, version 48; baseline snapshots have null payload, and baseline startup falls back without usable evaluations. Thus successful feature initialization plus the new lifecycle path explains the **observed client request difference** without a changed asset hash. It does **not** prove why the two early baseline host broadcasts disappeared: those precede this renderer's explicit request/subscription. Host producer state, another renderer, cache priming or deployment changes remain hypotheses needing host logs. There is no evidence that duplicate suppression is necessary on the current path. Retain the first/changed-snapshot contract and investigate producers before proposing it.

### Cold shared script: headers are prompt, the uncompressed body is slow

The reported **72.35 seconds is navigation-to-completion**, not request duration. Live cold shared JS request is +0.320464, completion +72.347760: **72.027296 s elapsed**. `response.timing.requestTime` is monotonic 6301.424729; send starts/ends 89.092/89.139 ms later, at navigation +0.411484/+0.411531. Headers start/end 115.507/115.629 ms later, at **+0.437899/+0.438021**. Send-to-first-header is about **26.415 ms**; header-end-to-completion is **71.910 s**. The `responseReceived` event itself is reported at +72.386, after `loadingFinished`'s embedded timestamp; treating that event time as first byte would wrongly classify this as server TTFB.

| Property | Existing capture evidence |
| --- | --- |
| Asset | `app-shared-8bd9d0399038.js`, HTTP/1.1, status 200 cold |
| Content-Encoding | Absent; Resource Timing `contentEncoding` empty; request offered gzip, deflate, br, zstd |
| Content-Length / encoded body / decoded resource | **12,152,991 bytes each** |
| CDP loadingFinished encoded transfer | **12,153,306 bytes including response headers** |
| Resource Timing transferSize | 12,153,291 bytes (browser accounting uses a 300-byte header allowance); not an independent compressed-size estimate |
| Cache | `public, max-age=0`; ETag `W/"b9709f-1a1e7348766"`, Last-Modified 2026-11-17 01:52:21 GMT |
| Warm | Conditional revalidation, actual 304 in ExtraInfo, +0.169–0.321; 246 header bytes, cached body reused. Effective responseReceived status 200 is not a full retransmission |

The same-origin Resource Timing duration is 72,027.3 ms, responseStart 438.9 ms and responseEnd 72,348.8 ms relative to `performance.timeOrigin`; that origin precedes the CDP navigation request by about 1 ms. Both sources agree. Body-transfer average is about 169 KB/s; this is endpoint delivery under concurrent startup traffic, not a network capacity measurement.

Shared completion precedes the dynamically loaded initial script's request at +72.700 (its script initiator stack names `app-shared`, line 14421); initial JS finishes +135.767 and React is requested +137.457. Shared is therefore an early prerequisite, not a post-React operation. The cached warm pair avoids these body transfers. Slow delivery dominates this shared interval; background compilation may overlap it, but a 72-second main-thread parsing stall is not established.

The **smallest justified static-delivery change** is negotiated HTTP compression or precompressed Brotli/gzip for the existing large JS at the serving layer, with `Vary: Accept-Encoding`, correct encoding/validators and identity fallback; verify encoded versus decoded lengths on a cold request and actual 304 behavior on reload. It requires identifying the actual static/TLS serving layer first. No bundler rewrite or cache-policy change is needed to test that finding. Longer immutable caching of hashed assets could remove revalidation, but the measured warm revalidation is already subsecond and is not the large cold-body problem. WebSocket compression does not compress these HTTP asset responses.

### Priority, limitations and affected-client procedure

**One prioritized next measurement:** correlate the **warm bootstrap body**, the largest remaining dependency, across upstream fetch and bridge/browser delivery. On the deployment host record monotonic fetch-start, headers, first/last decoded upstream chunk, body-end, socket enqueue/send progress and `bufferedAmount`, tagged with fetch UUID / pull / stream / connection ID; align against the browser's first/last write and close. Record host CPU/RSS and build/process/proxy identity alongside it, omitting bodies and credentials. This one measurement separates a slowly produced upstream body from bridge/network queuing before choosing a payload or transport change. Do not raise deadlines or suppress catalogs based on the current evidence. Static compression is the separately justified cold-delivery candidate, not the explanation for the warm residual.

Observed total improvements remain **89.969 s cold / 258.596 s warm**. The portion caused by compression alone is **not identifiable**: host state, evaluation success and catalog request/notification behavior changed. The approximately **7.93 MB bootstrap is decoded content**; compressed live wire-byte counts remain unmeasured. Running Git/build identity, host metrics and the user's original WAN path remain unverified. No new capture from this workspace would establish that original-path behavior.

Compact affected-client procedure: on that client's original WAN, install Playwright/Chromium and run the existing two-load harness with a new private output directory and normal cache:

```sh
npm install --prefix /tmp/codex-startup-tools --ignore-scripts playwright
/tmp/codex-startup-tools/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/codex-startup-tools/node_modules/playwright \
CAPTURE_SECONDS=360 READY_SELECTOR='textarea, [contenteditable="true"]' HEADED=1 \
node scripts/diagnostics/capture-startup.cjs \
  https://z170-1.tailddb1d3.ts.net:8214/ /tmp/startup-affected-wan
```

Record client/browser version, UTC time, actual account/session, Tailscale `status` and `ping z170-1.tailddb1d3.ts.net` path (direct/relay), and running asset hashes; confirm screenshots and route logs. This procedure creates a fresh browser profile, so label it as such; separately reproduce in the affected existing profile if session-specific behavior is suspected. Preserve the first run as cold and its same-context reload as warm. Repeat from LAN with a separate fresh directory only if making a WAN/LAN comparison. Keep profiles, bodies and tokens private; share timing summaries and redacted captures. For the prioritized measurement, collect the host spans during this pair. A HAR alone omits tunneled bootstrap stream timing. Extend capture only if resolving a specific later-notification question; the existing current windows already cover installed/read replies and subscription acknowledgements.

Analysis checks: re-extracted all four recordings, reconstructed both complete baseline catalogs as a positive control, checked current replies and subscription coverage, calculated warm intervals independently, compared embedded CDP/Resource Timing asset clocks and renderer RunTask overlap. Temporary analysis helpers/results are `/tmp/startup-decompose.py`, `/tmp/startup-extra.py`, `/tmp/catalog-check.py`, `/tmp/warm-trace.py` and corresponding logs; authenticated inputs remain outside Git. This update changes documentation only.


## Implementation and local validation

The static patch uses the installed `@fastify/static` precompressed-asset feature on the packaged webview registration, plus `Vary: Accept-Encoding`. A dependency-free build step writes Brotli quality-9/gzip level-9 siblings after upstream preparation and the browser preload build. Existing npm/Nix packaging includes them. Build-time compression fits stable multi-megabyte assets, avoids request-time compression competing with bootstrap, and leaves WebSocket/upstream/body semantics and cache policy independent. `/@fs` does not enable precompressed delivery.

**Measured locally**, using the exact recorded shared/initial JS bodies (cache header excluded, SHA-256 matches the recorded hashes) and actual shared CSS fetched from the endpoint/recovered from cache:

| Asset | Identity bytes | Brotli bytes | Gzip bytes | Brotli reduction |
| --- | ---: | ---: | ---: | ---: |
| Shared JS | 12,152,991 | 2,349,459 | 2,804,700 | 80.67% |
| Initial JS | 18,311,126 | 3,494,172 | 4,270,110 | 80.92% |
| Shared CSS | 1,268,149 | 136,186 | 165,856 | 89.26% |

Validation used Node 22.23.3 and the installed Fastify/static versions. The reusable `validate-static-compression.cjs` check passed Brotli/gzip negotiation, explicit identity and q=0 exclusion, decoded-byte equality, MIME type, exact Content-Length, Vary, same-representation ETag/Last-Modified 304s with empty bodies, and compressed ETag→identity 200 responses. Weak ETags belong to the selected physical representations; siblings inherit the source modification time. Source cache policy remains `public, max-age=0`.

**Chromium local application smoke passed:** a fresh headless Chromium 156 page served recorded application assets through the new local Fastify configuration, with the live deployment's bridge proxied for authenticated startup. The composer became visible and no page errors occurred. This validates actual compressed modules loading together, not a complete newly packaged deployment: the application smoke used recorded preload; the changed browser shim was separately bundled and exercised in Chromium. No full upstream archive/prepared `scratch/asar` exists here, so the full pinned-archive build remains a deployment-host check. Other recovered assets and occasional missing resources used the existing deployment. The first attempt had a binary/text bug in the temporary WebSocket proxy, was corrected, and is not a performance result.

Chromium Resource Timing confirms Brotli encoded/decoded sizes: shared JS **2,349,459 / 12,152,991**, initial JS **3,494,172 / 18,311,126**, CSS **136,186 / 1,268,149** bytes. TransferSize is respectively **2,349,759**, **3,494,472**, **136,486** bytes (Chromium's 300-byte allowance). Local durations were 147.8 ms, 191.9 ms and 21.2 ms. These are **loopback static delivery with a remote application bridge**, not live cold-start measurements or estimates of WAN startup duration. The temporary smoke output and screenshot are `/tmp/static-compression-validation/browser.json` and `app.png`; sanitized retained evidence is [validation JSON](static-compression-validation-2026-11-17.json). Raw capture inputs and private caches remain outside Git.

**Diagnostic validation:** the server typecheck, delayed two-chunk local upstream/real-WebSocket test, cancellation/redaction checks, and actual browser-shim bundle/Chromium receipt test pass. Instrumentation is default-off and independent of static compression. It records request UUID propagation, upstream headers/read-start/read/body-end, per-connection stream IDs, bridge sequence and cumulative bytes, serialization/enqueue/local callbacks, queue observations, and browser receipt/dispatch/close. Nearby clock probes bound host/browser offset instead of assuming synchronized wall clocks. Upstream reader and bridge chunks can differ; cumulative decoded byte ranges provide the cross-boundary join. Downstream evaluation publication/mount markers are labeled latest-bootstrap associations, not exact SDK parse spans. Details and reproducible commands are in [bootstrap delivery diagnostics](bootstrap-delivery-diagnostics.md).

**Expected benefit:** the measured 72.027-second cold shared-script request mostly transfers an uncompressed body; removing ~80.7% of those body bytes should materially reduce that dependency on a similarly constrained path. Actual speedup depends on throughput, concurrency, cache and CPU, so no scaled duration is presented as a measurement. HTTP compression does not explain or fix the 20.626-second warm bootstrap body interval.

**Pending live observations:** authenticated host access remains unavailable (existing SSH attempt was rejected; no credentials are present), the running Git/process/proxy identity remains unverified, and the 04:37 UTC HEAD still shows identity delivery. Do not rerun another multi-minute capture merely to reobserve the old deployment. After the host deploys this revision, collect a fresh cold/warm pair with the host diagnostics and CPU/RSS: public negotiated lengths/validators, first/last upstream reads and completion, bridge enqueue/buffer/write progress, calibrated browser receipts/close, and Ready/runtime milestones. Until those correlated spans exist, the dominant portion of the 20.626 seconds **cannot be assigned** to upstream reception, bridge pacing or browser delivery. In particular, delayed consumer pulls can delay upstream reads; early/late reader completion alone is insufficient to prove upstream production speed.

The user's original affected WAN path remains an **outstanding requirement**, distinct from both this local smoke and the investigator's remote tailnet path. Current recordings already establish installed/read catalog access and no large catalog broadcasts in the measured windows. No catalog suppression change or redundant catalog capture was made.
