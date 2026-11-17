# Isolated RPC minimum-window experiment

## Approved isolation-only follow-up

The user approved the resource-budget plan for further isolated validation only.
[Budget validation](budget-validation.md) records the implemented scoped limits,
concurrent-client tests, private kernel-network tests and supervisor rehearsal.
The live recommendation remains **NO-GO**; no production deployment, restart or
configuration change was authorized or performed.

Implemented, disabled by default, **not deployed**. No production artifact, daemon,
listener, environment, or browser profile was changed. This is a host-wide A/B
candidate, not a bootstrap-specific policy or an approved optimization.

## Subsequent guard investigation

The [guard review](guard-review.md) separates estimator credit from measured
buffering and memory, with [per-test measurements](guard-quantitative.md), longer
stalls and disconnect validation. The original 1-MiB live-trial stop remains in
force. The proposed replacement budgets are for separate approval and do not make
this experiment ready for production cutover.

## Treatment and runtime invariant

`rpc-window-candidate.cjs SOURCE_ASAR NEW_DESTINATION [baseline|512k]` defaults to
`baseline`. It copies a pinned Desktop 26.1007.30912 artifact tree to a new directory.
Only B replaces the AST initializer `nt=65536` with `nt=524288`. The ordinary
preparation and launch paths do not call this builder. Switching artifacts, rather
than an environment flag inside the controller, selects the treatment.

The builder rejects existing destinations, destinations within source/live asar,
symlink/hard-linked inputs, duplicate declarations, unexpected constants, and a
changed controller. It pins the complete controller hash (allowing the existing
observation hooks), so `st.window=et` and the `nt` ACK clamp are explicitly checked.
It refreshes any host `.br`/`.gz` siblings; browser files and their compressed
siblings are copied unchanged. Existing instrumented sources are supported;
compressed browser files must already match the source snapshot.

Each candidate includes `rpc-window-experiment.json`: input/output host hashes,
browser hash, and values from **executing that candidate's extracted RPC core**.
This avoids running Desktop startup or opening a production connection.

| Runtime state                       |          A |          B |
| ----------------------------------- | ---------: | ---------: |
| Constructed window                  |     262144 |     262144 |
| Minimum constant                    |      65536 |     524288 |
| Maximum constant                    | 1073741824 | 1073741824 |
| After first ACK                     |     262144 |     262144 |
| After second ACK in builder fixture |     524288 |     524288 |

There is no construction-time `minimum <= initial` assertion or clamp. The minimum
is an ACK target floor, not an invariant on every window state. The first-ACK
bootstrap branch does not clamp. Keeping the initial value is compatible: B still
blocks after the first typical write until an ACK, then adapts normally. A separate
clock-controlled test exercises sustained low-rate adaptation to each floor.
At that floor, actual RPC serialization reports 262404 estimated bytes for a
65536-byte decoded write: first B write does not block; second reaches 524808 and
blocks. A at its floor blocks on the first write. This uses existing atomic
overshoot, not a new producer or parallel writable queue.

ACK success still follows remote writer settlement. ACK failures, close, abort,
ordering, stream strategies, gains, maximum, and all controller logic are unchanged.
A larger minimum is not a hard cap: adaptation can exceed it substantially.

## Reproduce isolated tests

From the checkout (no application build or production restart):

```bash
node --expose-gc --test scripts/diagnostics/rpc-window.test.cjs scripts/asset-cache.test.cjs
PLAYWRIGHT_MODULE=/tmp/astro-generator-browser/node_modules/playwright \
CHROMIUM_PATH=/tmp/codex-browsers/chromium-1254/chrome-linux64/chrome \
node scripts/diagnostics/rpc-window-matrix.cjs /tmp/rpc-window-results-NEW
```

The matrix runs A/B sequentially at ACK/consumer delays of 0/0, 40/3, and 100/30 ms.
ACK delay is injected in the test transport, after settlement; it never changes
production ACK semantics. Every run includes real Chromium WebSocket/MessagePort,
24 ordered 64-KiB chunks and EOF, a stopped consumer followed by resumption, and
Node stream tests with 32 chunks, diagnostics on/off, early/middle/late cancel,
upstream cancellation or already completed EOF, stopped source production,
rejected pending credit, and failed writer settlement. The Node adapter resource
fixture additionally mixes 900/262404/320547 estimator-byte atomic writes, runs two
concurrent streams, withholds settlement, checks queue plateaus, and rejects every
retained write. Its hook retains RPC arguments until settlement, then disposes them.

