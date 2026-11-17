# Approved isolated resource-budget validation

Authorization scope: further isolated validation only, continuing from `ed3fd8e`.
No production deployment, restart, configuration change, or live A/B was performed.
**Recommendation: NO-GO for a controlled live trial.** The fixed budgets still stop
ordinary stalled/canceled/disconnected workloads in both A and B. This is an
acceptance failure, not a reason to increase the queue allowance.

[Measurements](budget-quantitative.md), [exact per-run CSV](budget-metrics.csv),
[numeric records](budget-results.jsonl), [host/provenance metadata](budget-metadata.json),
[isolated supervisor rehearsal](budget-rehearsal.json), and [private kernel-network configuration](budget-netem.json) contain the evidence.
The earlier [guard review](guard-review.md) remains the historical proposal; this
report defines and tests the approved **isolation-only** implementation.

## Measured outcome

The final dataset contains **112 cases**: 96 application-model/admission/boundary
cases and 16 real Linux netem cases, each using balanced AB/BA pairs. All harness
assertions completed: **56 observe-mode cases completed their intended work**;
stop mode completed **21** cases and correctly aborted **35** on a budget breach.
A correct budget stop is a failed deployment-acceptance result, not a performance
pass. The 14 unit/asset/safety tests and isolated service rehearsal also pass.

| Worst observed value                      | Observe (safeguard off) |  Stop safeguard on |                  Budget |
| ----------------------------------------- | ----------------------: | -----------------: | ----------------------: |
| Estimated flight, all streams             |               4723272 B |          3411252 B |               8396928 B |
| Logical decoded retention, all streams    |               1114112 B |           786432 B |               2097152 B |
| Forward transport ledger, one connection  |                786958 B |           523022 B |                524288 B |
| Forward transport ledger, all connections |               1486424 B |           990544 B |               1048576 B |
| Entire measured group RSS                 |             1460.30 MiB |        1444.23 MiB | 1536 MiB stop threshold |
| Worker RSS / JS heap                      |      148.45 / 51.85 MiB | 144.51 / 51.24 MiB |            256 / 96 MiB |
| Whole Chromium tree RSS                   |             1250.01 MiB |        1237.94 MiB |                1280 MiB |

Component maxima need not be simultaneous. The 81920-byte boundary write measured
**327939 estimator bytes**, below the predeclared 328192 ceiling. Uniform writes
first rejected **524592 B** against 524288; boundary writes first rejected **546385 B**.
Packet-level variable-latency trials first rejected a combined **524632 B** forward
reservation. These stops were retained rather than rounded away.

With safeguards enabled, modeled variable-latency aggregate throughput improved
**70.19%** for uniform writes and **52.05%** for mixed-size writes. Bandwidth- and
consumer-limited models changed by about 0%. In real netem variable-latency
**observe-only** tests, throughput rose **1.2968 → 2.0154 MiB/s (+55.41%)**, with no
higher peak forward ledger or WebSocket API buffering in B. Those physical-path
runs violate resource acceptance in both variants; their gain is not approval to
run B without containment. The real 8-Mbit/s case improved less than 1%.

Normal cancellation reached the source within **83.71 ms** of the host-recorded
browser action notification; disconnect reached affected sources within **8.32 ms**.
Host flight/credit cleared within **1.37 ms after detected TCP close**. These use
one host clock and include local observation-binding overhead. Healthy streams
and the other client complete correctly in observe-mode cancel/disconnect cases.
Final credit, flight, source reservations, pacing queues and writer data are zero.
The final teardown check took at most **325.4 ms after clients finished**, including
real netem close propagation; it is not the entire body/tail drain time. Kernel
qdiscs were empty at the post-worker check; no additional drain wait was needed.

The short three-wave observe-mode soak reuses the same processes and connections.
Every wave has zero retained flight/decoded/transport reservation at its barrier.
Post-GC heap changes are small and include test metadata; this is not a long-term
leak clearance. Guarded soak runs stop on the forward limit before all three waves,
so they **do not pass** recovery/resource acceptance under the selected budgets.

## Independent limits and accounting

