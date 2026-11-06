# Startup and plugin RPC investigation (Task 3)

## Finding and scope

No reproducible root cause is established. The dominant reported startup gaps
are before port registration and between port registration and observation of the
route effect. The available plugin records establish application response routing,
but cannot locate the subsequent delay. No behavioral fix, timeout adjustment,
retry change, or temporary query gate is justified.

Source inspected at revision
`f0ef8ee9d1a5c8a3c852fec5ba5cfa07ada88974`, which includes Task 1 correlation
and retention correction `9e60fae`. Prepared upstream package:
`26.1007.30912`; request and startup hooks are present in the prepared modules.
Node `v22.23.2`, npm `10.9.8`. Historical logs do not establish their exact
source revision, serving mode, browser version, foreground state or cache state.
They must not be treated as captures made on this revision.

No Chrome/Chromium executable or browser automation connector was available.
The Codex CLI was also absent from PATH. Authenticated live startup and plugin
retrieval were therefore not exercised; Chrome CPU/Network traces, repeated
controlled loads and before/after measurements are unavailable.

See [startup phases](startup-performance.md),
[plugin source analysis](plugin-installed-timeouts.md), and
[diagnostic field semantics](diagnostics.md#timing-fields-and-complete-request-exports).

## Measurements and boundaries

These rows are separate observations, not additive phases or comparable trials.
“Reported” means the Task 3 input, not a fresh measurement.

| Evidence | Interval | Duration | Interpretation |
| --- | --- | --- | --- |
| Reported | Navigation to route effect | ~218.5 s | Browser navigation-relative total; CPU/idle/transfer split unknown |
| Reported | Server renderer ready to first port registration observed | ~118 s | Includes browser work and delivery; not server initialization time |
| Reported | Port registration to route marker observed | ~92 s | Includes browser work, dependencies and marker delivery |
| Reported | Application plugin routing | 8 ms, 25 ms | Not browser receipt or Promise settlement |
| Reported | Plugin timeout threshold | 30 s | Configured deadline, not proof timer ran on time |
| Reported | Ordinary bridge request round trip | Median ~2.8 s | Includes outbound queue, transport, handler and browser dispatch |
| Reported | Server handler-to-send-callback | Generally <2 ms | Local interval; does not isolate network or browser time |
| Reported | JavaScript HTTP response | ~27.5 s | Server HTTP lifecycle; not measured browser download/parse time |
| Local server-004 capture | Renderer readiness work | 2.331 ms | Local initialization duration |
| Local server-004 capture | Ready to first port registration | 868.009 ms | Server monotonic difference: 10241.971517 − 9373.962574 |
| Local server-004 capture | Navigation to route effect | 49.934 s | Upstream renderer log; one uncontrolled load |
| Local server-004 capture | Bridge handler completion duration, n=883 | Median 0.453 ms; range 0.094–347.068 ms | Receipt-to-completion, includes readiness waiting; captured population only |
| Local server-004 capture | Plugin routing for 641c5e4b-9610-4815-acf0-c42c7bff820a | 25 ms; queue wait 2 ms | Later timeout and missing-Promise warning for same ID |

Local rows come from untracked `npm-run-server-004.txt`, connection
`2036a071-1513-4756-a2a3-9d1db769b132`, renderer webContents 2001.
The capture has 883 handler completion records. Durations above are computed
from JSON records, not inferred from nearby console output. No
`sendCallbackMs` values exist in that capture. Some outer bridge IDs appear as
`rpcId`, demonstrating that its metadata cannot substitute for corrected Task 1
captures. Raw logs remain local and are not part of this report's commit.

Do not subtract 118 + 92 from 218.5 to invent an asset phase: those observation
boundaries are not all in the browser clock domain. Likewise, subtracting a
server handling median from a browser RTT median does not identify a network
median. No controlled per-condition median/range is available yet.

## Causal timing model

Arrows identify message causality, not synchronized clock offsets. B and S
timestamps are monotonic within browser and server respectively.

```mermaid
sequenceDiagram
    participant B as Browser application
    participant Q as Browser bridge / MessagePort
    participant S as Server bridge
    participant H as Electron stub / app host
    B->>B: B0 registered; B1 started (deadline begins)
    B->>Q: Application queue dispatch / port message
    Q->>Q: B2 queue.enqueue
    Q->>S: B3 transport.send-api
    S->>S: S0 transport.receive; renderer wait; S1 ipc.dispatch
    S->>H: handler or port forwarding / registration queue
    H->>H: Application handling; upstream response_routed
    H->>S: S2 response.route (routing intent)
    S->>Q: S3 send-api; S4 dispatch-complete (local write callback)
    Q->>Q: B4 transport.receive (decoded WS callback)
    Q->>B: B5 port.forward / ipc.dispatch-complete
    B->>B: B6 response or late-response lookup
    B->>B: B7 completed / failed / timed-out
```

Use `(pageId, rpcId)` for application lifecycles; join to
`(connectionId, requestId)` or `(connectionId, portId)` only through records
carrying both identities. Include serverId and renderer.ready webContents
association. Never join by a local bridge ID alone. Recover response method
classification from registration if it is absent on the response.

Observable intervals: B1−B0 covers application scheduling before start; B3−B2
covers outbound bridge queue wait; S1−S0 covers readiness/decode/dispatch;
S4−S3 covers local socket write; B6−B4 covers browser dispatch through response
lookup. B7−B1 measures lifecycle elapsed time; the completion hook is settlement
path evidence, not evidence that a consumer's Promise continuation ran.
Application enqueue-to-start is not separately instrumented beyond registration
and lifecycle hooks. Host handling has no complete correlated monotonic span in
the old captures. Handler records for outer bridge invokes do not automatically
measure the asynchronous application RPC carried inside them.

The WS receive hook executes after browser event scheduling and JSON decode;
it is not a NIC arrival timestamp. Port forwarding calls postMessage and is not
acknowledgement by the application listener. For MessagePort replies, the gap
from WS receipt to application lookup also includes asynchronous port delivery.
Current port.forward records have port identity but no rpcId; use the enclosing
RPC-correlated WS receive/dispatch records and B6, rather than assigning every
message on that port to one request. Queue events and port traffic can be sampled
when uncorrelated; absence alone proves nothing. Check dropped/suppressed counts.

## Ranked findings and uncertainties

1. **Confirmed delay, unresolved cause:** the reported ~118 s and ~92 s gaps
   dominate startup. Fast renderer readiness excludes its measured work as the
   explanation for those gaps. It does not exclude later host dependencies.
2. **Confirmed routing, unresolved delivery:** the local plugin ID above has
   response_routed, timeout, then missing-Promise output in file order.
   hadPending=true, targetDestroyed=false and broadcastFallback=false support
   intended renderer routing. Untimestamped upstream lines cannot establish
   precise execution ordering or browser receipt. Routing is not proof of
   successful result content, socket write, port delivery or response lookup.
3. **Confirmed timeout cleanup mechanism:** source deletes the pending entry on
   timeout; late onResult then warns. Thus a missing-Promise warning is consistent
   with a consequence of timeout. It does not explain the original delay.
4. **Unresolved:** browser main-thread blocking versus network/proxy delay versus
   transport queueing. Small server handler intervals narrow only that boundary.
   There is insufficient evidence to label any one explanation probable.
5. **Unresolved contributors:** large generated bundles, repeated initialization,
   Statsig and its 10-second race/fallback, RPC bursts, React work and port readiness.
   Inspect counts, stacks and dependency timing before changing them. Module
   size and warning count are not execution measurements.
6. **Confirmed historical asset fallback, unresolved startup impact:** earlier
   diagnostics recorded HTML fallback for asset-classified requests. Their coarse
   classification cannot separate executable assets from source maps. Current
   revision already contains the separate static-route fix; this report neither
   attributes the startup gaps to it nor claims an improvement from it.

## Reproduction and capture contract

Use an already prepared checkout and signed-in CLI host. Do not run asset
preparation against an unrecorded archive during a comparison. First record:

```bash
git rev-parse HEAD
git status --short
node --version
npm --version
node -p "require('./scratch/asar/package.json').version"
sha256sum scratch/asar/webview/assets/app-initial-6350d04672d0.js scratch/asar/webview/assets/app-shared-8bd9d0399038.js
google-chrome --version
command -v codex
npm run build:server
npm run build:browser
```

Built mode (one server, no Vite):

```bash
CODEX_WEB_LOG_LEVEL=trace CODEX_CLI_PATH="$(command -v codex)" node src/server/main.js --port 4173 >built.stdout.log 2>built.server.log
```

Development mode, after stopping built mode, in separate terminals:

```bash
CODEX_WEB_LOG_LEVEL=trace CODEX_CLI_PATH="$(command -v codex)" node src/server/main.js >dev.stdout.log 2>dev.server.log
npm run dev:browser >dev.vite.log 2>&1
```

Launch one foreground Chrome window with a dedicated profile, then keep one tab:

```bash
google-chrome --user-data-dir=/tmp/codex-web-task3-profile --new-window http://127.0.0.1:4173
```

Record the actual browser binary/version, full commands, OS/machine, account
label, route, upstream hashes, proxy path and throttling settings. Keep them
constant. Enable trace via localStorage as in [diagnostics](diagnostics.md).
Use Chrome Performance record-and-reload and Network Preserve log. Collect at
least three warm-cache and three cold-cache loads **per serving mode** (12
minimum); use Disable cache for cold runs, record its state, and keep warm-up
loads separate. Do not clear account storage as a substitute for cache control.

For every run preserve: manifest of conditions, browser diagnostics JSON with
dropped/suppressed counters, full browser console, server stderr/stdout,
development Vite output when applicable, Chrome Performance trace and Network
HAR. Keep captures through route effect and at least 35 seconds after dispatch
of a failing plugin RPC; continue through late response or recovery if later.
Sanitize before sharing; retain originals locally.

For startup, record navigation/requestStart/responseStart/responseEnd from
Network/Resource Timing, Compile/Evaluate Script stacks before bootstrap,
bootstrap-start, host-services entry, port registration, react-request and
routes-mounted. host-services is entry to initialization, not completion.
Separate transfer/wait from parse/evaluation and idle awaited dependencies;
the first route effect is only a commit proxy, not an exact first-commit timestamp.
Inspect first React commit in the Performance trace. Count repeated phase marks,
Statsig spans, RPC registrations per second, long-task total/max and timer
lateness. Check missing resources by status, MIME and initiator, separating maps
from executable assets. Inspect port registration/wait/flush and socket lifecycle.

For plugins, follow one exact rpcId through all diagram boundaries. The last
observed boundary and first missing one define the next interval to investigate:
routing without write needs target/send evidence; write without browser callback
needs Network plus main-thread evidence; receipt without lookup needs port/listener
and renderer ownership evidence; lookup after timeout needs local ordering and
timer lateness. If retained diagnostics cannot isolate the interval, add a narrow
observation there before attempting a behavioral fix.

Report each condition's sample count, median and min–max for startup phases,
RPC queue/handling/dispatch/settlement and timeout rate (timeouts/dispatched
plugin requests). Retain failed loads explicitly; do not silently omit them from
startup summaries. Never pool dev/built, warm/cold or historical captures.
Only after reproduction identifies a cause: add a regression test, make the
smallest correction and repeat equivalent conditions before claiming improvement.

## Local validation

Passed: 13 diagnostics tests, one Git watcher test, two built/Vite static-route
tests, TypeScript server build and browser build. Vite static-route tests emitted
missing source-map and dynamic-import analysis warnings but passed. These checks
validate existing diagnostics and serving behavior; they do not reproduce the
startup delay or authenticated plugin timeout. No regression test or runtime
change was added because no root cause was reproduced.
