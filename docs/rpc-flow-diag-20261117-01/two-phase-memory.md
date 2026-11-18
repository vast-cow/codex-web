# Two-phase memory acceptance for RPC staging

**NO-GO to authorize authenticated staging.** Both A and B fail the defined settled-memory rules; repeated operation raises the idle floor above 1,280 MiB, and a final A attempt fails the settling deadline. The 1,536-MiB absolute experimental cap and hard containment hold in the measured offline cases.

This continues `c3fd85a`, `6488943`, and `57a69f0`. Authorization covers isolated, signed-out validation only. Production code, running daemon, launcher configuration, transport reservations, network identity, and authentication state are unchanged. No authenticated staging, tailnet enrollment, or live A/B is authorized or launched.

The policy below is an acceptance contract, not a production configuration change. A completed characterization is not an acceptance pass. The existing [staging procedure](memory-and-staging.md) remains behind separate authorization; its manually written `memory.phase` file and 30-second checkpoint do **not** implement this contract.

## Policy and state transitions

MiB means 1,048,576 bytes. Apply the charged-memory boundary to the **entire declared cgroup**, including Desktop, launcher/parent, app-server/proxy, local browser/helpers, and staging edge when present. Do not subtract reclaimable cache, shared pages, instrumentation, or another component to manufacture a pass. A remote client needs an explicitly separate resource record.

| State | Entry and exit | Memory behavior |
| --- | --- | --- |
| Startup / recovery | Enter at contained-stack launch, before a planned release launch/navigation, or **before** a declared recovery fault. Record cause, timestamp, expected release and PID/start-time identities. Reach all readiness conditions below, then maintain those conditions, drained initialization work, and `memory.current <= 1,280 MiB` for ten continuous seconds. Any loss resets this qualification interval. Exit to settled only when all conditions hold. Entire startup/recovery episode must finish within 90 seconds. | Warn on every observed sample above 1,280 MiB; record the complete excursion. Stop above 1,536 MiB. The cumulative kernel peak must also be <= 1,536 MiB. |
| Settled | Enter through the readiness qualification above. Ordinary requests, concurrent streams, GC, and increasing memory **never** reclassify this state as startup. A planned lifecycle transition must be recorded before its trigger. Unexpected readiness loss fails. | Warn immediately above 1,280 MiB. Stop if continuously above for >= 5 seconds, or if time above totals > 10 seconds in any rolling 60 seconds. Stop immediately above 1,536 MiB. |
| Stopping / failed | Enter on a failed gate or planned stop. Preserve metadata, stop the isolated unit, reap all members and require the listener to disappear within eight seconds. | The absolute ceiling, hard containment, and observer requirements continue through teardown. An acceptance failure remains failed even after successful rollback. |

Five seconds is a conservative proposed **stop** rule, not an empirically established safe retention time. Its suitability and the results against it are evaluated below. The rolling rule prevents indefinitely repeated short excursions. Both rules use elapsed monotonic time, never sample counts. Startup time cannot be extended by phase-file rewrites, readiness flapping, a long response, or a memory alarm. The combined 90-second deadline also requires readiness early enough to complete the ten-second qualification; it is stricter than allowing an editor to become ready at second 90.

Authenticated readiness requires all of the following, correlated to the current release/navigation and **each** intended browser client:

1. Correct executable, release/preload hashes, socket mapping, process membership and expected TLS/WebSocket protocol; successful directory IPC and account initialization with the approved disposable account.
2. A complete successful real Statsig request: upstream and browser EOF, ordered exactly-once byte totals, valid outer/nested JSON, and Ready evaluations. No fallback or cancelled bootstrap qualifies. Historical fixture length is not an authenticated payload-size requirement.
3. Explicit primary runtime and routes-mounted milestones, plus an enabled, focused editor that accepts and clears an **unsent** test string. Repeat after reconnect and restored A.
4. Initialization streams completed, upstream producers gone, transport tickets/credit drained, and sender, assembly, native and decoded queues meeting their existing quiescence rules. Every observer is live; no integrity, progress, cancellation or reconnect failure is pending.

HTTP 200, a listening port, `electronBridge`, fixture EOF, a visible textarea, a log saying Ready, or elapsed time alone is insufficient. Offline validation substitutes a confirmed signed-out account and a visible enabled sign-in control for authenticated account/SDK/runtime/editor checks. It tests the memory mechanism, **not** authenticated readiness.

## Independent stop conditions and observations

