# Controlled RPC window startup comparison

Status: prepared, **not measured**. No host readiness confirmation has been
received for this comparison. Prior captures are reference evidence, not A runs.
Do not contact the live application with the harness before fresh host readiness.
See the [verified CFFV5 environment](rpc-window-ab-client.md) for exact local paths,
offline checks, and the remaining network-path uncertainty.

Use `scripts/diagnostics/capture-startup.cjs` in its opt-in A/B mode. This adds
host-confirmation validation before Chromium launches, a shared-profile lock,
stable capture controls, an unmeasured warmup, and at least three measured warm
reloads. Ordinary two-load capture behavior remains the default.

## Host readiness and isolation

The z170-1 operator prepares B. This client must not patch or restart the host.
Preserve the deployed A directory, binaries, launcher environment and rollback
procedure. Use the same diagnostics, compression, chunk limits, proxy, timeout,
account, browser, client machine and network path for A and B. Record Tailscale
direct/relay status before and after each batch. Do not run speed tests, concurrent
tabs, captures, bulk requests or cancellation probes during timed runs.

Use A-before (three reloads), B (three), A-after (three) where the host can safely
perform the two cutovers. Stop Chromium and finish/save logs between batches.
A fresh readiness relay is required for each batch, including A-after; never reuse
a previous relay. The host must keep that configuration active through the batch and
confirm afterward that it did not change. Capture matching host stdout, stderr,
and resource samples from before warmup until the client has closed. An unexpected
restart, competing traffic or path change invalidates the batch. Local profile
locking cannot prevent traffic from another client; host coordination is required.

Save the operator's actual relay as a private JSON file. Required shape below;
placeholders are deliberately invalid and must not be treated as confirmation:

```json
{
  "captureId": "rpc-window-A-01",
  "configuration": "A",
  "confirmation": "REPLACE_WITH_VERBATIM_HOST_CONFIRMATION",
  "confirmedUTC": "REPLACE_WITH_HOST_CONFIRMATION_UTC",
  "source": "REPLACE_WITH_ACTUAL_HOST_RELAY_PROVENANCE",
  "url": "https://z170-1.tailddb1d3.ts.net:8214/",
  "window": {
    "initialBytes": 262144,
    "minimumBytes": 65536,
    "maximumBytes": 1073741824,
    "clampBehavior": "REPLACE_WITH_VERIFIED_ACTIVE_ALGORITHM"
  },
  "revision": "REPLACE_WITH_ACTIVE_REVISION_AND_PATCH_ID",
  "hostBundleSha256": "REPLACE_WITH_LOADED_BUNDLE_SHA256",
  "browserBundleSha256": "REPLACE_WITH_LOADED_BUNDLE_SHA256",
  "processIdentity": "REPLACE_WITH_PID_START_TIME_AND_LAUNCHER_IDENTITY",
  "bootstrapDiagnostics": true,
  "rpcDiagnostics": true,
  "exclusiveTraffic": true,
  "hostLog": "REPLACE_WITH_HOST_STDOUT_AND_STDERR_LOCATIONS",
  "resourceCapture": "REPLACE_WITH_SAMPLER_LOCATION_OR_UNAVAILABLE_AND_REASON",
  "baselineLocation": "REPLACE_WITH_PRESERVED_A_DEPLOYMENT_LOCATION",
  "deploymentAcceptanceSatisfied": false,
  "activeConfigurationVerified": false,
  "rollbackReady": false,
  "acceptanceEvidence": "REPLACE_WITH_HOST_ACCEPTANCE_RESULTS_AND_GUARD_REVIEW",
  "supervisor": {
    "identity": "REPLACE_WITH_ACTUAL_SUPERVISOR",
    "stopCommand": "REPLACE_WITH_ACTUAL_STOP_COMMAND",
    "startCommand": "REPLACE_WITH_ACTUAL_START_COMMAND",
    "rollbackCommand": "REPLACE_WITH_ACTUAL_ROLLBACK_COMMAND"
  },
  "safety": {
    "approvalReference": "REPLACE_WITH_Z170_1_APPROVAL",
    "adaptiveFlightLimitBytes": null,
    "flightGuardMode": "REPLACE_WITH_APPROVED_OBSERVER_OR_DATA_PATH_BEHAVIOR",
    "flightScope": "REPLACE_WITH_APPROVED_PER_STREAM_OR_AGGREGATE_SCOPE",
    "breachAction": "REPLACE_WITH_HOST_MONITOR_ABORT_AND_ROLLBACK_PROCEDURE",
    "rssIncreaseBytes": null,
    "ackP95RegressionPercent": null,
    "minimumBodyImprovementPercent": null,
    "queueRule": "REPLACE_WITH_APPROVED_BUFFER_AND_QUEUE_THRESHOLDS"
  }
}
```

