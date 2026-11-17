# RPC flight guard review

Status: isolated validation only; production artifacts/service were neither changed
nor restarted. **Not ready for a live trial under the existing acceptance rule.**
The 1-MiB stop condition remains in force until a separately approved experiment
plan replaces it. Passing correctness tests does not waive a resource stop.

## What was measured

The original 57d6056 records cannot retrospectively supply window maxima, socket
buffering, threshold duration, or drain times. They retain only flight/memory peaks
and some occupancy samples. This review reruns equivalent loopback conditions and
adds paced-path, warmed-stall, and disconnect cases. Timing-dependent peak values
need not reproduce the earlier peaks exactly. All A/B comparisons below use the
same new harness, payload, consumer schedule, and path model.

[Quantitative comparison](guard-quantitative.md) gives every scenario and variant;
[CSV](guard-metrics.csv) gives both replicates and all units;
[numeric records](guard-results.jsonl) include stall snapshots, final queues, and
memory before/after explicit GC. [Input hashes](guard-metadata.json) identify the
actual extracted, instrumented cores. These tests never execute Desktop startup.
Only the existing minimum differs between the two cores. The measured environment
was Node 22.23.2 and Chrome for Testing 158.0.8127.18.

Ten scenarios run twice as AB, then BA: **40 fresh Node/Chromium runs**, sequentially.
The three original loopback ACK/consumer delays are 0/0, 40/3, and 100/30 ms, with
matching initial consumer pauses of 300/420/600 ms and 24 × 64-KiB chunks. Other
scenarios use 64 chunks except the 24-chunk bandwidth case and an effectively
unlimited source canceled by disconnect:

| Scenario     | Forward propagation                   | Reverse/ACK delay | Serialized JSON rate | Consumer                                      |
| ------------ | ------------------------------------- | ----------------- | -------------------- | --------------------------------------------- |
| wan-stable   | 40 ms                                 | 40 ms             | 2 MiB/s              | Fast                                          |
| wan-variable | 5 ms through four writes, then 130 ms | 30 ms             | 8 MiB/s              | Fast                                          |
| bandwidth    | 40 ms                                 | 40 ms             | 256 KiB/s            | Fast                                          |
| slow         | 20 ms                                 | 40 ms             | 2 MiB/s              | 100 ms/read                                   |
| stall-resume | 20 ms                                 | 40 ms             | 2 MiB/s              | Stop after 16 chunks for 2 s, resume          |
| stall-8s     | 20 ms                                 | 40 ms             | 2 MiB/s              | Stop after 16 chunks for 8 s, resume          |
| disconnect   | 20 ms                                 | 40 ms             | 2 MiB/s              | Stop after 16 chunks for 2 s, close WebSocket |

Forward serialization is paced in an explicitly measured application queue before
a real loopback WebSocket. Propagation and ACK delay hold messages without changing
RPC write settlement, estimator return values, or credit awaits. Both directions
preserve frame order. The browser still uses the actual RPC core over WebSocket
and MessagePort. This is a controlled latency/bandwidth model, **not OS-level WAN
shaping**: no real proxy, tailnet path, kernel loss, congestion control, production
compression, or browser startup workload is represented. Rate limits apply to
uncompressed JSON bytes; 256 KiB/s JSON permits only about 0.187 MiB/s decoded.

A preliminary independent-timer shaper occasionally delivered close before the last
write (63/64 chunks). The count assertion caught it. The measurement shaper now
releases only a ready FIFO prefix; a regression test forces an out-of-order timer
completion and verifies write-before-close and exactly-once release. Preliminary
results are excluded from the committed final dataset. No RPC algorithm/order fix
was made or needed.

## Quantitative conclusions

- Peak window across the measured network scenarios was **3.705 MiB in A** and
  **3.462 MiB in B**. Peak estimated outstanding data was **2624040 bytes (2.502 MiB)
  in both**. The 8-s stalled-consumer runs spent as much as **10.164 s above 1 MiB**,
  including recovery, while the stalled source and decoded writer queue remained
  constant. Exceedance duration therefore cannot be dismissed as always brief.
- Host WebSocket API buffering peaked at **0 bytes**; browser ACK/control buffering
  at **56 bytes**. The separately measured serialized shaper queue peaked at
  **874320 bytes (853.8 KiB)**, decoded writer arguments at **393216 bytes (384 KiB)**,
  and the conservative logical decoded pipeline bound at **655360 bytes (640 KiB)**.
  These maxima occur in different phases; they are not an additive heap total.