The experiment supports at most **two clients/connections with two active body
streams each**. Third-client and third-stream probes exercise real RPC admission
and rejection. Identifiers are private fixture labels, not historical capture IDs.
Admission limits are enforced before constructing a new body source; excess
admission stops the trial rather than silently admitting more traffic.

| Resource                                           | Per stream |                    Per connection |               All trial connections/processes |
| -------------------------------------------------- | ---------: | --------------------------------: | --------------------------------------------: |
| Estimated outstanding credit                       |  2099232 B |                         4198464 B |                                     8396928 B |
| Adaptive-window target                             |  1771040 B | Each window independently limited | Same rule for all active and retiring windows |
| Logical retained decoded data                      |    512 KiB |                             1 MiB |                                         2 MiB |
| Host forward application + socket/kernel TX ledger |        n/a |                           512 KiB |                                         1 MiB |
| Browser receive/MessagePort queue                  |        n/a |                           256 KiB |     At most 512 KiB with two admitted clients |
| Browser delayed reverse/control queue              |        n/a |                            32 KiB |      At most 64 KiB with two admitted clients |

The original 1-MiB live-trial stop remains unmodified. In this approved isolated
plan it is retained as an investigation alert, alongside the split limits. The estimator alert remains useful, but it is not a byte-for-byte
memory limit. No live guard was changed. The split thresholds above are authorized
only for these isolated tests. The 512-KiB forward-connection / 1-MiB forward-total
budgets were **not rounded up** to admit six 87432-byte JSON messages (524592 B).
The receive and reverse limits make previously implicit client-side queues
explicit. They are additional scopes, not permission to borrow from the forward
budget: the sum of all serialized component ceilings is 1600 KiB across two peers.
This is not an exact physical heap total; representations may overlap or be copied.

Decoded retention is reserved synchronously before generating/enqueuing source
bytes, then released on observed browser consumption or source/connection teardown.
It conservatively counts logical payload while data may still be encoded. Real
browser writer-argument bytes are also measured; their per-page peak sum is an
upper bound, not a simultaneous aggregate peak. The reservation ledger is the
simultaneous aggregate bound. Estimated credit remains charged until ACK/error even after body consumption, so
retiring windows count toward the connection and global flight budgets. Canceling one source releases its own reservation
without releasing another source's credit.

Forward JSON is charged **before** entering the pacing queue and released when its
send callback releases the retained string. WebSocket API buffering is checked
immediately after sends and during sampling; TCP TX sequence bytes come from
`/proc/net/tcp` for the owned sockets. These are separate components in the forward
ledger. Kernel TX is sampled and can miss short peaks; it is not kernel socket
allocation size. Receiver and ACK/control queues check their own counts locally.
Unknown proxy/compression buffers are not magically covered by this instrumentation.
A future actual path must expose those queues or retain a NO-GO result.

### Atomic overshoot and adaptive growth

Typical 64-KiB writes cost 262404 estimator bytes, as before. The original trace
also contains **80072 decoded / 320547 estimated bytes**. The mixed-size test uses
16-KiB, 64-KiB, 80072-byte and 64-KiB chunks, with real serialization and exact byte
verification. The isolated profile admits at most **81920 decoded bytes** per
atomic write, with a conservative **328192 estimator-byte** ceiling (`4 × 81920 +
512` for this plain-byte RPC shape). This is a fixture-specific bound, not a
conversion rule for arbitrary RPC objects; unknown shapes require new calibration.

The flight allowance stays at eight typical writes: `8 × 262404 = 2099232`.
Reserving the larger atomic ceiling lowers the permitted window to
`2099232 − 328192 = 1771040`. This **reduces** the earlier 1836828-byte window target
allowance rather than increasing flight or decoded budgets. A source reservation
that would exceed a decoded or owned forward-queue limit fails before enqueue.

The Desktop controller remains unchanged: initial 262144, maximum 1073741824,
minimum 65536 (A) or 524288 (B), original gains/ACK/ordering/cancellation paths.
The observer checks the real send-time window and actual estimator charge. A
window or credit breach stops the isolated trial; it never clamps the controller,
changes writer settlement, or acknowledges unconsumed bytes. The estimator is
updated after an atomic send, so a credit observation may include one new write;
window headroom and pre-reserved payload/JSON prevent treating that overshoot as
unlimited permission. Socket/receiver allocation can precede observation by one
complete bounded frame; such checks are stop thresholds, not allocator controls.