Chromium sampling records host RSS/heap and summed renderer RSS from `/proc` at
20-ms intervals, including explicit GC settling at the end; renderer identities
come from Chromium's own process information. Three stalled-writer snapshots must
match at the last two observations and show an unsettled write. Node records
queue counts, estimator occupancy, and process memory at stall/end. These are
short synthetic checks, not heap caps, a memory leak proof, production throughput
measurements, or the six paired CFFV5 trials required by the analysis. The existing
controller may grow beyond the proposed trial's 1-MiB guard even in loopback; stop
any later deployment trial if it does. Do not silently introduce a second tuning
variable to make that guard pass.

## Recorded results

All **41 tests passed**, with no skips: six fresh-process A/B matrix runs × six
tests (36), plus three window/builder/resource tests and two asset-cache tests (5).
Isolated TypeScript server compilation, Prettier, and diff checks also passed.
[Machine-readable evidence](experiment-results.json) records candidate hashes,
runtime constants, per-run memory and queue measurements. No production comparison
or startup improvement is claimed.

Two full artifact copies were prepared under `/tmp/rpc-window-ab-IyFUrl`.
All 51,257 files were compared: only host JS and manifest differ; the source host
hash is unchanged. The emitted treatment changes exactly one numeric initializer.
Both candidates execute with initial/first-ACK 262144, maximum 1073741824, and
minimum 65536 (A) or 524288 (B). The floor test verifies two B writes at 524808
estimated bytes before blocking; the real sessions independently verify the
262404-byte estimator charge per 64-KiB decoded write.

| Run (mode–ACK ms–consumer ms) | Peak estimated flight (B) | Host RSS peak growth (MiB) | Host heap peak growth (MiB) | Renderer RSS peak growth (MiB) |
| ----------------------------- | ------------------------: | -------------------------: | --------------------------: | -----------------------------: |
| baseline-0-0                  |                 1,312,020 |                       0.00 |                       16.11 |                          38.61 |
| 512k-0-0                      |                 1,312,020 |                       0.00 |                       16.09 |                          40.86 |
| baseline-40-3                 |                 2,624,040 |                       0.00 |                       16.07 |                          41.15 |
| 512k-40-3                     |                 2,624,040 |                       0.00 |                       16.10 |                          43.07 |
| baseline-100-30               |                 1,836,828 |                       0.00 |                       16.02 |                          40.29 |
| 512k-100-30                   |                 1,836,828 |                       0.00 |                       16.01 |                          39.75 |

Every Chromium pause plateaued at one writer started, zero settled across three
observations, before consumption resumed and all 24 chunks/EOF verified. This
initial pause precedes adaptation and therefore does not demonstrate B's steady
floor capacity. The warmed adapter stall fixtures plateaued at 1–2 queued writes
for A and 2 for B (262404 or 582951 estimator bytes); rejected writes returned queue
occupancy to zero. Mixed-write concurrent fixtures reached up to 26 outstanding
writes in total under adaptive growth, rather than staying at the minimum.
Adapter RSS and post-GC heap measurements are retained in the evidence JSON.

Memory growth in this table includes browser core compilation, representations,
and test instrumentation, not just additional decoded flight. Host RSS reused
already allocated pages even while heap allocation grew. These short runs do not
establish long-term retention, production memory bounds, or the paired sustained
16-MiB guard. **Every recorded loopback peak exceeded the 1-MiB deployment trial
guard in both variants.** Correctness tests intentionally observe rather than cap
that unchanged algorithm; a future guarded production trial must stop B on breach.
Production performance/resource acceptance remains outstanding.

## Exact candidate preparation (safe now; no launch)

Use an immutable source snapshot with the same diagnostics and compression in A/B.
Do not run `npm run prepare`, `npm run build`, or `prepare:asar` in the live checkout.
The paths below are examples of new staging directories, never the live asar.

```bash
rpc_source=/home/naoto-aoki/Projects/20261116-codex-web
rpc_ab=$(mktemp -d /tmp/codex-rpc-window.XXXXXX)
mkdir "$rpc_ab/common"
git -C "$rpc_source" archive HEAD | tar -x -C "$rpc_ab/common"
ln -s "$rpc_source/node_modules" "$rpc_ab/common/node_modules"
(cd "$rpc_ab/common" && ./node_modules/.bin/tsc -p src/server/tsconfig.json)
mkdir -p "$rpc_ab/common/scratch"
cp -a --reflink=auto "$rpc_source/scratch/asar" "$rpc_ab/common/scratch/asar"
node "$rpc_source/scripts/diagnostics/instrument-rpc.cjs" "$rpc_ab/common/scratch/asar"
(cd "$rpc_ab/common" && node scripts/precompress-assets.cjs scratch/asar/webview)
for rpc_mode in baseline 512k; do
  mkdir -p "$rpc_ab/$rpc_mode/scratch"
  cp -a "$rpc_ab/common/src" "$rpc_ab/$rpc_mode/src"
  ln -s "$rpc_source/node_modules" "$rpc_ab/$rpc_mode/node_modules"
  node "$rpc_source/scripts/diagnostics/rpc-window-candidate.cjs" \
    "$rpc_ab/common/scratch/asar" "$rpc_ab/$rpc_mode/scratch/asar" "$rpc_mode"
done
```