- In `wan-variable`, median body delivery fell from **7.527 s to 4.905 s (-34.84%)**,
  and throughput rose **0.5314 to 0.8155 MiB/s (+53.46%)**. Both variants had the
  same **1049616-byte** peak estimated flight, **349728-byte** shaper maximum,
  **65536-byte** writer maximum, and **262144-byte** logical pipeline bound.
  Worst paired p95 ACK regression was **0.25%**, not the 25% stop threshold.
  Host peak RSS/heap were **142.74/50.37 MiB (A)** and **142.19/50.56 MiB (B)**;
  renderer peak RSS/heap were **347.66/3.06 MiB** and **346.96/3.06 MiB**.
  This is a useful modeled feedback-limited gain without material additional
  observed queueing or memory, based on two pairs—not a production estimate.
- Stable latency, bandwidth-limited and slow-consumer cases showed approximately
  **0% benefit** (changes within 0.1%). Loopback differences are scheduling noise;
  no general throughput improvement follows from increasing the floor.
- During every warmed stall, production stopped at **22 generated / 16 consumed**
  chunks with **six pending writes (384 KiB)**. The 8-s observations show host heap
  rising and falling with GC rather than accumulating decoded data; renderer heap
  stayed about **1.26–1.28 MiB**. After explicit settling GC, host/renderer heaps
  were at most **37.18/1.09 MiB** in those runs. This does not prove long-term
  absence of leaks, but it rules out continuously accumulating payload in the
  observed stall intervals.
- Previously queued data cleared within **12.6 ms after resumption**. Normal
  last-source-write to final-ACK tail drain was at most **667.0 ms** in the slow
  bandwidth case. After detected disconnect, source cancellation took at most
  **1.54 ms**, host flight/credit cleared in **0.91 ms**, and the browser read
  rejected within **2.70 ms**. Every final queue and estimated-flight count is zero.

## Units, boundaries, and causality

A typical write is 65536 decoded bytes, 262404 estimator bytes, and about 87432
UTF-8 JSON bytes in this harness. Thus **four writes are 1049616 estimated bytes**:
just 1040 bytes above 1 MiB, while representing 256 KiB decoded and about 342 KiB
JSON. Estimator flight includes remote writes already settled whose ACK is still
in transit. It is neither physical queue occupancy nor resident memory.

The controller tests after adding an atomic write. At a send:

`pre-send flight < send-time window`, and
`post-send flight < send-time window + atomic write size`.

Every measured send checks these inequalities. ACK-driven decreases can leave
existing flight above the _new_ window without permitting new sends. A later ACK
must release credit before production resumes. Consequently a window below 1 MiB
can produce an estimated-flight crossing. At other times the adaptive window itself
is well above 1 MiB; the treatment is a minimum, not a cap.

The growth is existing startup/rate/RTT adaptation in **both** variants. Fixed-rate
feedback and ACK bursts may grow the window beyond the floor. The controller has
no wall-clock decay without ACKs. A warmed, stopped consumer can therefore retain
a fixed above-threshold flight for the whole pause. Such a crossing is not always
transient: elapsed time above 1 MiB alone cannot distinguish a fixed retained queue
from accumulating data. During resumption, queued settlements and delayed ACKs can
also produce a burst and a higher subsequent window.

The scalar controller stress test reaches the unchanged 1073741824-byte maximum
in both A and B, with peak flight 1073757168 (< maximum + one 262404-byte write).
It allocates tokens, **not gigabytes of payload**. This demonstrates why the upper
bound cannot be treated as an acceptable memory budget. With bounded atomic writes
and one correctly awaited producer, per-window flight is mathematically finite;
there is no bound independent of write size or number of concurrent windows.
A host-wide floor experiment still requires aggregate observation across streams.

## Queue and memory findings

The tables distinguish real `WebSocket.bufferedAmount` from the shaper's retained
JSON, pending MessagePort/receive messages, decoded `writer.write` arguments, and
a conservative logical produced-minus-consumed decoded bound. Component maxima
need not occur together. They must not be added as an exact physical heap total:
representations/copies may coexist, and the logical bound counts data still encoded
in transport plus delayed observer notification. The Node source is generated on
demand with highWaterMark zero; no full fixture is preloaded.

WebSocket buffering was measured immediately after each send and while sampling.
The host's API buffer remains empty in this paced loopback model; browser values
are small control/ACK messages. **This excludes kernel TCP send buffers, proxy
queues, and compression buffers.** It is not evidence that actual WAN buffering
would be zero. The shaper queue is deliberately reported separately so pacing
cannot hide retained messages behind a zero WebSocket buffer measurement.