Only z170-1 can supply the confirmation matching
`HOST READY — <captureId> — <configuration>` and set the three acceptance booleans
true. CFFV5 must not create a ready signal or substitute assumed supervisor
commands. The gate rejects missing acceptance, rollback readiness, commands or
approved thresholds. Confirmation must be under 30 minutes old at launch and
before every measured reload. Each batch needs host monitoring throughout it;
the client stores safety rules but does **not** implement a host flight guard.

The proposed 1-MiB adaptive-flight guard is still under host review. Earlier
isolated tests exceeded 1 MiB in both variants. Do not assume acceptance, silently
raise the threshold, or interpret it as a 1-MiB adaptive window maximum. Record
whether the approved guard aborts the observation externally or changes the data
path. A data-path cap would change the treatment and must be explicitly described
and approved, with the original A preserved. The host must confirm monitor scope,
sampling, atomic overshoot handling and abort/rollback behavior before readiness.

A's original constants are initial 262144, minimum 65536, maximum 1073741824
estimated bytes; verify these against the loaded host. B must report minimum
524288 and its **actual** initial, maximum and clamp behavior. Do not assume the
initial window becomes 524288 just because the minimum changed. Record which RPC
realms/directions changed and verify artifact hashes, including compressed browser
assets. Retain the relay in every run manifest; cross-check observed window events
with the operator's settings. The manifest is an attestation, not remote detection.

## Client capture

The previous RPC capture used `/tmp/bootstrap-diag-20261117-01/profile`, Chromium
156.0.8078.4. Confirm that profile and client are intended before reuse. Do not
clear caches, copy to a new profile for B, or change browser versions. Ensure
Chromium is closed before starting. Both arms use the **same absolute profile**.

After host readiness, run each batch sequentially with its own fresh output
directory. Keep every export identical except readiness file and output directory:

```sh
export PLAYWRIGHT_MODULE=/tmp/codex-startup-tools/node_modules/playwright
export CHROMIUM_PATH=/tmp/codex-review-browsers/chromium-1248/chrome-linux64/chrome
export LD_LIBRARY_PATH=/tmp/codex-startup-libs/extracted/usr/lib/x86_64-linux-gnu
export PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH
export CAPTURE_PROFILE=/tmp/bootstrap-diag-20261117-01/profile
export CAPTURE_CLIENT_PATH='REPLACE: client identity, interface, Tailscale direct/relay and path'
export CAPTURE_SECONDS=360
export CAPTURE_RUNS=3
unset READY_SELECTOR

RPC_AB_HOST_READY=/tmp/rpc-window-A-ready.json \
node scripts/diagnostics/capture-startup.cjs \
  https://z170-1.tailddb1d3.ts.net:8214/ /tmp/rpc-window-A-01

# Only after A has finished and the host has confirmed B's active deployment:
RPC_AB_HOST_READY=/tmp/rpc-window-B-ready.json \
node scripts/diagnostics/capture-startup.cjs \
  https://z170-1.tailddb1d3.ts.net:8214/ /tmp/rpc-window-B-01

# Only after B finishes and z170-1 verifies/restores the original A:
RPC_AB_HOST_READY=/tmp/rpc-window-A-after-ready.json \
node scripts/diagnostics/capture-startup.cjs \
  https://z170-1.tailddb1d3.ts.net:8214/ /tmp/rpc-window-A-after-01
```

Each batch performs one unmeasured navigation, waits for a visible composer and
15 seconds of settling, then captures three reloads with identical tracing and
normal HTTP cache settings. No stop selector is used for measured runs, so the
observation interval is fixed. Each run retains CDP, trace, screenshot, page state,
UTC interval, host relay and browser version. The shared controls file fingerprints
the Chromium executable and rejects changed client settings. Do not delete that
file between arms. Confirm path stability outside the capture as well.

A missing browser RPC event, route milestone or tagged close stops the batch and
preserves the incomplete run. These are preliminary coverage checks only: they do
not prove matching streams, byte integrity or error-free completion. Do not count
incomplete or invalid captures toward the three. Retain their failure reasons,
then coordinate a fresh batch after resolving the cause. A profile lock left by
a crashed process requires checking that process and Chromium have exited before
manual removal. Full captures include private application data; do not commit them.

## Correlation and report

Use the existing [bootstrap](bootstrap-delivery-diagnostics.md) and
[RPC](rpc-flow-diagnostics.md) event definitions. Import matching host logs before
analysis. Join connection, request, RPC session/operation, stream and window IDs;
scope all IDs to their process/page. Match cumulative byte ranges across boundaries.
Keep unrelated RPC streams out of bootstrap figures, and report socket-wide queue
measurements as socket-wide. Never join only by similar timestamps.

