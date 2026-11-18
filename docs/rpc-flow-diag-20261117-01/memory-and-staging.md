# Memory attribution and contained authenticated staging

Current isolated-only follow-up: [two-phase memory criteria, excursion evidence and staging decision](two-phase-memory.md). It supersedes this historical document's manual phase/checkpoint proposal and next-action recommendation; it does not authorize authentication or staging. Results and the original lifecycle gate below remain historical evidence.

**NO-GO to begin authenticated staging; NO-GO for live A/B.** This continues `7d03564`. Production remains on its original A process and release. The 1,280-MiB lifecycle gate has not been raised. The new code changes only disposable diagnostic tooling, including bounded artifact hashing; it does not change the RPC configuration or application implementation. Authenticated startup and the real parent-job handoff still require a separately authorized staging rehearsal.

## Measurement and interpretation

The original 1,386.9- and 1,314.0-MiB results were kernel cgroup charges, not sums of process RSS. The restored A peak already disproved attribution of the failure solely to B. Those captures did not contain per-process peaks or Node heap telemetry, so those details cannot be reconstructed retrospectively.

New runs use the same immutable A/B artifacts, real Desktop host, Codex 0.169.0 app-server, unchanged CLI proxy/websocat, Chromium 1254, two concurrent 7,956,397-byte responses, and a concurrent actual webview. The local producer replays the same 135 decoded write sizes; random fixture contents have the same size and structure. Installed A uses legacy framing; B includes bounded framing plus the existing 512-KiB minimum. This comparison measures the complete candidate treatment, not the minimum-window effect alone. B transport counters have no equivalent legacy-A ledger, so diagnostic overhead is matched only where supported. The connection count is two: webview plus the fixture RPC peer, with two response streams on the latter. This is not two saturated streams on each of two connections. The earlier concurrency matrix covers that separate workload. The account is signed out, networking is loopback-only, and the TLS relay is local. None of these measurements establishes authenticated Statsig or editor readiness.

Each run has a fresh writable state/profile, private tmux server, private mount/PID/network/IPC namespaces and a separate `MemoryMax=2G`, `MemorySwapMax=0`, `OOMPolicy=stop` user service. Artifact/dependency mounts are read-only. Home and the production launcher directory are hidden. Process membership is checked in the private namespace. The complete attribution file contains numeric process IDs, component names, memory counters and milestone names, without application payloads, argv, credentials or environment dumps.

The observer samples `memory.current` every 100 ms, process `smaps_rollup` every 500 ms and at milestones, and Node memory every 100 ms. Node worker heaps have separate thread IDs and atomic files; RSS is process-wide and must not be added across threads. Process and Node peaks are sampled lower bounds. Cgroup `memory.peak` is the authoritative unsampled whole-run high-water mark. Snapshot reads are sequential, so small differences between totals are expected. No forced GC, cache eviction, heap-size flag, stream limit change or production intervention is used.

Every arm keeps its webview open for 30 seconds after health, then closes it, stops/reaps Desktop and its launcher, checks the listener is gone, and observes another 30 seconds. The first complete run also exercises B child death, recovery and active-stream shutdown. A separate reverse-order run measures B → A → B → A; all runs end on A. A third run repeats A → B → A after replacing whole-file artifact hashing with 256-KiB reads. Do not pool its absolute totals with the earlier harness as if instrumentation were identical.

Results and attribution tables are populated below from [machine-readable evidence](memory-attribution.json). MiB means 1,048,576 bytes.

| Run / arm | Sampled charged peak MiB | 30-s idle checkpoint MiB | 30 s after Desktop stop MiB |
| --- | ---: | ---: | ---: |
| 1 / A-before | 1,365.3 | 1,202.6 | 613.3 |
| 1 / B | 1,405.2 | 1,185.7 | 618.2 |
| 1 / A-after | 1,398.3 | 1,212.8 | 636.1 |
| 2 / memory-0-B | 1,371.5 | 1,166.6 | 595.1 |
| 2 / memory-1-A | 1,396.1 | 1,210.3 | 630.1 |
| 2 / memory-2-B | 1,413.2 | 1,205.2 | 635.7 |
| 2 / memory-3-A | 1,407.0 | 1,250.5 | 668.8 |
| 3 / memory-0-A | 1,376.3 | 1,193.4 | 608.3 |
| 3 / memory-1-B | 1,408.5 | 1,199.0 | 627.9 |
| 3 / memory-2-A | 1,425.4 | 1,217.4 | 634.2 |

