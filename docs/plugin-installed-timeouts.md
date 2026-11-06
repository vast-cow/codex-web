# Installed plugin timeout investigation

The available evidence does not establish the cause of the delay. No runtime fix
is justified yet. Plugin discovery and the 30-second timeout remain unchanged.

## Capture evidence

The local, untracked `npm-run-server-002.txt` contains the reported pair:

| Request ID | Routing duration | Queue wait | Subsequent observations |
| --- | --- | --- | --- |
| `0c3c9f23-a4e1-462b-b346-956aa02930be` | 31 ms | 0 ms | 30-second timeout, then missing Promise |
| `321d9947-3e42-4ad2-9284-89748188bdbf` | 7 ms | 1 ms | 30-second timeout, then missing Promise |

Routing appears at lines 1417 and 1441, timeouts at 1457 and 1488, and missing
Promise warnings at 1513 and 1519. Both routing records report
`originWebcontentsId=3001`, `hadPending=true`, `targetDestroyed=false`, and
`broadcastFallback=false`. These are routing observations, not browser receipts.
The upstream lines have no timestamps; surrounding structured records cannot
establish their precise timing. The browser development log contains no matching
request lifecycle capture. There are no correlated Task 1 write-completion,
browser-receive, or event-loop records for these requests.

Consequently, the actual server write time, browser receipt time, main-thread
state, and application response-dispatch delay remain unknown. Missing-target
warnings elsewhere in the capture do not demonstrate failure of these replies.

## Source inspection

In the prepared `app-shared-8bd9d0399038.js` request client, `sendRequest`
registers the Promise synchronously before queue dispatch. `startRequest` starts
the timer. For these read requests, `onTimeout` deletes the map entry, clears the
timer, releases capacity, rejects, and emits `timed-out`. `onResult` also deletes
and clears before resolving; an absent entry logs the reported warning without
resolving another request. This explains the warning after timeout, not the
original delay. Inspecting these paths does not validate every cancellation path.

The server associates each socket with its own renderer window; close removes
the association and destroys that window. Replies look up the target webContents
ID. Browser reconnect clears bridge requests, queues and ports, then reloads
after opening a new connection. These mechanisms provide no positive evidence
of stale renderer routing in the reported pair; a live lifecycle trace is still
needed to exclude lifecycle races.

The installed-inventory query (`XZr` in this prepared version) issues
`plugin/installed` with background priority, no retry, and zero stale time.
The enclosing installed query (`W2`) uses a one-minute local stale time and can
also serve UI consumers. Automatic initialization could contribute load, but
query configuration alone does not measure its contribution.

## Next reproduction and controlled experiment

Use [Task 1 diagnostics](diagnostics.md#application-rpc-lifecycle-tracing) and
the [startup profiling procedure](startup-performance.md). Keep full console logs
alongside the bounded export. Join application `rpcId` with connection, page,
renderer, and server identities; bridge request IDs are a separate namespace.
For each failed request, compare registration/start, server route/write callback,
browser receipt, and result lookup. Record long tasks and timer lateness in the
same foreground browser run. A successful write callback is not a peer receipt.

For a temporary development experiment, locate the automatic consumer of `W2`
using the Performance trace before adding a flag. Gate only that consumer's
query enablement behind a development-only flag; keep the explicit plugin UI
query enabled. Do not intercept all `sendRequest` calls or fabricate an empty
plugin inventory. Confirm the flag is inactive in production and remove the
temporary patch after collecting results.

Alternate at least three baseline and three flagged foreground loads with the
same cache, account, roots, route and build. Compare navigation-to-routes-mounted
median/range, application registrations per second and total bridge volume, and
timeouts divided by dispatched plugin requests. Separately open the plugin UI
and confirm retrieval in each mode. Sampling prevents exact transport counts
from trace logs alone; use the Network capture for those counts. A mode with no
automatic plugin requests has no automatic-request timeout rate to compare.

No browser automation tool or Chrome/Chromium executable was available during
this investigation. The experiment was not run, no flag was installed, and no
before/after measurements are available. Successful live plugin retrieval and
cancellation/reconnection behavior remain manual checks. Existing diagnostics
tests cover isolated result settlement, timeout cleanup, duplicate late results,
connection identity, and bridge disconnect/reload; they do not reproduce this
timeout. Add a regression test for the actual cause once it is established.