For each valid run report:

| Measurement | Definition and required evidence |
| --- | --- |
| Body delivery (primary) | Browser first tagged body-write receipt to matching close receipt; also last body-write receipt minus first, and headers-to-close. Report decoded total bytes and body/chunk size differences. |
| Host body span | First decoded read to upstream EOF, separately from browser delivery. |
| Credit waits | Paired starts/ends for the bootstrap window: count, summed duration, union duration, median/p95/max wait and unresolved/rejected count. Report overlap with read gaps rather than adding overlapping spans. |
| Window/outstanding | Initial/minimum/maximum settings plus observed min/median/p95/max window and estimated bytes in flight. Include peak, time-weighted outstanding bytes and time at minimum; event-only medians are sampling-biased. Estimated RPC bytes are not decoded or wire bytes. |
| ACK/writer | Host ACK RTT median/p95/max, browser writer completion count and total/median/p95/max duration; match writer-end to ack-send and host ACK to credit release. |
| Buffering/queues | Host WebSocket bufferedAmount peak and available samples; queue-progress pendingWrites peak and duration. Report sampling interval and coverage; no samples means unobserved, not zero. Neither counter observes every internal queue. |
| Full route mounting | Browser navigation start to routes-mounted (`browserMs` on that page), with evaluations-published separately. Preserve its latest-observed-bootstrap correlation limitation; exclude overlapping bootstraps or unexplained navigations. A visible selector alone is insufficient. |
| Integrity/errors | Upstream EOF, ordered browser writes, matching final totals and close, no duplicate/missing sequences, diagnostics dropped count, loading/WS errors, exceptions, rejected writes and unexpected cancel/error/abort. Compare errors with A individually. |
| Host resources | Same sampler/interval/process scope: idle RSS, startup peak RSS, post-run RSS, CPU-seconds per startup and sampled CPU peak/median. Include child processes where available. Record unavailable metrics and why; event-loop delay is not CPU or RSS. |

Use nearby clock probes to bound host-minus-browser clock offset by
`[H0 - B, H1 - B]`. Do not subtract host/browser monotonic values directly. Compare
enqueue-to-receipt bounds to determine whether credit gains moved into the socket
queue or browser scheduling. Report uncertainty and scheduling/read-gap evidence.

Publish a per-run table with A-before-1–3/B-1–3/A-after-1–3, configuration and bundle identity, body
duration, credit count/union time, peak outstanding, RTT, writer time, socket/queue
peaks, route time, RSS/CPU and integrity result. For each arm report median,
min–max and median absolute deviation across runs, plus B-minus-A median and
percentage change. With three runs, do not claim statistical significance.
Retain individual values and excluded runs; missing data stays unavailable.
Report A-before and A-after separately first. Compare their medians/ranges and
path status to check drift; do not pool A until their comparability is established.
Compare B with both flanking baselines. If A-after is impractical, document the
host's reason and the missing drift control rather than implying an A-B-A result.

Before capture, use the thresholds approved by z170-1 and record them verbatim in
`safety`. Previous proposed criteria included >1 MiB estimated flight as an abort,
>16 MiB sustained RSS growth, >25% p95 ACK regression and at least 15% median body
improvement. These remain proposals until z170-1 confirms acceptance and resolves
the guard concern. They supersede neither host review nor the final approved
thresholds. Report continuous values too; thresholds are not instrument precision.
Any unexplained sustained queue growth is also material. Reject B if material
memory/buffering growth occurs without body improvement. Reduced credit wait alone
does not establish improvement; inspect full body and route times and other queues.
Overlapping ranges, missing resource coverage or changed payloads weaken the result
and may require more serial runs rather than acceptance.

Run the existing isolated byte/order/EOF, slow-consumer and cancellation/credit
rejection checks against **both actual candidates** on the host, outside timed
captures (`rpc-flow.test.cjs` and relevant bootstrap validators). Confirm they
exercise the patched loaded core, not an unchanged fixture. If live cancellation
validation is needed, coordinate a separate untimed capture after both batches;
verify abort propagation, credit rejection, cleanup and subsequent normal reload.
No cancellations in successful reloads is not cancellation coverage. Reject any
correctness/cancellation regression; leave acceptance pending when coverage is
missing. Restore A through the host procedure after testing unless the user has
authorized retaining B, and record the final active settings.

Report the tested client/path explicitly. Do not infer performance on the user's
original affected WAN path unless these runs actually use that path.