Whole-run kernel peaks: **1,405.3**, **1,417.4** and **1,425.6 MiB**. Every run failed the unchanged 1,280-MiB gate; all had zero hard-limit/OOM events. All ten arms passed byte/digest/nested-JSON, directory IPC and protocol checks, then released the listener and reaped Desktop. The largest peaks occurred **3.2–4.0 s after the health milestone**, after fixture EOF, during continued signed-out application/browser initialization. Restored A was the largest arm after bounded hashing. Startup, fixture transfer, idle, recovery and rollback were observed separately; no authenticated steady-state claim is made.

| B versus mean of flanking A | Sampled peak delta MiB | 30-s checkpoint delta MiB | A/A peak drift MiB |
| --- | ---: | ---: | ---: |
| Run 1 | +23.4 | -22.0 | +33.1 |
| Run 2 | +11.6 | -25.2 | +10.9 |
| Run 3 | +7.7 | -6.3 | +49.1 |

The leading B in run 2 has no preceding A and is excluded from the flanking comparison. Peak increments of **7.7–23.4 MiB** are small relative to the observed order/GC variation; these data do not establish a B-specific capacity regression or prove memory equivalence. B checkpoints were **6.3–25.2 MiB lower** than paired A.

| Component | Largest concurrent sampled RSS MiB | Largest concurrent sampled PSS MiB |
| --- | ---: | ---: |
| chromium | 1,512.2 | 807.6 |
| desktop | 343.9 | 293.4 |
| controller | 264.5 | 218.4 |
| app-server | 121.4 | 121.4 |
| launcher | 61.3 | 19.5 |
| websocat | 13.1 | 10.3 |
| tmux: server | 3.3 | 1.6 |
| bash | 21.8 | 3.8 |

These are independent component maxima and must not be added. The largest individual Chromium renderer reached **562.0 MiB RSS / 471.3 MiB PSS**; the browser process reached **229.8 MiB RSS / 137.5 MiB PSS**. Utilities, GPU, zygotes and Crashpad are included in Chromium totals; every observed process has its own numeric peak record in the JSON. Short-lived platform probes also appear there. The two persistent websocat processes account for the proxy total. There is no Tailscale process in these offline runs. A separate read-only production edge snapshot was 95.3 MiB RSS / 71.4 MiB charged; it also serves 5984 and is not an attributable peak for this application.

At run 1’s highest detailed snapshot, charge was **1,389.4 MiB**, summed RSS **2,147.3 MiB**, and summed PSS **1,358.4 MiB**. At its highest 100-ms sample, the charge comprised **1,077.4 MiB anon, 295.3 MiB file and 30.3 MiB kernel**, with minor accounting/read-timing differences. The original 1,314.0-MiB failure had 989.6/290.9/29.5 MiB at its highest sample. Shared RSS does not explain away either charged-memory failure.

| Node process, bounded-hash run | Main-thread heap-used peak MiB | Worker heap-used peak MiB | Main / worker external peak MiB | Main / worker ArrayBuffers peak MiB |
| --- | ---: | ---: | ---: | ---: |
| A before Desktop | 119.3 | 44.3 | 27.9 / 3.7 | 24.3 / 0.15 |
| B Desktop | 114.2 | 44.4 | 19.0 / 3.7 | 15.4 / 0.15 |
| Restored A Desktop | 120.8 | 44.1 | 32.2 / 3.7 | 28.6 / 0.15 |
| Controller | 97.5 | — | 57.3 / — | 46.2 / — |
| Launcher (maximum) | 5.4 | — | 1.8 / — | 0.09 / — |

The JSON also records heap-total and process RSS. Thread/category peaks are independently sampled and are not simultaneous totals. Run 1 measured main-thread Node memory; runs 2 and 3 also measure the worker. The first profiler probe exposed competing thread writes; unique per-thread files plus atomic publication fixed it. That incomplete probe and two deliberately stopped setup attempts are excluded from accepted comparisons.

Whole-file hashing of the 281-MiB CLI caused a **282.8-MiB controller external-memory peak**. The fixed bounded-reader implementation reduced this to **57.3 MiB**, while preserving all release/CLI digests. The application-wide peak did not improve (run/order/GC variation dominates), so this tooling fix is **not** reported as a resolved full-stack gate. No cache charges were moved outside the measurement boundary to obtain a pass.

