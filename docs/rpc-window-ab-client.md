# CFFV5 capture environment and readiness

Verified locally on 2026-11-17 at 13:32 UTC. **No live captures or application
requests were made.** Host acceptance, supervisor commands, approved safety
thresholds, rollback readiness and verified active deployment are pending.
The proposed 1-MiB adaptive-flight guard is not considered approved.

## Fixed client environment

| Item | Verified value / planned setting |
| --- | --- |
| Client | CFFV5, Linux in WSL; `/etc/resolv.conf` identifies WSL-managed DNS |
| Persistent profile | `/tmp/bootstrap-diag-20261117-01/profile`; existing private directory, retained in place for all three batches |
| Profile version | `Last Version` reports `156.0.8078.4`, matching the prior RPC capture |
| Chromium executable | `/tmp/codex-review-browsers/chromium-1248/chrome-linux64/chrome` |
| Chromium version | `Google Chrome for Testing 156.0.8078.4`; verified with `--version` and a separate disposable offline context |
| Chromium SHA-256 | `377a9fc07b495c3b8d0ab8ec1fdfd153641759f9756fea34d8dfce4de82f5025` |
| Library path | `LD_LIBRARY_PATH=/tmp/codex-startup-libs/extracted/usr/lib/x86_64-linux-gnu` |
| Node | `/tmp/node-v22.23.3-linux-x64/bin/node`, 22.23.3 |
| Playwright | `/tmp/codex-startup-tools/node_modules/playwright`, 1.65.1, with explicitly pinned Chromium above |
| Cache | Existing profile and normal HTTP cache; no clearing, disabling, bypassing service workers or cache overrides in measured runs |
| Viewport / browser mode | 1440 × 1000; headless (`HEADED` unset or `0`) |
| Warmup | One unmeasured navigation per batch, visible composer, then 15 seconds settling |
| Timed runs | Three serial warm reloads per batch; fixed 360-second observation after navigation commit, no `READY_SELECTOR` |
| Sequence | A-before ×3 → host-approved B ×3 → host-restored A-after ×3; a fresh host relay per batch |
| Browser diagnostics | Init script sets `codex:rpc-diagnostics=1` before each page loads |
| Host diagnostics | Require active `CODEX_RPC_DIAGNOSTICS=1` and `CODEX_BOOTSTRAP_DIAGNOSTICS=1`, same settings in all batches |
| Capture | CDP network/WebSocket/console/exception events; identical DevTools/V8/user-timing trace categories; page state and screenshot per run |
| Queues/resources | Host metadata logs plus host-approved same-interval CPU/RSS sampler and guard monitoring; not available from CFFV5 |

The currently installed Playwright default points to a different, absent Chromium
revision (1255 / 159.0.8154.6). Always set `CHROMIUM_PATH` explicitly; do not install
or upgrade browsers between arms. The SHA above identifies the executable, not
the entire browser distribution. Retain the distribution and Playwright install
unchanged through all batches. Shared controls also record module path, Node
version, library path, executable hash, observation settings and approved safety
rules, rejecting changes between batches.

## Observed route and unresolved path evidence

DNS resolved `z170-1.tailddb1d3.ts.net` to `100.71.85.42`. `ip route get` reports:

```text
100.71.85.42 via 192.168.192.1 dev eth0 src 192.168.207.112
```

The visible client leg is CFFV5 WSL `192.168.207.112/20` on `eth0` via the Windows
gateway `192.168.192.1`, then Windows routing toward the Tailscale peer. No
`tailscale` executable or `tailscale0` interface is available in this Linux
environment. DNS suffixes and the destination address do not prove whether the
Windows Tailscale leg is direct or relayed. That status, the underlying WAN/link,
and any Windows-side proxy/VPN route still need observation from the Windows
client/operator. No browser proxy is explicitly configured by the harness; this
does not establish the absence of routing or proxying outside Chromium.

Before each batch, save a timestamped Windows Tailscale status for this peer and
the local route result; repeat after the batch outside timed captures. Use status
observation rather than bulk traffic. Keep the client interface, VPN, proxy and
network attachment unchanged. Record a factual, identical `CAPTURE_CLIENT_PATH`
description for all batches; keep timestamped path observations alongside each
output. Unexpected direct/relay or route changes invalidate comparison until
resolved. **The user's original affected WAN path is unverified.** Do not label
this as that WAN path merely because the destination URL is the same.

## Verification performed

- The readiness validator rejects absent/false deployment acceptance, active
  configuration verification or rollback readiness, missing supervisor commands,
  missing approved safety rules, stale relays and incorrect A/B minima.
- Lock/control tests check overlap prevention and changed-setting rejection.
- The mocked harness test covers A-before/B/A-after: one warmup and three reloads
  each, exact host settings retained per run, no network access.
- A separate disposable Chromium context verified launch, browser version,
  visible selector, CDP Network/Runtime and trace start/drain/close. It stayed at
  `about:blank` with synthetic HTML, DNS disabled and requests blocked. The
  measurement profile was not opened or modified by this smoke check.

No `Singleton*` profile lock files were present during inspection. No Chromium or
Node process was visible in the current PID namespace; this is not proof that
other clients are idle. Recheck immediately before launch and obtain the host's
exclusive-traffic confirmation. Do not open the measurement profile to warm it
until the host gate has passed.

## Ready-record handoff and report

The exact host JSON format, sequential commands and metric definitions are in
[the A/B procedure](rpc-window-ab.md). Ready records must come from z170-1 and
remain private outside Git; this preparation creates no ready record or signal.
The local validator checks the relay's contents, not the host process remotely.
After each batch obtain host confirmation of unchanged configuration throughout
the recorded UTC intervals. On a guard breach stop the batch via the approved
host procedure, preserve partial captures and report rejection; the client has
no authority to change production behavior or thresholds.

Every run must report actual window/guard settings, browser body-delivery and
headers-to-close time, total credit wait plus count, ACK RTT distribution, writer
settlement, full route mounting, outstanding estimated bytes, queue/buffer peaks,
integrity/errors and available CPU/RSS. Retain incomplete attempts. Compare body
completion and route time alongside credit wait so a shifted queue delay is not
mistaken for a gain. Report individual runs and median/range/MAD for each batch;
compare both flanking A batches before considering pooled results. Cancellation
coverage comes from separate validated candidate tests, not successful reloads.

There are currently **zero measured A or B runs**. No durations, medians,
improvements or adoption decision can be reported before host readiness and
completed, correlated captures.