All completed transfers verify every byte, order, chunk count and EOF. Warm stalls
stop source production; the last two snapshots have equal produced counts and
queued writer bytes. They do not ACK unconsumed writes. Resumption drains the old
FIFO backlog; after normal EOF, shaper/receive/writer queues, estimated flight and
credit waiters all reach zero. Disconnect rejects pending receive/credit promises,
cancels the source, clears pacing jobs, and leaves no successful EOF claim. These
are detected connection closures, not an undetectable half-open TCP blackhole.
Without a close/error or explicit cancellation, a silent peer can retain a bounded
queue indefinitely under the unchanged protocol; liveness detection is separate
from credit capacity and was not modified. See
the final table for measured resume/drain/cancel latencies.

Process peaks are 20-ms samples: Node RSS, JS heap and external bytes; summed
Chromium renderer RSS from its process IDs and renderer JS heap through CDP.
Compilation happens before the memory baseline, but JIT, serializers and tracing
still allocate during the transfer. The instrumentation itself allocates; heap
can rise between GCs with a flat payload queue. Post-GC values and long-stall
snapshots distinguish that pattern from retained payload growth. RSS need not
return to its starting value because allocators/code pages remain resident.
These are seconds-long tests, not a leak proof or a long-lived concurrent-session
soak. The existing mixed-size/two-adapter tests also pass; their synthetic estimator
weights are not real WebSocket buffering measurements and must not be converted
into wire bytes.

No accumulating payload queue was observed under stalled consumption. This supports
bounded backpressure in these conditions, not a global resource-safety guarantee.
The very high per-window maximum, arbitrary writes/concurrency, and unmeasured
actual path remain potential resource hazards independent of raising the minimum.

## Guard decision and explicit acceptance/stop criteria

**Keep the original 1-MiB hard stop for the currently proposed live experiment.**
Both configurations fail it. It was a conservative capacity-experiment budget,
not a claimed controller invariant. Neither a benign-looking crossing nor a
throughput gain authorizes increasing it.

For a future plan, separately budget flight, buffering and process memory. A higher
estimator number selected from the largest passing run would not be justified.
The following is a **new plan proposal for review**, not an enabled policy or a
change to the data path:

| Dimension               | Proposed rule and rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Estimated flight        | Keep 1 MiB as an investigation alert. For the known 64-KiB fixture only, a proposed 512-KiB decoded retention budget corresponds to at most eight typical writes, or **2099232 estimator bytes**. Stop above this independently derived budget; stop on a send violating the atomic overshoot inequality. Unknown write shapes/streams retain the original conservative stop pending calibration. This is not a global estimator-to-heap conversion.                                             |
| Adaptive window         | Stop if the send-time window cannot leave room for the largest predeclared atomic write within the flight budget (`window + largestWrite <= flightBudget`). For 262404-byte writes that is at most 1836828. A sustained large target must not bypass the flight guard merely because few bytes remain at EOF.                                                                                                                                                                                    |
| Decoded retention       | Stop above **512 KiB per selected stream** or **1 MiB aggregate** for the trial connection. These are four/eight times the intended two-write 128-KiB flight, deliberate small-trial allowances—not a proof of affordable heap. Count currently retained decoded writer data and conservative pipeline occupancy separately. The current stalled/resumed runs exceed the per-stream allowance in some phases and would still stop.                                                               |
| Actual transport queues | Stop above **512 KiB combined host WebSocket + measured serialized pacing/proxy queue per connection**, or **1 MiB aggregate** across trial connections. Kernel/proxy queues need actual-path telemetry; missing required telemetry invalidates a safety claim. Never infer this from estimator flight or a zero socket API buffer. Some current paced cases exceed the per-connection allowance and would stop.                                                                                 |
| Memory                  | Retain **>16 MiB sustained (5 s) host OR renderer RSS increase over matched warmed A** as a stop; also stop on **>32 MiB paired peak RSS increase**, **>8 MiB paired post-GC heap retention**, or continued post-GC growth over three transfers. Set independent absolute RSS/heap/external-memory ceilings from the deployment machine's available headroom before any trial; these cannot be inferred or approved from this container's test peaks. Check A against the absolute ceilings too. |
| Stalls and disconnects  | After two p95 ACK RTTs of settling, any continued producer/retained-queue growth across two 1-s observations stops the run. Bound normal drain by queued serialized bytes / approved minimum rate + two RTTs + consumer backlog time + 1 s. Cancel/disconnect must stop production and settle credit within two RTTs + 1 s, with a hard 5-s ceiling; clear retained queues after teardown. A stalled consumer may retain a fixed queue, but cannot exceed the other budgets.                     |
| Correctness and latency | Any byte/order/EOF mismatch, unresolved cancel, early successful ACK, unhandled rejection, missing/drop telemetry or wrong loaded hash stops the run. Stop B on >25% worse paired p95 ACK RTT. Keep normal chunking, compression, ACK semantics, source awaits and cache unchanged.                                                                                                                                                                                                              |
| Benefit                 | At least six warm paired trials in balanced AB/BA order; require >=15% median first-decoded-read to final-browser-body improvement with no resource/latency stop. Compare equal bodies or report normalized throughput. Navigation/mount readiness is separately required; modeled throughput is not a startup-time prediction.                                                                                                                                                                  |

