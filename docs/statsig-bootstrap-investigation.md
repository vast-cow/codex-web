# Statsig bootstrap investigation

## Finding

The 10-second deadline is an explicit application timer, not evidence of a DNS
timeout. The request failure has not been reproduced in an authenticated browser.
No timeout, authentication, transport, or feature evaluation behavior was changed.
An arbitrary shorter deadline would discard potentially valid configuration;
the available evidence does not justify that change.

The prepared application was inspected without editing upstream files. In
`app-initial-6350d04672d0.js`, `rZs` (the minified bootstrap function) races
`_zr` against `iZs = 10000`. `_zr` calls
`safePost('/wham/statsig/bootstrap', { requestBody, retry: false, signal })`.
On expiry it aborts the request and throws a request-failure error. The diagnostic
end marker runs in `finally`, before payload validation or client initialization.
Consequently the reported Statsig span is a bootstrap request span, not the
duration of all Statsig initialization.

The shared API client forwards requests through its bridge transport, whose
pending requests settle on `fetch-response`. The host fetch path includes auth,
workspace routing, device/integrity handling, network I/O and body reading.
`src/server/electron/index.ts` implements `net.fetch` with Node's global fetch.
The deadline alone cannot distinguish those stages or bridge delivery delays.
The existing host `Fetch timing` debug log includes auth, fetch, body-read and
total timings; correlate it with bridge diagnostics before assigning a cause.

## Retry and rendering behavior

`webview-statsig-bootstrap-retry.patch` sets `LQs` to zero. In `SQs`, that disables
request-failure retries, while the separate 401/auth retry allowance (`IQs = 5`)
remains intact. No additional retry patch is needed. Immediate request errors
already reach the existing fallback immediately; there is no minimum wait.

`xQs` uses a mutation to perform bootstrap, returning the existing `_Qs` fallback
on error and withholding its children while pending. On success it validates the
payload, installs it in the Statsig data adapter, and initializes the client.
The fallback is another initialization path, not permission to skip feature
checks. Thus bootstrap can delay routes below this provider, although it does
not block the earlier React root render request. The historical server logs
indeed place the root render request before the bootstrap timeout.

The supplied approximate navigation-relative markers (54 s entry, 62.7 s request
start, 72.7 s request end, 107.4 s routes) leave 34.7 s after the request ends.
They do not establish that removing this wait would advance routes by 10 s.
Other initialization and React scheduling may overlap it. A zero-wait fallback
would still need its own initialization and could produce different evaluations.

## Local observations (2026-11-07)

Node v22.23.2; one sample per condition. No authenticated requests or credentials
were used in these probes. Response payloads were not retained.

| Probe | Observed result |
| --- | --- |
| DNS lookup, `chatgpt.com` | Success, 27 ms |
| DNS lookup, `ab.chatgpt.com` | Success, 22 ms |
| Unauthenticated POST `{}` to `https://chatgpt.com/backend-api/wham/statsig/bootstrap` | HTTP 401, 359 ms |
| Unauthenticated POST `{}` to `https://ab.chatgpt.com/v1/initialize` | HTTP 401, 178 ms |

The bootstrap URL above is a connectivity probe, not verification of the
authenticated account's resolved backend/routing. Both probes used JSON content
type and a 12-second AbortSignal deadline. HTTP_PROXY, HTTPS_PROXY, ALL_PROXY,
NO_PROXY and NODE_USE_ENV_PROXY were unset in this process. This rules out a
general DNS/TLS/connectivity failure in these samples only, not a historical,
browser-specific, account-routing, proxy-service, or authenticated server failure.
The host SDK initialization error in historical logs targets `ab.chatgpt.com`;
it is distinct from the post-login `/wham/statsig/bootstrap` request.

An isolated Node VM executed the exact prepared `rZs` function with stubbed API
and schema dependencies, real timers and AbortController. A valid fixture
resolved in 2 ms; an immediate rejected request propagated a request failure in
0 ms; a pending request aborted and propagated the expected timeout in 10,001 ms.
Fixtures are test inputs only, never application feature responses. This checks
the request race and error classification, not fallback client functionality,
authentication, or application routes. There is no before/after result because
runtime behavior was not changed.

## Remaining validation

No Chromium executable or browser automation connector was available here.
Authenticated reachable/unavailable browser startup and application functionality
remain unverified. No reduction in initialization or route-mount time is claimed.

For the next capture, follow [startup performance](startup-performance.md) and
[diagnostics](diagnostics.md), preserving one request ID through browser send,
server receive/dispatch, host response, and browser response consumption. Collect
host fetch timings when available. A missing completion record alone cannot
prove network delay. Identify the last completed stage, including auth/routing
and response delivery, before changing a timeout.

Compare equivalent authenticated loads with Statsig reachable and with only its
bootstrap request deliberately stalled or rejected in a controlled environment.
Retain auth and all feature checks. Measure request span, fallback initialization,
root render request and routes separately, and exercise ordinary application
actions in both conditions. Only then choose a transport fix or demonstrate that
an earlier existing fallback is safe and actually advances route mounting.
