# Browser startup investigation

## Evidence from the available capture

The local `npm-run-server-003.txt` contains two slow loads, including a route
mount log reporting 239,017 ms since navigation (not precisely the reported
236.8-second run). For connection `65cc0da0-a206-4c68-84d1-edb1c80b6cee`:

| Boundary | Server observation (UTC) | Interval |
| --- | --- | --- |
| Socket open | 14:01:14.248 | baseline |
| Renderer ready | 14:01:14.249 | 1 ms; measured readiness work 1.58 ms |
| First port registration | 14:03:07.261 | 113.012 s after readiness |
| Routes-mounted message handled | 14:04:44.860 | 97.599 s after port registration |

The two large intervals are observation gaps, not exclusive CPU phases. The
route message itself reports navigation-relative time; it cannot be subtracted
from server wall times. A second connection registered its port 181.748 seconds
after readiness and reported route mount at 279,943 ms. This variability supports
further profiling rather than a fixed-duration explanation.

Confirmed observations:

- Server renderer readiness is fast in these connections.
- The application sends its route marker from a React effect, not when its module
  is downloaded. Root render requested is a separate earlier message.
- The post-login Statsig bootstrap races a request against a 10-second timer.
  A timeout is logged. The existing retry patch already selects fallback after
  the first failed attempt. Timer callbacks may themselves be delayed.
- About 500 bridge invokes have occurred by the first route mount (local bridge
  ID 501 carries the marker). This is volume, not evidence of expensive work.
- The prepared formatted application module is approximately 18 MB. The Vite
  dev log contains many missing source-map warnings. Neither size nor warning
  count measures execution cost.

No CPU bottleneck or startup dependency responsible for the multi-minute delay
has been confirmed. No performance fix is justified by this capture. Statsig,
module transfer/parse/evaluation, repeated initialization, IPC bursts and React
work remain hypotheses. There is no valid before/after speed comparison because
this change adds observation only.

## New measurements

Enable and export diagnostics as described in [diagnostics.md](diagnostics.md).
Reprepare assets to apply `webview-startup-diagnostics.patch`, build, and reload.
The upstream optional hooks are inert when the browser diagnostics hook is absent.
`startup.phase` records navigation-relative `elapsedMs` and these stages:

- `bootstrap-start`: entry initialization function reached.
- `host-services`: host-services initialization entered.
- `react-request`: root component creation requested; not a React commit.
- `routes-mounted`: the existing first-route React effect reached.
- `statsig-start` / `statsig-end`: each bootstrap fetch race, including failure;
  end records its local duration, before payload validation.

`current: false` identifies a repeated stage in the page; repeated Statsig attempts
pair with the latest start. These spans may overlap and must not be added together.
Use Task 1 `rpc.lifecycle` registration/start/settlement records to count bursts
in one-second bins, grouping by page. Use bridge request/queue/port events for
traffic outside the application RPC client. The trace traffic is sampled.

User Timing marks named `codex-web:<stage>` align milestones with Chrome's
Performance timeline. `startup.long-task` records only start and duration from
the browser Long Tasks API, including buffered entries where supported. It omits
attribution URLs and payloads. Existing `browser.event-loop` records provide
supporting evidence of delayed timers. Background throttling also delays timers.
The bounded export may evict early records: preserve console logs for long runs.

## Reproducible Chrome profiling procedure

No Chrome automation tool or installed Chromium executable was available in the
local environment, so an interactive Performance capture was not obtained.

1. Record the revision, upstream asset version, browser version, machine, server
   launch command, dev versus production mode, and whether the tab is foreground.
   Keep the same account, route and network conditions across runs.
2. Enable both loggers at trace, open Chrome DevTools, enable console Preserve log,
   and open Performance. Leave CPU/network throttling disabled for the baseline.
3. Use Performance's record-and-reload control. Stop after the routes-mounted
   marker. Save the performance trace, browser diagnostics export, console log
   and server stderr. Capture Network with Preserve log to distinguish transfer
   from evaluation; do not distribute an unsanitized HAR or trace containing
   account information.
4. In Timings, locate the `codex-web:` marks. Before bootstrap-start, inspect
   Network, Compile Script and Evaluate Script. A gap before module execution
   cannot be measured by a hook inside that module.
5. Between bootstrap, React request and route effect, select each large interval.
   Inspect Main thread flame chart, Bottom-up total/self time and Call tree.
   Record the largest stack, task duration and asset/function location. Compare
   idle time with pending requests and Statsig attempt boundaries.
6. Count repeated marks and RPC registrations per second. Check whether bursts
   precede long tasks or merely arrive while the page is idle. Inspect React
   render/commit stacks in the Performance trace; use React DevTools Profiler
   for a separate run if the production React build supports profiling. The
   route effect alone does not measure total React render time.
7. Repeat at least three foreground loads with cache enabled, then three with
   DevTools Disable cache. Compare medians and ranges for navigation-to-bootstrap,
   bootstrap-to-root-request, root-request-to-route-effect, Statsig attempt spans,
   and long-task total/max. Keep dev and production results separate.
8. Only after identifying a dominant stack or awaited dependency, implement a
   narrow change and repeat the identical runs. Report functional checks and
   phase measurements alongside total startup time.