The explicit numeric queue budgets above intentionally **do not pass every current
scenario**. They are design limits for a small experiment, not fitted quantiles.
They require owner approval and a correctly instrumented actual-path baseline;
no production monitoring/restart configuration was installed here. If the unchanged
algorithm trips the selected budgets, abort/reject that trial instead of adding a
cap, rate filter, timeout, or consumer ACK change to this minimum-only treatment.

## Rollback evidence and readiness

The offline A-B-A test proves baseline builder output is byte-identical to the
source both before and after B generation, and a fresh runtime restores initial
262144, minimum 65536 and empty flight. B has minimum 524288 with the same initial
and maximum. The full-resource AB/BA pairs explicitly return from a B process to a
fresh A process under the same workload. All final queues/credit are zero after
successful transfer or failed transport teardown. Existing builder checks verify
source preservation and sidecar regeneration. Nothing requires an in-place patch,
a persistent tuning flag, state migration, or commit revert for rollback.

Use the immutable baseline tree and the stop/wait/launch blocks in
[experiment.md](experiment.md#rollback). Verify process exit/listener release and
loaded hashes; never rewrite a running artifact. Canceling an active transfer may
require the browser to retry it after restart; zero already delivered network
bytes is not a rollback promise.

Production supervisor commands, complete launch environment, absolute memory
headroom, actual-path queue telemetry, and production readiness/rollback rehearsal
are still unavailable/unverified. Thus artifact/runtime rollback is demonstrated;
**operational production rollback has not been rehearsed**. This distinction is a
readiness gate, not a reason to run a speculative stop command.

Recommendation: **hold production/live A/B for now**. B has a credible benefit in
the variable-feedback model, without a comparable benefit in the bandwidth- or
consumer-limited models. That supports a later controlled experiment, not a guard
waiver. First approve an independent resource-budget plan, validate its monitoring
and actual-path baseline, and record/rehearse the real supervisor rollback. Only
then request separate live-test deployment authorization. This review authorizes
no cutover and changes no default window or production ACK/backpressure behavior.

## Validation completed

All **40 isolated Chromium resource cases passed**, with no skipped cases. The
three new guard/FIFO/rollback tests, three existing window/builder/resource tests,
and two asset-cache tests also passed (8 total). The existing RPC regression suite
was rerun with real Chromium in A and B at identical 40-ms ACK / 3-ms consumer
settings: **12 tests passed, no skips**. Byte integrity, ordering, EOF, early/mid/late
cancel, credit rejection, and source backpressure remain covered. Formatting and
Git diff checks passed. The original host SHA-256 remains
`73f93b81152bff48cd27bcebcf27c430fb763e5c7418c67824950f4092ba933d`.

## Reproduction

```bash
node --expose-gc --test scripts/diagnostics/rpc-resource.test.cjs \
  scripts/diagnostics/rpc-window.test.cjs scripts/asset-cache.test.cjs
PLAYWRIGHT_MODULE=/tmp/astro-generator-browser/node_modules/playwright \
CHROMIUM_PATH=/tmp/codex-browsers/chromium-1254/chrome-linux64/chrome \
node scripts/diagnostics/rpc-resource.cjs /tmp/rpc-resource-NEW
python scripts/diagnostics/rpc-resource-report.py /tmp/rpc-resource-NEW/results.json \
  docs/rpc-flow-diag-20261117-01
```

`RPC_RESOURCE_SCENARIOS` optionally selects comma-separated scenarios;
`RPC_RESOURCE_REPEATS` defaults to two. The complete review uses all ten scenarios
and both balanced replicates. Test workers bind only ephemeral loopback listeners,
use fresh browser profiles, and never contact the production endpoint.