Retain both manifests. Compare all files between A/B: only the host JS, any host
compressed siblings, and the experiment manifest may differ. Check browser JS and
compressed sidecars have identical hashes. The candidate builder tests also check
that the source bytes remain unchanged. Existing source maps are not regenerated.

## Deployment and A/B switching — separate approval required

The actual production supervisor is not visible from this workspace. Its verified
stop/start commands and complete launch environment must be recorded at approval
time; inventing a service name would not be an exact rollback procedure. Until
that information and separate deployment approval exist, **stop here**. Preserve
its original command, cwd, environment, restart policy, and previous artifact tree.
Do not start a candidate alongside it on port 8214 or let a supervisor restart it.

After that approved stop, the following commands define the candidate process
lifecycle exactly in one Bash session. Preserve every additional original launch
variable. Keep the original working directory to preserve cwd-relative state;
the absolute entrypoint selects the candidate asar through `__dirname`.

```bash
rpc_mode=baseline  # choose 512k for B; no other setting changes
cd "$rpc_source"
CODEX_RPC_DIAGNOSTICS=1 CODEX_BOOTSTRAP_DIAGNOSTICS=1 \
CODEX_CLI_PATH="$rpc_source/scripts/codex_remote_proxy" \
CODEX_UNIX_SOCKET="$rpc_source/codex.sock" \
node "$rpc_ab/$rpc_mode/src/server/main.js" --host 127.0.0.1 --port 8214 \
  >"$rpc_ab/$rpc_mode.stdout.log" 2>"$rpc_ab/$rpc_mode.stderr.log" &
rpc_trial_pid=$!
```

Before measuring, verify process command/cwd, normal readiness, and the hashes of
its selected host/browser files against that candidate's manifest. Evaluate
the following command to repeat the runtime core check:

```bash
node - "$rpc_ab/$rpc_mode/scratch/asar" "$rpc_source" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { verify, target } = require(path.join(process.argv[3], 'scripts/diagnostics/rpc-window-candidate.cjs'));
console.log(verify(fs.readFileSync(path.join(process.argv[2], target), 'utf8')));
NODE
```

In actual diagnostic records verify first-send window
262144, first-ACK 262144, and after-clamp windows >= the selected floor. B is not
expected to start at 512 KiB. Never use historical stream/window/session IDs as
selectors. Identify each bootstrap by its current diagnostic context.

On the unchanged production origin/profile set
`localStorage.setItem('codex:rpc-diagnostics','1')` before reload; retain the normal
cache/account/viewport/compression. Wait for host and browser readiness. Run six
warm pairs in balanced order AB, BA, AB, BA, AB, BA, one measured navigation at a
time. Between members, stop the candidate with:

```bash
kill -TERM "$rpc_trial_pid"
wait "$rpc_trial_pid" || true
```

Verify exit and listener release before executing the launch block with the next
mode. Collect the endpoints and calibration bounds in [analysis.md](analysis.md),
including byte/order/EOF totals, read-gap/credit overlap, ACK percentiles, socket
bufferedAmount, host and renderer memory, and mount/editor readiness. Abort B on

> 1 MiB estimated selected-stream flight, >16 MiB sustained paired RSS increase in
> either process, monotonically growing queues, or >25% worse p95 ACK RTT. A single
> atomic overshoot is included in the flight observation. The >=15% median body-time
> improvement criterion and all correctness/resource gates must pass before any
> separate rollout decision. This implementation grants no rollout approval.

## Rollback

For an A/B rollback, stop/wait B using the exact PID commands above, verify port
release, select `rpc_mode=baseline`, and execute the same launch block. This restores
65536 minimum with identical diagnostics; it does not require editing a live file.

For full production restoration, stop/wait the trial process, restore the saved
original supervisor command/artifacts/cwd/environment, remove both diagnostic flags
from that launch environment, and use its recorded start command. On the browser,
remove `codex:rpc-diagnostics` and reload. Verify normal health/editor readiness,
original loaded artifact hashes and no new diagnostic events. Keep both trial trees
and metadata for review; do not overwrite the original tree. Neither this deployment
nor rollback has been executed here.