Keep `memory.max=2147483648` (2 GiB), `memory.swap.max=0`, `OOMPolicy=stop`, `KillMode=control-group`, and the eight-second systemd cleanup deadline. Any `max`, `oom`, `oom_kill`, or `oom_group_kill` event fails, even if the application recovers. Verify effective containment and process membership; an escaped process, missing observer/file, malformed sample, or observer gap over one second fails. A sampled or kernel-recorded peak above 1,536 MiB fails in every state. Do not wait for OOM.

Keep the existing transport contract: 448 KiB forward plus 64 KiB reverse issued data per connection, at most two admitted connections (896 KiB forward / 1 MiB combined); separate 8 KiB priority per direction/connection and 256 B receipt headroom. Preserve the 1,771,040 B adaptive window, 328,192 B atomic allowance, and 2,099,232 B stop bound per stream. Preserve 16 MiB / 128-entry staging, 16 MiB assembly, existing parked-writer/source-buffer and 256/512 KiB host/browser port limits. All remaining [resource, queue, cancellation, and reconnect gates](deployment-readiness.md#acceptance-and-rollback-criteria) continue to apply independently. A memory grace interval never grants queue grace.

In particular, fail on transport overflow/corruption, unexplained reservations after drain, five seconds of continuing queue growth, 15 seconds without envelope progress, or a non-idle queue three seconds after terminal completion. Preserve native WS limits (512 KiB host / 96 KiB browser per socket) and the existing TCP TX investigation/drain rule. A healthy peer and a successful operation after a planned fault are mandatory; unexpected disconnects or fallback initialization fail immediately.

Also stop for continuous growth below 1,280 MiB: three consecutive 60-second settled medians increasing by more than 16 MiB each and more than 64 MiB from first to third. Track anonymous charge, process PSS, and Node heap/external/ArrayBuffer trends alongside total charge, since falling file cache could mask growth elsewhere. This is a conservative screening rule, not proof of leak freedom. Preserve the existing B-versus-paired-A 128-MiB settled regression gate and review A/A drift; stable idle alone cannot excuse residual growth between lifecycles. These growth values are proposed screens, not statistically derived leak tolerances.

At 100-ms sampling, narrow excursions can be missed and each crossing has approximately one sample of timing uncertainty. Record actual gaps and duration bounds. `memory.peak` supplies the unsampled whole-unit high-water mark; its cumulative value cannot date a sub-sample settled excursion or enforce an instantaneous 1,280-MiB settled bound. RSS/PSS and Node components diagnose the charge; they do not replace it. RSS double-counts shared mappings, worker RSS is process-wide, and Node ArrayBuffers are included in external memory.

For a separately authorized staging rehearsal, a breach first stops the entire staging unit. Restore A only while stopped, then have the operator relaunch it through the qualified staging parent with a fresh guard/collector, verify exact A and all readiness gates, and leave staging stopped if A fails. There is no automatic retry of B. Production rollback and production changes still require their own authorization.

## Isolated evidence

The new workload uses the immutable installed legacy A and bounded/512-KiB B releases, unchanged launcher/proxy and pinned Node/CLI/Chromium. Each wave contains two simultaneous responses on the actual webview's existing WebSocket and two on a second Node RPC client. A four-request upstream barrier proves concurrent sources; no third WebSocket is added. Each response replays 135 writes totaling 7,956,397 decoded bytes and must pass EOF, byte count, SHA-256 and nested JSON checks. One initial wave, three post-settle waves, 180 seconds of idle with the real webview open, and a final healthy wave distinguish startup, active settled work and idle. The second RPC peer closes between waves; the idle interval retains one real browser connection, not two browser renderers.

Every run uses fresh isolated state, private mount/PID/network/IPC namespaces, loopback-only TLS and the same hard cgroup/swap containment. Releases/dependencies are read-only; production home, launcher directories and authentication state are hidden. There is no forced GC, heap-size tuning, cache eviction, new reservation budget or production intervention. A and B share warmed fixture/cache/controller state within a run, and A is restored between B treatments; do not interpret order effects as a causal B regression.

The first enforced experiment stopped A at the five-second settled violation. Characterization then records lower-gate violations while retaining the 1,536-MiB absolute stop, 90-second startup bound, hard containment, observer-gap and correctness checks. This explicit diagnostic mode can measure an excursion to its end; it cannot pass a policy whose stop condition it crossed. The checked-in evidence identifies source roots and instrumentation hashes so experiments with different instrumentation are not pooled as identical runs.

The final checker also starts during setup, rechecks offline readiness during qualification, and evaluates growth even while recording a characterization excursion. The extended run used an earlier copied checker; the fresh recovery run uses the tightened version. Replaying the final engine against the original numeric trajectories retains all lower-gate failures and final-A deadline failure, with no three-minute growth-screen trip. This replay retains the original offline readiness observations and does not retrospectively prove authenticated or continuous UI readiness. An in-process isolated sampler detects a gap when it resumes; the required independent staging heartbeat/stop supervisor still needs qualification.

Producer drain, complete bodies and successful post-idle requests detect observed stalled work in this workload; independent transport/resource tests cover reservation bounds, stalled peers, progress deadlines and teardown. The full-stack launcher still lacks a qualified **active** host/browser queue exporter, so these runs do not certify every internal queue at every instant. That observability gap stays a staging blocker. The new memory checker does not intercept, raise, or disable transport budgets/deadlines, and its independent-failure input has immediate-stop regression coverage. An actual staging collector must connect those failures to the whole-unit stop rather than rely on that input being unused.

The [numeric evidence](two-phase-memory-evidence.json) preserves every detected excursion, its peak/excess integral, timing bounds and censoring, plus cgroup/process/Node attribution. The primary repeated run is `rpc-shared.memory-RB20r8`, A → B → A → B → A. MiB values below are sampled per-arm charged peaks; the unsampled **whole-run kernel peak was 1,465.2 MiB**. There were zero `max`, `oom`, `oom_kill` and `oom_group_kill` events. The largest observed sample gap was 418 ms, median 100 ms.

| Arm | Ready / settled after launch, s | Startup peak MiB | Settled peak MiB | Settled excursions: count / longest s / total s | Busiest rolling minute above 1,280 MiB, s |
| --- | ---: | ---: | ---: | --- | ---: |
| A before | 10.8 / 34.3 | 1,378.3 | 1,329.2 | 9 / 7.59 / 10.02 | 8.98 |
| B first | 10.7 / 42.0 | 1,420.0 | 1,361.7 | 7 / 20.76 / 33.48 | 30.67 |
| A restored | 10.7 / 42.0 | 1,457.7 | 1,368.8 | 4 / 10.08 / 32.27 | 30.11 |
| B repeated | 10.7 / 41.9 | 1,454.6 | 1,390.0 | 18 / 85.76 / 139.76 | 60.00 |
| A final attempt | 10.7 / **never** | 1,443.4 | — | No settled interval; stopped at 90.05 s | — |

Settled observation lengths were 219.4 / 221.2 / 219.8 / 221.8 seconds, giving **2.46 / 1.90 / 1.09 / 4.87 excursions per minute**, respectively. The first A's longest settled episode has a measured duration interval of **7.491–7.691 s** and first B's **20.662–20.864 s**. The second B's longest has **85.709–85.858 s** bounds. Peaks above the settled line reached **49.2–110.0 MiB** of excess. A final's last above-line episode was still active at stop: **at least 82.293 s**, with no observable upper duration bound. Do not treat that censored result as an 82-second completed transient.

Readiness alone was too early. Before qualification into settled, the first four arms still spent **13.27 / 20.68 / 21.22 / 21.20 s above 1,280 MiB after their ready milestone**. Final A spent its entire remaining **79.37 s after readiness** above the line. Ten seconds continuously below the line avoids classifying the initial startup tail as settled; it does not excuse later excursions. All four complete arms fail the five-second rule; B first, A restored and B repeated also fail the rolling rule.

| Arm | Three consecutive idle one-minute medians, MiB | 30 s after Desktop stop, MiB |
| --- | --- | ---: |
| A before | 1,217.0 → 1,214.1 → 1,221.8 | 629.6 |
| B first | 1,249.0 → 1,254.1 → 1,262.3 | 654.1 |
| A restored | 1,264.1 → 1,267.1 → 1,275.2 | 671.5 |
| B repeated | 1,274.8 → 1,280.5 → 1,283.5 | 680.0 |
| A final attempt | Failed to qualify; no idle window | Whole unit stopped on deadline |

The fourth arm spent **112.45 of 179.95 observed idle seconds** above the target, including an idle episode lasting about 81.6 seconds. A final had an enabled sign-in UI and successful four-body initialization but could not sustain the lower charge. Thus a longer burst-only grace would conceal a settled-floor problem in this repeated run. An earlier fixed 30-second checkpoint or a readiness-only transition would have given an incomplete answer.

The 1,536-MiB experimental absolute cap contains this run with **70.8 MiB** of measured whole-unit peak headroom; the 2-GiB hard limit leaves **582.8 MiB**. These margins do not include a real Codex parent, staging tailscaled, authenticated SDK/editor workload or a second full local renderer. Zero-swap containment was verified, not relaxed to achieve a pass. For comparison, the previous ten arms had a maximum whole-run kernel peak of 1,425.6 MiB under the smaller one-fixture-peer workload; they cannot establish capacity for the expanded workload.

First B's startup peak was **+2.0 MiB** versus the mean of its flanking A arms, while their A/A peak drift was **+79.3 MiB**. First B's settled peak was **+12.7 MiB**, and its third idle-minute median **+13.8 MiB**, versus those flanking A means. These are descriptive differences, not evidence of a B-specific leak or equivalence. The second B lacks a successfully settled final-A baseline, so its settled comparison is invalid rather than a passing comparison with a missing value. All three A launches matched artifacts and runtime configuration exactly; final A's memory acceptance still failed. The earlier restored A passed identity/listener/reap checks. A failed rollback readiness gate leaves the isolated unit stopped.

Across the first and second completed A stops, residual charge grew **41.9 MiB**: anonymous charge **320.1 → 340.4 MiB**, file charge **292.9 → 306.9 MiB**, and kernel **15.0 → 15.1 MiB**. Controller PSS rose **165.0 → 178.1 MiB**, Chromium PSS **311.5 → 315.0 MiB**, and app-server PSS **121.5 → 123.8 MiB** at those stopped checkpoints. These counters overlap and must not be added as an independent decomposition. The shared browser/app-server/controller remain running between arms. Observer output and state/cache warming contribute to retention; anonymous/controller growth also exists, so file cache alone does not explain it. No cache charge is subtracted from acceptance.

The three-minute total-charge growth screen did not trip, and the evidence retains per-minute anonymous/file/kernel, component RSS/PSS and Node heap/external/ArrayBuffer medians to expose growth masked by another category. Small upward idle drift and substantial lifecycle retention remain unresolved. This finite run does **not** establish an asymptotic plateau or leak freedom. The policy rejects the target-floor/deadline failures rather than accepting them because a growth screen happened not to fire.

The enforced negative run `rpc-shared.memory-xvPaNY` stopped A on its first >= 5-second settled excursion, then its cgroup disappeared. The full characterization completed four 20-body arms plus four initialization bodies in the final A attempt: **84 complete matching bodies**, four-way upstream concurrency, zero remaining fixture producers, and successful post-idle requests in each completed arm. Listeners were released and Desktop reaped at every completed planned stop. Ending on a startup deadline is a failed memory result, not an unexpected transport correctness error.

At the repeated run's highest 100-ms sample, charge was **1,457.7 MiB**, with **1,112.5 MiB anonymous, 306.4 MiB file and 31.0 MiB kernel** in `memory.stat`; shmem was 5.8 MiB and is a subset, not an additional independent charge. Sequential reads and batched kernel counters need not sum exactly. The highest detailed snapshot was **1,454.6 MiB charged**, versus **2,326.1 MiB summed RSS** and **1,463.7 MiB summed PSS**. Shared mappings and differing accounting boundaries make summed RSS unsuitable as the gate; neither RSS nor PSS replaces `memory.current`.

| Component, repeated run | Largest sampled aggregate RSS MiB | Largest sampled aggregate PSS MiB |
| --- | ---: | ---: |
| Chromium, all processes | 1,536.8 | 820.4 |
| Desktop | 354.1 | 303.5 |
| Controller / TLS relay / fixture peer | 271.9 | 225.8 |
| App-server | 125.9 | 125.9 |
| Launcher | 64.6 | 20.7 |
| websocat proxies | 15.1 | 12.3 |

These are independent maxima and must not be added. The JSON retains per-arm RSS/PSS peaks and detailed process snapshots. Chromium is the largest observed component, but the data do not isolate a single allocation cause for every excursion.

| Node component, repeated run | Heap used / total peak MiB | External / ArrayBuffer peak MiB |
| --- | ---: | ---: |
| Desktop main thread | 132.0 / 146.2 | 36.4 / 32.8 |
| Desktop worker | 44.2 / 62.4 | 3.8 / 0.3 |
| Controller | 101.1 / 117.9 | 64.9 / 53.8 |
| Launcher | 5.3 / 8.3 | 1.9 / 0.2 |

Node category/thread maxima are also independent; external includes ArrayBuffers, and worker RSS is process-wide. They cannot be added to derive cgroup usage. The collector reads separate atomic main/worker publications every 100 ms, records process PSS/RSS every 500 ms and at milestones, and retains idle medians for current Node components. It does not force collection or move cache/fixture charges outside the unit.

The separate fresh-state run `rpc-shared.memory-3GUjBB` exercised A → B → planned B child death/recovery → A, with five four-body waves and a shorter 30-second idle per health cycle. Its whole-run kernel peak was **1,442.5 MiB**, with zero hard-limit/OOM events. It completed **80 matching response bodies** and the active-stream shutdown check. Short idle periods supplement rather than replace the primary three-minute observations.

| Fresh-state cycle | Ready / settled, s | Startup peak MiB | Settled peak MiB | Longest settled excursion, s |
| --- | ---: | ---: | ---: | ---: |
| A before | 10.8 / 42.2 | 1,375.4 | 1,352.1 | 10.58 |
| B before fault | 10.7 / 42.0 | 1,434.9 | 1,356.2 | 11.48 |
| B recovery, clock starts before fault | 12.5 / 43.9 | 1,424.8 | 1,358.8 | 24.24 |
| A restored | 10.7 / 41.9 | 1,432.8 | 1,376.7 | 43.85 |

All four cycles fail the lower duration/rolling rules. Characterization exit status **0** means this diagnostic and its cleanup completed; it is **not** memory acceptance. The crash was reaped, manual mode transition relaunched B, and the browser automatically reloaded in **3.098 s** from the fault. This launcher has no automatic restart. A four-way fixture/readiness check then qualified recovered B into settled at **43.881 s** from the fault. Recovery uses the launcher's `diagnostics` mode, unlike the normal A/B startup arms, so its memory totals are kept separate from the matched normal-arm comparison.

Stopping recovered B with a held source rejected its reader in **497.2 ms** after the mode-file request, closed the upstream source and reaped the child/listener. This measure includes the launcher's 500-ms polling interval; the separate 250-ms client-close cleanup gate still requires its own matched test. Restored A matched runtime configuration and all recorded artifacts, completed its fixture/readiness checks and final idle probe, and was then stopped and reaped. The real Codex parent job and external staging edge remain untested.

Across all three new runs, **172 complete bodies** passed count/digest/nested-JSON checks, with the deliberately held partial body recorded separately. Both negative memory stops removed their entire isolated cgroups; the completed recovery run also left no cgroup. A final read-only comparison confirmed the original production PID/start-time and four allowlisted server/browser code hashes unchanged. No production authentication material was accessed or copied.

Validation: **54/54 Node tests passed with Chromium enabled and serial file execution**, including all eight policy tests; **3/3 Python report tests passed**. Node/Python/shell syntax and Git diff checks passed. The first enforced run and the five-arm characterization intentionally have failed memory results. The fresh recovery run completes its diagnostic assertions while retaining failed lower-memory gates in the report and final-engine replay. No authenticated test result is claimed.

## Decision

**NO-GO to authorize authenticated staging.** The proposed numerical envelope is not yet an accepted policy for the declared workload: both A and B cross the conservative settled-duration gate, and B also crosses its rolling-time gate. Treat 1,536 MiB as an experimentally supported startup cap for the observed offline cases, and 1,280 MiB as a settled target/warning with explicitly failing duration rules; do not present either as authenticated capacity validation. Hard 2-GiB containment and zero swap remain mandatory independent safeguards.

A fixed longer startup timer would not resolve excursions caused by requests **after** readiness. Nor may every ordinary burst enter recovery. A longer settled grace interval might accept some measured episodes, but choosing it solely to fit these runs would not establish a safe retention time. Keep the failed result visible; resolve the working-set/retention cause or separately review a revised duration contract and repeat comparable validation. Do not silently replace the five-second rule with a permissive threshold or call a characterization a pass.

No growth-screen trip over a finite three-minute idle window proves leak freedom. Review component trends, retained memory across A/A repeats and missing real parent/edge overhead before claiming adequate staging headroom. Live queue/readiness observers and actual parent qualification remain prerequisites even if a future memory policy passes. Separate authorization is required **before** any authenticated staging begins; production thresholds and daemon remain unchanged.

## Staging prerequisites and operator actions

| Prerequisite | Can prepare without credentials or production changes | What remains before authorization/execution |
| --- | --- | --- |
| Isolated service and state | Review the existing driver/unit templates, allowlisted release manifests, read-only artifact layout, mode-0700 state directories, separate HOME/CODEX_HOME/XDG/browser/edge state, 18214/18215/19222 port plan and 2-GiB/zero-swap settings. Empty directory creation and offline helper-unit negative tests need no account. | Operator provisions a disposable egress-enabled VM or independently verified isolation. Do not create a runnable authenticated stack or reuse production state during this task. Verify no external daemon attachment and all descendants in one cgroup. |
| Network identity, ACL and TLS | Prepare a distinct hostname/tag and least-privilege client-to-staging 18215 ACL proposal, private tailscaled socket/state paths, DNS/certificate requirements and route-check commands. | Tailnet administrator approves/enrolls a **new** node with new state and validates ACLs, DNS, valid TLS, WebSocket upgrades, direct/DERP routing and client reconnection. No production identity/state, default-socket Serve mutation, insecure TLS or Funnel. Enrollment remains behind separate authorization. |
| Disposable accounts | Specify an approved disposable account, required features/entitlements, data-free workspace, quota, retention/revocation owner, and separate parent/backend homes and logins. Prepare metadata-only account-match booleans. | Operator supplies approval and signs in interactively only after authorization. Never access/copy production auth JSON, browser cookies/profiles, tokens, keyrings, environment secrets or Tailscale state. Do not export login codes or account identifiers. |
| Actual parent-job launcher | Review byte-identical launcher, sanitized deployment JSON, exec command, PID/start-time tracking, mode polling, eight-second stop/escalation and exact-A relaunch checks. Offline tmux/launcher recovery can be measured without credentials. | Qualify the actual staging Codex persistent-exec job, sandbox, terminal ownership, child-death case and stop/reissue primitive from its real parent. A tmux pane or a root tool launching a systemd rehearsal is not that qualification. The launcher reads deployment JSON only at launch and has no automatic crash restart; `stop` after child death can leave it running. |
| Health, rollback and resource observers | Prepare/test numeric cgroup/PSS/Node collectors, readiness state machine, metadata schema, strict/characterization distinction, known-failure injections, artifact comparison and whole-unit cleanup. | Qualify metadata-only live host/browser transport, Statsig/runtime/editor and account observers, with loss-of-observer stopping the unit. Integrate readiness transitions and independent resource stops, test active queues/negative cases and reaping. The existing manually phased watchdog alone is insufficient. |

All preparation here is local diagnostic code and documentation. No staging service, VM, network node, account login, or ACL/TLS mutation is provisioned by this work. The full authenticated A → B → A matrix still requires one cold and three warm navigations per arm, two intended clients with two streams each, cancellation/error/peer-fault checks, reconnect and real parent handoff, exact A restoration, and no failed accepted attempts. Include the real parent and local edge overhead inside the same boundary; neither exists in this offline memory workload.

Before starting staging, the operator must record the selected policy, unresolved memory result, environment/account/client identities privately, approved duration, stop/rollback owner, exact parent relaunch primitive, complete observer qualification and separate explicit authorization. No production rollout follows automatically from a staging authorization or pass.

## Reproduction

These commands are offline and signed out; the runner defaults to the original 1,280-MiB lifecycle gate unless an experimental mode is explicitly selected:

```sh
# Enforce the proposed policy; a lower-gate failure stops the containing unit.
bash scripts/diagnostics/rpc-memory-run.sh \
  /tmp/rpc-shared.final-eiBV59 \
  /tmp/rpc-flow-diag-20261117-01/launcher.cjs A,B,A two-phase

# Characterize complete lower-threshold excursions; never an acceptance pass.
bash scripts/diagnostics/rpc-memory-run.sh \
  /tmp/rpc-shared.final-eiBV59 \
  /tmp/rpc-flow-diag-20261117-01/launcher.cjs A,B,A,B,A two-phase-characterize

# Default lifecycle also tests child death, reconnect and active-stream stop.
# Shorter idle here supplements the separate three-minute repeated-arm test.
bash scripts/diagnostics/rpc-memory-run.sh \
  /tmp/rpc-shared.final-eiBV59 \
  /tmp/rpc-flow-diag-20261117-01/launcher.cjs '' two-phase-characterize 30

python3 scripts/diagnostics/rpc-memory-phase-report.py ROOT...
```

Temporary profiles/private logs remain local. Export numeric summaries only. Artifact roots under `/tmp` are local prerequisites, not durable deployment storage. The report retains all detected excursions from 100-ms source data, process/Node peaks, complete peak `memory.stat`, events, per-second maxima and raw-sample hashes; per-second data alone must not be used to reconstruct excursion durations.