`ResourceBudget` is a separate experiment module, disabled by default, introduced
in `b25f4fb`. It is not imported by the production server or ordinary preparation
pipeline. Nonfinite targets/memory readings and missing required RSS observations fail
closed in stop mode. The validation explicitly compares **observe** and **stop** policies in
both A and B. Stop mode latches the first violation, refuses new reservations and ready-queue sends, and
terminates only owned fixture transports; the original failure path rejects credit
and cancels production. A stopped transfer is a rejection, never successful EOF.
The isolated fixture supervisor separately opts into its memory watchdog.

## Process memory and host headroom

Preflight reported **32536680 KiB MemTotal** and **25462568 KiB MemAvailable**
(about 31.0/24.3 GiB). A **2-GiB planning allowance** is below one eighth of that
reported available RAM, leaving more than 22 GiB at that snapshot. It is neither
an OS reservation nor a guarantee that later workloads will leave that headroom.
The metadata records another host snapshot after validation.

| Memory dimension                               |                Independent stop threshold |
| ---------------------------------------------- | ----------------------------------------: |
| Controller RSS                                 |                                    96 MiB |
| RPC worker/server RSS                          |                                   256 MiB |
| RPC worker JS heap / external bytes            |                               96 / 64 MiB |
| Summed renderer RSS                            |                                   768 MiB |
| Attached renderer JS heaps                     |                         128 MiB aggregate |
| Entire Chromium process tree RSS               |                                  1280 MiB |
| Controller + worker + entire Chromium tree RSS |                              **1536 MiB** |
| Proposed kernel-enforced trial-group ceiling   | **2048 MiB**, not available/enforced here |

Component maxima cannot all be reached together: the 1536-MiB group threshold
binds first. Renderer RSS is a subset of Chromium RSS; JS heap and external buffers
are not added again to RSS. Summed RSS conservatively double-counts shared pages.
The fixture has two active page targets plus spare renderers; the aggregate cap
also counts extra renderer processes rather than multiplying the allowance.
Attached-target heap measurements exclude unconnected isolates, which remain
covered by process-tree RSS.

The earlier provisional 512-MiB renderer / 768-MiB entire-browser ceilings failed
at the two-page fixture's baseline: the complete Chromium tree was about 1.18 GiB,
not the smaller renderer-only number. The revised absolute ceilings follow this
process inventory and fixed planning envelope. They do **not** change the flight,
decoded or forward queue allowances; resource stops still occur in A and B.

Bundle extraction was separately measured at **787712 KiB peak RSS** and 4.22 s.
It finishes before any Chromium clients start. Bundle extraction now runs in an exiting preparation process before transfers;
keeping its TypeScript AST memory resident would contaminate the controller's
footprint. The measured controller itself is included in group RSS, as are browser,
zygote, GPU and utility descendants. Memory is sampled every 100 ms; workers also
have a 256-MiB V8 old-space limit. V8 old-space is not a total RSS limit.
The private supervisor reads its owned server child's RSS independently, so a
blocked child event loop does not disable that watchdog. Tests inject a labeled
synthetic over-budget sample into both child and supervisor paths without
allocating dangerous amounts of memory.

Direct cgroup memory files are unavailable/read-only in this sandbox. Read-only
systemd queries report `MemoryMax=infinity` on the visible session/user scopes;
`MemoryCurrent` includes unrelated work and file cache, not this trial alone.
A uniquely named isolated `systemd-run --no-ask-password ... MemoryMax=... /usr/bin/true`
probe was rejected with **“Interactive authentication required.”** No unit started.
Thus the observed 1536-MiB stop is a sampled watchdog threshold, **not a hard
allocation guarantee**. The 512-MiB planning margin cannot prove that an arbitrary
allocation burst is safe. A verified kernel/group limit is a live-readiness gate.

## Conditions, concurrency and recovery