Memory did **not** return to an identical residual after every arm. Run 1 stopped A rose 613.3 → 636.1 MiB (**+22.8**); run 2 matched stopped A rose 630.1 → 668.8 MiB (**+38.7**), while its first B → final A drift was **+73.6**; run 3 stopped A rose 608.3 → 634.2 MiB (**+25.9**). Final cleanup charges were 461.8 / 490.2 / 454.5 MiB. In run 3 only the controller and namespace/tmux/shell support remained; 287.3 MiB was file cache, 162.5 MiB anonymous and 3.9 MiB kernel. This is limited retention/cache warming, not proof of a leak-free lifecycle. The final ten seconds of some A idle windows still exceeded 1,280 MiB transiently (up to **1,326.9 MiB**), despite lower endpoint checkpoints. A genuine settled acceptance window is therefore still unqualified.

The peak phase is identified from explicit document-load, fixture-delivery, health, idle and teardown milestones. A signed-out synthetic fixture is not an authenticated bootstrap. The default `health` phase begins after the two fixture bodies and the eight-second editor visibility check; further browser initialization and allocator/GC transients can continue during that phase. It is not a proven steady state merely because the fixture has reached EOF.

Summed RSS charges the same libraries and Chromium shared mappings to several processes. PSS apportions mapped shared pages and is more useful for attribution, but neither is equivalent to cgroup charge. The latter also includes unmapped page cache, kernel memory and sockets, with shared file pages charged according to ownership/first touch. `file` includes shared memory; `shmem` is a subset, and `kernel` already includes several subsidiary kernel counters. Do not add these subsets again or subtract file cache to turn a failed gate into a pass. The Node `arrayBuffers` counter is included in `external`; heap, external and RSS also are not additive. See the primary [kernel accounting documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html) and [Node 22 memory documentation](https://nodejs.org/docs/latest-v22.x/api/process.html#processmemoryusage).

The controller contains the fixture producer, TLS relay, extracted RPC consumer, body validation and artifact verification. These services share a PID, so their individual RSS cannot be separated from these samples. Its memory is included in every charged result. The CLI proxy is a shell that execs websocat, so it has no lasting separate shell heap. Production's independent Tailscale daemon and remote browser are not silently folded into the isolated cgroup: the new runs replace the edge with a local relay and include a local Chromium. The real parent Codex job is also absent from the private tmux simulation. Those differences require a new staging calibration, not an assumed allowance.

There are too few independent runs for a confidence interval or a leak claim. Artifact-cache charging, run order, browser workers, renderer reuse, natural GC, sampling gaps and instrumentation differ. Compare B with flanking A within each run, report both the peak and settled delta, and retain the A/A drift as uncertainty. A lower settled B does not establish zero incremental cost under authenticated load. After Desktop stops, the browser base processes, controller, app-server and page cache intentionally remain; compare those residuals with the first stopped arm, not with an empty cgroup. The final cleanup sample still includes the controller and file cache. Destroying the unit removes the remaining managed processes; that does not mean global filesystem cache has been erased.

## Acceptance decision and numerical proposal

The 1,280-MiB ceiling was extrapolated from a 958.2-MiB smaller fixture. It is not an established normal-startup requirement for this larger complete stack. Its failure is real and remains recorded. A 2-GiB cgroup limit provides containment, not acceptance. Host `MemAvailable` was approximately 24 GiB during inspection; that capacity does not enlarge the application allocation or permit production changes.

The following is a **proposal for operator review**, not a threshold change or staging authorization. Retain the existing default 1,280-MiB guard until an explicit decision approves a phase-aware experiment. If a fixed 1,280-MiB full-lifecycle requirement is mandatory, the result remains NO-GO and application/browser memory reduction is required before staging. Bounded hashing alone is not grounds to declare that requirement resolved.

| Quantity | Proposed criterion | Rationale/action |
| --- | --- | --- |
| Cold/warm startup and planned recovery | At most 1,536 MiB charged, for at most 90 s; 60 s warm editor deadline | A provisional 1.5-GiB startup envelope leaves 512 MiB, 25% of the hard limit, for detection and shutdown. It is based on the measured complete signed-out workload, not on B passing. Real parent, identity and authenticated workload must fit inside it; no separate additive allowance is assumed. Any breach stops staging. |
| Settled application | Warn above 1,152 MiB; at most 1,280 MiB after 30 s idle, sustained for a further 30 s | Preserves the original operational value for an explicitly settled phase. Warning indicates limited room for account-dependent evaluations, extra documents/tabs or connections. Stop on a settled ceiling breach. A single 30-s checkpoint in these runs does not qualify the extra 30-s stability requirement. |
| Incremental B | Peak at most 64 MiB above the mean of flanking A; settled at most 128 MiB above it | Limits candidate growth independently of absolute headroom. A/A drift over 64 MiB invalidates the pair. These are proposed guard bands, not statistical confidence limits. |
| Teardown/repetition | Residual charge at 30 s no more than 64 MiB above first matched stopped A; no continued growth over three cycles | Detects retention in the same surviving browser/helper/app-server boundary. Require zero transport reservations and terminated producers separately. If retention persists, stop and investigate instead of forcing GC. |
| Hard cgroup | Exactly 2,147,483,648 B; zero swap; zero `max`, `oom`, `oom_kill`, `oom_group_kill` events | Independently enforced for all managed processes. Verify actual cgroup membership and ancestor limits; fail on escaped descendants. Do not rely on summed RSS or host free memory. |
| Observer/shutdown | 100-ms charge/Node samples, 500-ms PSS, event-driven transport bounds; stop on missing coverage; eight-second whole-unit stop deadline | The new watchdog enforces charged limits and cgroup configuration, including cumulative peak. systemd enforces descendant cleanup and SIGKILL escalation. Differential, layer and readiness checks still require a qualified active collector. |

Normal startup, workload-dependent buffers and process aggregate are separate budgets. A body of approximately 7.6 MiB may exist as transport fragments, a decoded body and parsed/nested strings at different points. The current controller deliberately materializes and validates it; this is not a reservation for unlimited concurrent full-body application objects. New tabs, payload sizes, accounts or stream counts require a new capacity measurement.

**Keep every transport reservation unchanged.** Per connection: 448 KiB forward plus 64 KiB reverse = 512 KiB combined; two connections: 1 MiB combined. Priority remains 8 KiB per direction/connection and receipt headroom 256 B. Keep the 1,771,040-B adaptive flight ceiling with the existing 328,192-B atomic allowance and 2,099,232-B per-stream stop threshold. Aggregate estimated flight stops at 4,198,464 B/connection or 8,396,928 B total. Actual decoded backlog stops at 512 KiB/stream, 1 MiB/connection or 2 MiB total. Preserve the existing staging, assembly, parked-writer and source-backing caps and terminal-drain checks in [deployment readiness](deployment-readiness.md#acceptance-and-rollback-criteria). Estimated flight, reservations, native sender bytes, TCP bytes and decoded bytes describe different layers; adding them does not give process memory.

## Actual production launch and edge, read-only inspection

The live process remains host PID 2397437 (`node-22`), child of launcher PID 2394939. Its parent chain is tmux → pane bash → Codex 0.169.0 → Codex Linux sandbox → bubblewrap → sandbox/bash → Node launcher → Node 22 Desktop. The actual parent exec command created deployment metadata and then ended with `node /tmp/rpc-flow-diag-20261117-01/launcher.cjs`. Do not replay its setup portion: it writes production mode/configuration and copies local state. In staging, precreate sanitized metadata, then exercise just the same launcher invocation through a new real Codex parent exec job.

The launcher SHA-256 remains `0b7c058e698bba7cf35d776eb9acf60daac526158a4e5a5ffd39268abd1c1db9`. It reads deployment JSON once; `normal`, `diagnostics` and `stop` mode changes are polled every 500 ms. The production JSON selects `/tmp/codex-rpc-candidate.thShCI/src/server/main.js`, cwd `/home/naoto-aoki/Projects/20261116-codex-web`, loopback port 8214 and the repository `codex.sock` (mode 0600). Production mode stays `normal`. The launcher has no release selector, automatic crash restart or stop deadline, and writing `stop` after a child has died leaves the launcher running. A symlink update requires launcher exit and a new parent exec job; editing deployment JSON while it runs does not switch release.

Production runs in unlimited `session-3.scope`. Its independent system `tailscaled.service` uses `/var/lib/tailscale/tailscaled.state` and `/run/tailscale/tailscaled.sock`, with no application memory limit. Tailscale 1.104.5 Serve has TLS-terminated TCP forwarding for 8214 → `127.0.0.1:8214` and a separate 5984 mapping. No HTTP reverse proxy is configured. Both mappings, production PID/start time, launcher/runtime/config/mode hashes, source/asset manifest and socket inode are compared again at completion in the evidence. No default-socket `tailscale serve` mutation is part of this work.

## Exact staging preparation and execution procedure

These instructions are **not executed by this task**. Stop before step 3 until a separate staging authorization is recorded. Use a disposable Linux VM with working outbound HTTPS, its own filesystem and an operator-owned terminal. The VM must not mount production home, state, keyring or sockets. This is the selected staging topology; a VM is not currently provisioned by this work. A same-host alternative requires separately verified mount/PID/network isolation and egress before authentication. The offline loopback namespace cannot perform this test.

1. Prepare a unique mode-0700 root, for example `STAGE=/var/tmp/codex-staging-20261118-01`. Create `releases/A`, `releases/B`, `control`, `work`, `bin`, `evidence/node`, `backend-home`, `parent-home`, `browser-profile`, `tailscale`, `tmp` and separate XDG config/cache/data directories. Transfer only allowlisted immutable `src/`, `scratch/asar/`, package/dependency artifacts, Node 22, the pinned Codex binary and unchanged proxy. Copy the byte-identical launcher to `control/launcher.cjs`, the new Node preload and watchdog, and [the prepared staging driver](../../scripts/diagnostics/rpc-staging-parent.sh) to `control/start-parent.sh`. Install the full pinned Chromium tree with a `bin/chrome` link to its executable and websocat on the staging PATH. Do not transfer production dotfiles, environment snapshots, auth JSON, Statsig state, browser profiles, cookies, keyring material or Tailscale state. Make the A/B releases read-only and save a manifest before executing either. Reuse the already built B; do not retune its windows or reservations.
2. Reserve loopback application port **18214**, private Tailscale TLS port **18215**, and local browser debugging port **19222**. Check `ss -ltn` and fail if occupied. Use `$STAGE/tailscale/tailscaled.sock`, `$STAGE/tailscale/tailscaled.state`, `$STAGE/control/app-server.sock` and `$STAGE/control/codex.sock`; none may resolve to production. Create `active -> releases/A`. Write `control/deployment.json` with `candidateDirectory=$STAGE/active`, `workingDirectory=$STAGE/work`, `cliPath=$STAGE/bin/codex_remote_proxy`, `unixSocket=$STAGE/control/codex.sock`, `host=127.0.0.1`, `port=18214` and the manifest identity as `sourceRevision`. Select `diagnostics` for both staging arms, so bootstrap observation is matched. This differs from production's unchanged normal mode.
3. **Approval boundary.** Obtain explicit authorization for authenticated staging, the disposable account, test client, node identity, approved memory policy, duration and rollback owner. Authentication and tailnet enrollment start only after this boundary. Authorize a rehearsal only, not a production trial.
4. In an `env -i` environment containing only staging HOME/CODEX_HOME/XDG/TMPDIR/PATH and necessary nonsecret TLS trust settings, have the operator sign in interactively to the approved disposable account. Use `codex login --device-auth` with the separate backend and parent Codex homes. Obtain credentials by separate login in each home; never copy an auth file from production. Do not expose login links/codes, account identifiers or tokens in the exported evidence. Provisioning login is outside the timed bootstrap. Stop provisioning processes, including any persistent staging Codex daemon, before the measured start; reject a backend or parent that attaches to a daemon outside the containment unit.
5. Start **one** `codex-staging-stack.service` under the staging VM's user manager, with `MemoryMax=2G`, `MemorySwapMax=0`, `OOMPolicy=stop`, `KillMode=control-group`, `TimeoutStopSec=8`, `Restart=no` and `RuntimeMaxSec=1800`. Its driver starts the dedicated tailscaled, backend app-server and local Chromium as children, then keeps the real interactive Codex parent in a new, private tmux server/pane inside this unit. Do not attach to a tmux server or Codex daemon started outside the unit. Invoke the parent with the pinned `codex --cd "$STAGE/work" --add-dir "$STAGE" --sandbox workspace-write --no-alt-screen` and its own fresh home. Verify all descendants, including any shared Codex daemon, Crashpad and browser helpers, remain under the same cgroup. A daemon connected from outside invalidates the run. The private tmux shell running the offline harness is not a substitute for this real parent.

   The containment launch primitive is:

   ```sh
   systemd-run --user --unit=codex-staging-stack --pty --collect \
     -p MemoryMax=2G -p MemorySwapMax=0 -p OOMPolicy=stop \
     -p KillMode=control-group -p TimeoutStopSec=8 -p Restart=no \
     -p RuntimeMaxSec=1800 --working-directory="$STAGE/work" \
     /usr/bin/env -i PATH="$STAGE/bin:/usr/bin:/usr/sbin" \
     HOME="$STAGE/parent-home" CODEX_HOME="$STAGE/parent-home/codex" \
     TMPDIR="$STAGE/tmp" XDG_CONFIG_HOME="$STAGE/xdg-config" \
     XDG_CACHE_HOME="$STAGE/xdg-cache" XDG_DATA_HOME="$STAGE/xdg-data" \
     /usr/bin/bash "$STAGE/control/start-parent.sh" "$STAGE"
   ```

   The prepared `start-parent.sh` driver has passed shell syntax checks but has not been launched with authentication. The operator must review its VM paths and verify its terminal/job lifecycle. Qualification is a prerequisite; the actual parent job is not yet claimed to pass. It must start the following processes, using only staging paths, and keep running until the parent session ends:

   ```sh
   tailscaled --tun=userspace-networking --port=0 \
     --socket="$STAGE/tailscale/tailscaled.sock" \
     --state="$STAGE/tailscale/tailscaled.state" --statedir="$STAGE/tailscale"
   # Backend child: use backend-home and backend-home/codex, not parent-home.
   "$STAGE/bin/codex" app-server --listen "unix://$STAGE/control/app-server.sock"
   ```

   The app-server creates an alias to a daemon socket. Resolve it privately, then hard-link that socket to `control/codex.sock` and verify device/inode equality inside Desktop's namespace; never link an existing production socket. Expose the staging daemon directory in any private `/tmp` mount. Local Chromium uses `--user-data-dir=$STAGE/browser-profile` and `--remote-debugging-address=127.0.0.1 --remote-debugging-port=19222`. Do not disable certificate validation or reuse a production browser. Userspace Tailscale avoids host TUN/routing changes and stays in the same unprivileged cgroup; it is a recorded topology difference from the production daemon, not proof of kernel-TUN equivalence.
6. Every Tailscale command must name the staging socket. Enroll the fresh hostname with operator interaction, apply an ACL allowing only the approved client and 18215, then configure the same edge protocol as production:

   ```sh
   tailscale --socket="$STAGE/tailscale/tailscaled.sock" up --hostname=codex-staging-20261118-01
   tailscale --socket="$STAGE/tailscale/tailscaled.sock" serve --bg \
     --tls-terminated-tcp=18215 tcp://127.0.0.1:18214
   tailscale --socket="$STAGE/tailscale/tailscaled.sock" serve status --json
   ```

   Confirm a distinct node ID, name and address through a private comparison; export only booleans. Verify HTTPS with the staging DNS name from the intended client using its valid Tailscale certificate, plus TLS, WebSocket upgrade and direct/DERP route metadata. No `--insecure`, Funnel, production identity or production Serve command is permitted. See the [Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve) and [userspace networking reference](https://tailscale.com/docs/concepts/userspace-networking).
7. Before the first application launch, attach the guard from a separate unit. Keep its default **1,280 MiB** limits unless the operator has explicitly approved the numerical proposal. For a reviewed phase-aware policy, the explicit arguments would be `--startup-mib 1536 --steady-mib 1280`. Do not infer that approval from this document. `memory.phase` contains `startup`, then `steady` after the editor and 30-s idle checkpoint; set it back to `startup` before every planned reload/reconnect/release transition. A startup phase may not last over 90 s. Use a new log and ready file each guard start. The guard's own unit must stop the stack even if its Python process crashes:

   ```sh
   printf 'startup\n' > "$STAGE/control/memory.phase"
   systemd-run --user --unit=codex-staging-guard \
     -p 'ExecStopPost=/usr/bin/systemctl --user stop codex-staging-stack.service' \
     /usr/bin/python3 "$STAGE/control/rpc-staging-watch.py" \
     codex-staging-stack.service "$STAGE/control/memory.phase" \
     "$STAGE/evidence/memory-001.jsonl" --ready-file "$STAGE/control/guard-001.ready"
   ```

   Require the ready file, an active guard unit and a qualified metadata collector before the parent job launches Desktop. Exercise loss of guard, bad phase file, memory breach and eight-second forced cleanup with disposable helper processes first. The new watchdog has been checked with a disposable Node service and a SIGTERM-ignoring helper; killing a disposable guard service also stopped its helper stack through `ExecStopPost`. The actual VM driver/parent/collector combination still needs a rehearsal. The guard does not implement transport, differential-memory or editor gates. The qualified collector must raise the same whole-stack stop on those failures. The 2-GiB hard limit covers all instants; the narrower settled limit is sampled at 100 ms, and a sub-sample settled transient below the startup ceiling can escape that sampled guard. Preserve this measurement uncertainty rather than claiming an instantaneous settled bound. Do not use the existing raw browser capture for an authenticated run.
8. In the new staging Codex session, request an actual persistent exec job running the launcher. For A, the exact child shell command is:

   ```sh
   env -u CODEX_WEB_SHARED_TRANSPORT -u CODEX_WEB_TRANSPORT_METRICS \
     REHEARSAL_MEMORY_DIRECTORY="$STAGE/evidence/node" \
     NODE_OPTIONS="--require=$STAGE/control/rpc-memory-node.cjs" \
     /usr/bin/node-22 "$STAGE/control/launcher.cjs"
   ```

   B uses the same command with `CODEX_WEB_SHARED_TRANSPORT=1 CODEX_WEB_TRANSPORT_METRICS=1` instead of the two `-u` arguments. There is no fixture fetch preload, API redirect or copied production environment. Confirm actual `/proc` executable, cwd, artifact manifest, namespace/socket inode, cgroup and launch flags. Retain the parent exec session handle and launcher/child PID **with start times**. The operator must demonstrate stopping and reissuing this job from the actual staging parent, rather than merely changing a symlink beneath a running child.
9. Run the test matrix below. The same immutable releases, account, client route, workload, diagnostic overhead and browser settings apply to A → B → A. Use exactly two admitted WebSocket connections; issue two concurrent streams on each through the existing app-host connection, not through an extra probe socket. Close other tabs. Keep one measured local browser in the cgroup for comparability with this investigation; if the second browser is remote, record its process/PSS/Node-equivalent renderer heap independently and exclude it explicitly from the hard local boundary. The local browser uses `http://127.0.0.1:18214`; the external approved browser uses the verified staging Tailscale TLS name/18215. The local browser is not represented as a tailnet path test. Define a cold navigation per arm as a fresh browser context with its HTTP cache cleared and a newly started Desktop; the three warm reloads reuse that context. Record this definition, which does not mean a cold whole-VM boot. Measure the local tailscaled and real parent within the 2-GiB unit; do not substitute their production process charges.
10. End by executing the rollback below, comparing exact A identity, then stopping all staging units and revoking the disposable node/account sessions under operator ownership. Preserve only reviewed metadata, never publish staging profiles or auth state.

## Release switching and rollback commands

These operations apply only to the approved staging root and its parent exec job. Keep the guard and metadata collector active across a normal release transition. First write `stop` to **staging** `control/mode`, wait up to eight seconds for launcher and Desktop exit, and require loopback 18214 to refuse connections. Check PID start times before any signal. If the child has already died and the launcher remains, send SIGTERM to the recorded staging launcher; do not rely on another `stop` write. A failure to reap, an unexpected PID or an occupied port aborts the rehearsal and stops `codex-staging-stack.service`, whose systemd deadline terminates all descendants. Do not use `pkill`, kill the production tmux pane or modify 8214.

Once the old launcher has exited and the listener is gone, select the release atomically, then launch a **new real parent exec job** with the corresponding A/B command above:

```sh
# STAGE has already been checked against the operator's staging manifest.
ln -s releases/B "$STAGE/active.next"
mv -Tf "$STAGE/active.next" "$STAGE/active"
printf 'diagnostics\n' > "$STAGE/control/mode"
printf 'startup\n' > "$STAGE/control/memory.phase"
```

Rollback uses exactly the same sequence with `releases/A`. Navigate afresh for every cross-version change, verifying legacy → `codex-ipc-budget-v1` → legacy and the exact corresponding preload hashes; stale tabs cannot negotiate both versions. After rollback require account, complete bootstrap, primary runtime, route-mounted editor, directory IPC and resource drain to pass again. A passing root HTTP page alone is insufficient. Do not restart B after an acceptance breach.

On a resource/observer/integrity breach, stop the entire staging stack immediately with `systemctl --user stop codex-staging-stack.service`; capture the last cgroup sample/events before the cgroup disappears. Verify no members/listeners remain, restore the A link only while stopped, and have the operator restart the contained driver with a fresh guard/collector under the existing rehearsal authorization. Start A without B flags, use the existing **staging** profiles, and validate exact A again. If A also fails, leave staging stopped and report NO-GO. A process OOM, hard-limit event or an unmonitored interval fails the entire rehearsal even if recovery succeeds.

## Final staging test and remaining prerequisites

| Test | Required evidence and pass condition |
| --- | --- |
| Authenticated initialization | `account/read` confirms the approved disposable account without exporting its identity or tokens; request completes within 15 s. A signed-out or fallback account fails. |
| Statsig | Real upstream request, decoded byte/order totals agreeing across host/browser, successful upstream/browser EOF, valid outer/nested JSON checked without saving content, and Ready evaluations within 30 s. Measure real payload/notification sizes; do not require a historical exact byte count. Missing segments, abort, duplicated delivery or fallback initialization fails. |
| Runtime/editor | Explicit primary runtime, routes-mounted event, enabled/focused editor accepts and clears an unsent test string; at most 90 s cold or 60 s warm. Ready logs, runtime flags and route milestones must be separately correlated; the existing route milestone alone does not prove SDK completion. |
| Repeatability | One cold and three warm navigations per arm of A → B → A, identical account/path/workload; preserve client route metadata, wall-clock calibration bounds and workload digests. No failed accepted attempts. Recheck account/editor after reconnect and after restored A. |
| Concurrent RPC | Two connections × two streams, sequence/digest/byte/EOF checks, mixed IPC and reverse traffic; one stalled consumer must not corrupt or stop the healthy peer. Monitor active reservations, estimated flight, decoded backlog, staging, assembly, native WS/TCP queues and all memory boundaries throughout. Counters logged only at close are insufficient. |
| Cancellation/error | Explicit browser abort while a source is active reaches that source within 3 s; parked writer rejects, producer terminates, reader has the expected error, and reservations/credit/queues drain. Close-related cleanup within 250 ms in the matched two-client fixture. Subsequent healthy operation succeeds. EOF before cancel does not pass cancellation. |
| Reconnect/crash | Deliberate same-version child death and network interruption, new listener, successful fresh upgrade and IPC within 10 s of listener readiness; editor/primary runtime recover. No unplanned upgrade failures, silent loops or stream corruption. |
| Switching/containment | Real parent exec handoff A → B → A, no overlapping listeners/children, matching release/preload/runtime identity, exact A restoration, zero hard-limit/OOM events and no escaped children. Resource observations cover startup, transfers, idle, fault recovery, stop and rollback. |

Available now: immutable isolated A/B releases and hashes, the exact launcher/proxy bytes, pinned CLI/Node/Chromium, offline replay and integrity tests, fresh-profile private namespaces, attributable cgroup/PSS/Node measurements, a bounded hash implementation, and a default-1,280-MiB fail-closed watchdog with tested whole-unit stop/deadline behavior.

Operator prerequisites still missing: a disposable egress-enabled staging VM or equivalently verified namespace; a distinct staging Tailscale identity with node enrollment, ACL, DNS/certificate and client-route checks; an approved disposable test account and separate interactive backend/parent logins; the actual new staging Codex parent session and qualification of the prepared driver/persistent-exec lifecycle; a qualified metadata-only active transport/browser/Statsig observer and its live stop integration; an approved numerical policy for the authenticated workload and explicit staging authorization. Production authentication and Tailscale state are not reusable prerequisites.

The contained rehearsal may begin only after those prerequisites and a numerical-policy decision are recorded, and the guard/driver/collector negative checks pass in staging. Today's recommendation remains **NO-GO**. There is no live A/B or production cutover authorization in this work.

## Reproduction and validation

On this host, the prebuilt isolated artifact root is `/tmp/rpc-shared.final-eiBV59`. It is an available local prerequisite, not a durable deployment artifact store. Archive and verify its allowlisted immutable artifacts before deleting temporary files. To repeat the offline diagnostic with the final tooling (no authentication or external network):

```sh
bash scripts/diagnostics/rpc-memory-run.sh \
  /tmp/rpc-shared.final-eiBV59 \
  /tmp/rpc-flow-diag-20261117-01/launcher.cjs A,B,A
```

The runner prints its new private root. Exit status 1 with the explicit 1,280-MiB assertion is the expected failed gate, not a successful acceptance. Export numeric attribution with `python3 scripts/diagnostics/rpc-memory-report.py ROOT...`; the checked-in evidence additionally retains instrumentation provenance, negative guard checks and production identity comparisons. Profile directories and private logs stay local.

All **46 repository tests passed with Chromium enabled and file concurrency 1**, including the new worker/publication regression. Node/Python/shell syntax and diff checks passed. An earlier combined parallel run had 45 passes and one failure in the existing adaptive-window ACK-floor timing assertion; the controlled serial suite passed without changing that assertion. The separately run diagnostic and asset suites also passed 32/32 and 14/14. The three full-stack runs intentionally remain failed memory acceptance tests; no authenticated acceptance result is claimed. The staging driver has syntax validation only.