The final dataset has two balanced AB/BA pairs per workload and policy. Every run
uses two independently connected Chromium clients with two simultaneous streams,
except the deliberately excessive-stream probe. Source chunks are generated on
demand with highWaterMark zero, carry distinct client/stream byte patterns, and
are checked in order through EOF or explicit failure. The models retain the same
latency/bandwidth/consumer parameters in A and B:

- Variable latency: 5-ms forward propagation through four writes per connection,
  then 130 ms; 30-ms ACK delay; 8 MiB/s serialized JSON per connection. Both uniform
  64-KiB and mixed-size bodies are tested.
- Bandwidth-limited: 40-ms forward and reverse delay; 256 KiB/s JSON per connection.
- Slow consumer: 20-ms forward / 40-ms ACK delay, 2 MiB/s JSON, 100 ms/read.
- Stalled consumer: stop each stream after eight consumed chunks for two seconds,
  then resume. Source counts must plateau between the settled middle/end samples.
- Cancellation: cancel one stream after six chunks; the other stream on the same
  connection and both streams on the other connection must complete correctly.
- Disconnect: close one client connection during active delivery; its reads reject
  and its producers cancel while the other connection completes.
- Recovery soak: three transfer waves reuse the same processes/connections. A
  cross-client barrier collects post-GC memory and empty-pipeline snapshots after
  each wave. This is a short soak, not a proof of long-term leak absence.
- Negative probes: a third idle client, a third active stream per connection, and
  an intentionally one-byte reverse-queue allowance. Stop mode must reject these;
  observe mode records the breach and verifies the permitted fixture work.

Pacing is a measured application FIFO before real loopback WebSockets, followed
by the real MessagePort/browser RPC core. These application-FIFO cases are controlled models, not actual
WAN, production compression, tailnet loss, proxy queues, or whole-application
startup measurements. Additional packet-level tests are described below. The FIFO shaper regression from the previous task remains
in place. No change bypasses the source await, remote writer settlement or ACK.

## Real packet-level network validation

Unlike the application pacing model, these additional tests use Linux **netem**
in a fresh **user/network namespace**. The runner compares its network namespace
inode to the recorded parent and refuses any qdisc command if they match; a unit
test verifies refusal before creating artifacts. Only the new namespace's loopback
is brought up and changed. Parent qdisc configuration is saved, and remains
`noqueue`; no production interface, listener or service is touched.

The loopback MTU is **1500**, with **TSO, GSO and GRO disabled** and read back.
Each pair uses the same seed (20261118 or 20261119). Two connections/four streams
run with application pacing effectively unlimited and no added ACK delay:

- `netem-bandwidth`: 25-ms packet delay, shared 8-Mbit/s rate, 16 chunks/stream.
- `netem-variable`: 25-ms delay / 64 Mbit/s, then 100-ms delay with 20-ms jitter,
  changed 400 ms after the first source byte; 48 chunks/stream.

All 16 cases finish with the expected complete/budget-stop result. Every complete
case has all successful write ACKs before shutdown. Qdisc counters show **zero
packet drops**, and an empty queue at the post-worker check. Stop-mode variable
trials breach the forward budget during startup; their scheduled later delay change
does not turn them into completed variable-delay performance samples. Observe-mode
transfers continue through the changed-delay phase and provide the quoted gain.

Real kernel buffering is material: host WebSocket `bufferedAmount` peaks at
**87442 B**, and sampled aggregate TCP TX sequence bytes reach **1224188 B**.
The forward ledger reaches **786958 B per connection / 1486424 B aggregate** without
stops, exceeding the 512-KiB / 1-MiB plan. With stops, the largest accepted forward
connection ledger is **523022 B**, only 1266 B below its limit in the 8-Mbit/s case.
The small margin and rejected variable-delay trials support a NO-GO, not a rounded
or newly fitted queue limit. TCP TX sequence bytes still are not kernel allocation
bytes; real proxy and compression buffers remain unmeasured.

An earlier exploratory B run, before the fixed MTU/offload/seed controls, ended
with `Target page, context or browser has been closed` under a configured 120-s
worker deadline. RPC state at exit was not captured, so its cause is **not
established**; it is not attributed to the controller or claimed fixed by changing
the network setup. It is excluded from the final paired dataset and retained in
[the exploratory note](budget-exploratory-note.json). Default-offload/path behavior
needs further validation before any live recommendation; passing the fixed-control
matrix does not erase that observation.

These are isolated kernel-network tests, not the actual tailnet/CFFV5 path or an
authenticated Desktop startup. They improve confidence in the queue measurements
but do not establish production resource headroom or route/editor readiness.

## Deployment and rollback rehearsal

The rehearsal stages private immutable extracted-core A/B releases with manifests,
not a running production artifact tree. It launches a real HTTP/WebSocket RPC
service under a supervisor that controls only children it forked. Its endpoint is
an ephemeral loopback port; its control socket and state live in a new mode-0700
`/tmp` directory. No production account, CLI socket, profile, proxy or port is used.

The saved commands are actual subprocess CLI invocations:

```bash
node scripts/diagnostics/rpc-isolated-supervisor.cjs init "$rpc_stage" "$rpc_cores"
node scripts/diagnostics/rpc-isolated-supervisor.cjs serve "$rpc_stage"
node scripts/diagnostics/rpc-isolated-supervisor.cjs start "$rpc_stage" baseline
node scripts/diagnostics/rpc-isolated-supervisor.cjs status "$rpc_stage"
node scripts/diagnostics/rpc-isolated-supervisor.cjs stop "$rpc_stage"
node scripts/diagnostics/rpc-isolated-supervisor.cjs start "$rpc_stage" 512k
# On any stop condition: stop, verify listener release, then start baseline.
node scripts/diagnostics/rpc-isolated-supervisor.cjs stop "$rpc_stage"
node scripts/diagnostics/rpc-isolated-supervisor.cjs start "$rpc_stage" baseline
node scripts/diagnostics/rpc-isolated-supervisor.cjs shutdown "$rpc_stage"
```

The automated `rehearse` command performs the whole sequence and additionally:
verifies loaded SHA/runtime constants and a 1-MiB ordered body in A, B and restored
A; stops while a consumer is stalled and requires read rejection; refuses a corrupt
candidate before activation; reaps a SIGKILLed child; injects child and independent
supervisor memory stops; reactivates unchanged baseline; and verifies no listener
remains. A normal stop uses SIGTERM, waits for exit, and escalates only the owned
child to SIGKILL after three seconds if necessary. The measured rehearsal did not
need forced normal-stop escalation. There is no uncontrolled restart loop into B.

This is a complete lifecycle rehearsal **for the isolated RPC fixture service**.
It is not a production Desktop daemon, authenticated application, or production
service-manager rehearsal. In particular, production proxy routing, cache and
compression sidecars, editor readiness, full application memory, and account state
were not exercised. The actual production supervisor identity/launch environment
remain unavailable. System systemd is readable, its user bus is unavailable, and
isolated unit activation is denied; no production stop/start command was guessed.

## Acceptance and immediate rollback criteria

A future controlled live trial remains **unauthorized**. Before requesting it:

1. Close every resource acceptance failure at the fixed limits, or submit a new,
   independently justified treatment for approval. Do not round 524288 up to
   524592, clamp the adaptive algorithm silently, or count stopped transfers as
   successful performance samples.
2. Validate the same observations on a full isolated Desktop candidate and the
   actual compressed/proxied path; reject missing required queue telemetry or
   unknown write shapes. Restrict the experiment to two clients/four streams,
   including unrelated background RPC work, or reject excess admission.
3. Rehearse the real supervisor in isolation with verified group enforcement
   (`MemoryHigh=1536M`, `MemoryMax=2G`, `MemorySwapMax=0`, `KillMode=control-group`,
   no automatic restart into B), then verify its properties and a safe fault stop.
   These are proposed settings, **not applied production configuration**.
4. Predeclare absolute full-application memory ceilings after measuring its baseline.
   The fixture's 256-MiB host / 1280-MiB browser values cannot simply be copied onto
   an unmeasured Desktop daemon. Keep the 2-GiB planning envelope unless a separately
   approved resource plan justifies another size.
5. Require six balanced warm actual-path pairs, >=15% median complete-body time
   improvement, correct navigation/editor readiness, and no resource stop. These
   isolated modeled gains alone do not satisfy that gate.

Immediate trial stop, followed by baseline rollback after process/listener exit:
any admission/atomic/window/credit/decoded/transport/memory limit; byte, order, EOF
or loaded-hash mismatch; unresolved cancellation; successful ACK before settlement;
unhandled rejection; dropped/missing telemetry; continuing source/queue growth
between two settled one-second stall observations; >25% worse paired p95 ACK RTT;

> 16 MiB paired sustained RSS increase for five seconds in host or renderer;
> 32 MiB paired peak RSS increase; >8 MiB paired post-GC heap retention; or continued
> post-GC growth over three full transfers. Apply absolute memory ceilings to A too.

After a known close/cancel, require production and credit settlement within two
p95 RTTs + one second, never more than five seconds. Normal drain allowance is
queued serialized bytes / predeclared minimum rate + two RTTs + consumer backlog
time + one second. A silent half-open peer may retain a fixed bounded queue until
liveness detection or explicit cancellation; no new ACK timeout was introduced.
Unknown actual-path liveness/queue observations are a NO-GO, not an assumed pass.

## Recommendation

**NO-GO.** A useful variable-feedback throughput gain survives multi-client tests,
but both variants violate unchanged transport limits during ordinary backpressure
and recovery. The optional stop safeguards correctly abort those runs; they do
not make the workloads acceptable. Moreover, kernel-enforced group containment
and the production Desktop/supervisor/path rehearsal are not established here.
Rollback of the fixture is demonstrated; production rollback readiness is not.

The proposed limits and implementation are approved only for isolated validation.
Do not deploy these scripts or restart a production daemon. A live-test decision
requires closing the listed blockers and a **new, separate explicit authorization**;
this report neither requests nor implies permission to cut over now.

## Reproduction

```bash
PLAYWRIGHT_MODULE=/tmp/astro-generator-browser/node_modules/playwright \
CHROMIUM_PATH=/tmp/codex-browsers/chromium-1254/chrome-linux64/chrome \
node scripts/diagnostics/rpc-concurrency.cjs /tmp/rpc-budgets-NEW
node scripts/diagnostics/rpc-isolated-supervisor.cjs rehearse \
  /tmp/rpc-supervisor-NEW /tmp/rpc-budgets-NEW/cores.json > /tmp/rehearsal.json
node --expose-gc --test scripts/diagnostics/rpc-resource-budget.test.cjs \
  scripts/diagnostics/rpc-resource.test.cjs scripts/diagnostics/rpc-window.test.cjs \
  scripts/asset-cache.test.cjs
```

The complete application matrix includes the two admission probes, reverse-queue
probe and maximum-atomic boundary. Packet-level tests additionally require a new
network namespace:
`RPC_CONCURRENCY_PROFILES` and `RPC_CONCURRENCY_REPEATS` select explicit test subsets;
normal application startup never imports this harness. Raw workload records and
rehearsal commands contain numeric metadata, not response payloads or credentials.

```bash
rpc_parent_netns=$(readlink /proc/self/ns/net)
rpc_parent_qdisc=$(tc -j qdisc show dev lo)
RPC_PARENT_NETNS="$rpc_parent_netns" RPC_PARENT_QDISC="$rpc_parent_qdisc" \
PLAYWRIGHT_MODULE=/tmp/astro-generator-browser/node_modules/playwright \
CHROMIUM_PATH=/tmp/codex-browsers/chromium-1254/chrome-linux64/chrome \
unshare --user --map-root-user --net \
  node scripts/diagnostics/rpc-netem.cjs /tmp/rpc-netem-NEW
```

Generate the tables and provenance from a full application run plus a full kernel
run (additional `--application` inputs replace matching cases after diagnostic reruns):

```bash
python scripts/diagnostics/rpc-budget-report.py \
  --application /tmp/rpc-budgets-NEW/results.json \
  --kernel /tmp/rpc-netem-NEW/results.json \
  --rehearsal /tmp/rehearsal.json \
  --output docs/rpc-flow-diag-20261117-01
```
