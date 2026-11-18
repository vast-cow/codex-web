# Bounded RPC transport backpressure

**NO-GO for a controlled live A/B trial.** Continue isolated validation of the
bounded transport design. The experiment is opt-in and runs only against
extracted RPC cores on private loopback endpoints. Production was inspected
read-only. No build, deployment, or restart of the production service was
performed.

This work starts from `b25f4fb` and `1431f24`. In the previous packet-level
variable-latency experiment, B improved aggregate throughput by 55.41%, while the
forward ledger exceeded 512 KiB per connection in both variants and peaked at
786,958 bytes. Both were using the original controller ceiling of 1 GiB.
See [the previous validation](budget-validation.md) and [its per-case data](budget-metrics.csv).

## Where the bytes accumulate

| Stage                                   | Source and behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Existing backpressure                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream body → Desktop RPC writer      | The packaged host `Ke.createPipe` pipes a response body to `ct`. The bootstrap diagnostic fetch wrapper uses reader pulls and a zero high-water mark. Default-stream producers and fetch internals can retain data upstream of that wrapper.                                                                                                                                                                                                                                | `pipeTo` follows the destination writer's promise. That limits active writes through one stream sink. The sink returns before peer completion when there is remaining RPC credit, so a fast source can still issue several writes into the same connection.                                                                                                 |
| RPC encoding and credit                 | In the pinned host bundle `startup-requirements-C6B1x9gL.js`, `M.devaluate` encodes a byte array as a base64 string for `jsonCompatible`. `Ke.sendStream` sends the operation and allocates an implicit import ID. The transport's void return makes it fall back to `We` for estimated size. Then `ct.write` calls `st.onSend` and decides whether to block.                                                                                                               | Per-stream, estimated bytes. The unmodified writer charges after sending and can cross its window by one atomic write. Each stream gets its own controller and the original maximum is 1,073,741,824 estimator bytes. The window estimates rate and ACK RTT, which also includes receiver pacing.                                                           |
| Server bridge                           | The packaged host adapter `wXe.send` in `main-CqEoQDOU.js` calls the bridged port's synchronous `postMessage`. For this route the host port is a shim and forwards directly into the WebSocket envelope. The server makes the JSON string and calls `socket.send`. The diagnostic variant measures `Buffer.byteLength` and observes the callback. Other IPC replies and notifications can send on the same socket through separate paths.                                   | The bridge checks that the socket is open. It does not reserve space or wait for its sender, compression, local writable, or peer. A host port's `pendingMessages` is a separate inbound array used before a listener attaches.                                                                                                                             |
| Node WebSocket and TCP                  | `ws` serializes asynchronous compression per sender, retaining queued inputs and the active input. Its zlib limiter bounds concurrent compression work across sockets. Compressed frames go to the Node socket writable and then the OS TCP path. `ws.bufferedAmount` adds the Node writable length and Sender buffered input bytes.                                                                                                                                        | The Node writable's high-water mark is a signal to the writer. The `ws` send path calls `socket.write` without exposing a stop to the RPC producer. The zlib limiter bounds work concurrency while queued input can grow. TCP flow control throttles network transmission and can shift backlog to userspace. A `ws` callback means local write completion. |
| Browser dispatch → RPC sink             | Browser receives and inflates the WebSocket message, JS parses it, the browser shim posts `message.data` through a real MessagePort, and packaged adapter `VFt` consumes it or pushes it into its receive array. Browser receive events, MessagePort clones and the adapter's `#r` array can each hold messages. RPC decodes into bytes and passes them to a `TransformStream` writer.                                                                                      | The WebSocket and MessagePort callbacks do not wait for downstream capacity. The TransformStream writer does wait for its readable side. Submitted writes can still queue under the sender's RPC credit.                                                                                                                                                    |
| Reverse ACK, cancellation and other IPC | After `deliverStreamWrite` awaits the browser's `writer.write`, the browser sends an RPC `resolve` or `reject` for the operation. The ACK crosses the MessagePort and WebSocket back to the host; `ct` uses `onAck` to return estimated credit and `onError` to retire failed credit. The shim's outbound messages can accumulate during socket open or below `WebSocket.send`. The server can also retain incoming message callbacks while waiting for renderer readiness. | ACKs can be withheld by a slow reader. The server's `ws` receiver applies Node writable high-water backpressure to socket reads, but the async bridge handler and pre-listener arrays have no explicit byte admission. Browser `bufferedAmount` measures sends.                                                                                             |

The bridge, trace sender and browser handoff are in these sources.
[Server port and connection handler](../../src/server/main.ts#L133),
[server compression settings](../../src/server/main.ts#L424),
[bootstrap fetch and sender](../../src/server/diagnostics/bootstrap.ts#L78),
[browser receive and send](../../src/browser/shim.ts#L190),
[RPC extraction and instrumentation](../../scripts/diagnostics/rpc-core.cjs),
[installed ws release source](https://github.com/websockets/ws/tree/8.23.0/lib).

A typical 65,536-byte body chunk in this fixture costs **262,404 estimated RPC
bytes**. `We` charges three bytes per base64 string code unit plus
structural overhead. The byte array becomes an approximately 87.5-kB UTF-8 JSON frame. The
framed compressed payload depends on the data and compression negotiation.
`socket.bytesWritten` counts bytes submitted to the local socket, and sampled
TCP TX queue bytes count outstanding TCP sequence bytes. Live allocations
include the original body buffer, JS strings and objects, decompression and
compression state, MessagePort copies, TCP buffers, process baseline and other
work. They can coexist for one logical frame. A ledger of serialized or framed
bytes and RSS answer different questions.

The previous 786,958-byte figure is a peak from the former ledger. That ledger
kept the shaper's full serialized reservation until its send callback and added
`ws.bufferedAmount` and sampled TCP TX. A frame could appear in more than one
entry during handoff. Its components also show a real kernel backlog. The
experiment below charges each outstanding frame once across the handoffs and
reports `ws` and TCP separately. The difference between the two peaks therefore
has both an admissions effect and an accounting effect.

## Admission and ACK design

Place the check at the RPC byte writer before `ct.write` constructs arguments,
base64 or JSON, before `sendStream` assigns an implicit operation ID, and upstream
of the port's void `postMessage`. This is the earliest common point for the
experiment where connection, chunk shape and size are known together. At most the
current raw chunk per stream can park there. For owned response bodies, a
production implementation can acquire a reservation before reading a bounded
chunk, provided the source can cancel or return its reservation on EOF or error.
Use bounded rechunking for byte streams. An arbitrary RPC value needs a schema
with a safe upper bound or size validation before it enters a bounded sender.

1. Keep the existing per-connection forward budget of **524,288 bytes**.
   Dedicate **491,520 bytes** to stream writes and **32,768 bytes** to forward
   control messages. The two admitted connections bound total reservations at
   **1,048,576 bytes**. Each connection admits at most two active sources.
2. Before admitting a known byte write, reserve the entire atomic frame. For an
   input of `n` bytes reserve base64 length `4 × ceil(n/3)`, 512 bytes for the
   known envelope and IDs, and conservative room for deflate expansion, one
   sync flush and a 10-byte unmasked WebSocket header. Reject an unsupported
   write shape. After serialization, verify the amount against the reservation
   before insertion and return any difference. With `n ≤ 81,920`, the largest
   pre-reservation is **124,176 bytes**. A write which would cross the bulk
   budget waits for a whole frame's capacity. Atomic forward overshoot is
   **zero for admitted fixture frames**. The compression margin follows the
   conservative fixed-block expansion and allows a single flush under this
   fixture's default deflate window and memory settings. [zlib 1.2.11 bound and defaults](https://raw.githubusercontent.com/madler/zlib/v1.2.11/deflate.c).
3. Keep one ordered send queue per connection. Send ready packets in insertion
   order. A transport ticket remains outstanding until both the local send
   callback succeeds and a cumulative, ordered receipt advances through that
   frame. The browser reports the receipt when its RPC adapter takes the frame
   after the MessagePort hop. The fixture stages any excess under the same
   outstanding reservations and checks whether a complete frame fits the
   MessagePort's 256-KiB allowance before posting it.
4. Keep transport admission and RPC credit independent. A writer can proceed
   when both permit a write. Recheck the current RPC window just before
   serializing because an ACK can shrink it while the writer is waiting for
   transport. Return the ticket before waiting again for RPC credit. Only
   the existing RPC ACK settles an operation and updates delivery, RTT and
   estimated credit. The atomic accounting remains valid with a controller
   ceiling of **1,771,040 estimator bytes** and a reserved maximum write of
   **328,192 estimator bytes**, within the approved **2,099,232** flight budget
   per stream. Both variants start at 256 KiB and retain the 64-KiB (A) and
   512-KiB (B) minimums for later adaptations.
5. Keep a place for terminal, error and ACK/control traffic even when bulk is
   full. Control traffic uses the same order and does not overtake already
   committed writes. An unadmitted canceled write has no operation ID.
   Disconnect and failed send go through the RPC connection error path and
   reject parked operations. A receipt deadline closes a nonprogressing
   connection. The fixture uses 15 seconds ordinarily and 500 ms in the
   explicit negative probe. Ordinary slow or stalled body readers continue
   sending transport receipts as the adapter takes messages, then resume
   consumption and RPC ACKs.

A `bufferedAmount` check at `send` would allow upstream RPC objects and strings
to accumulate while waiting, and a send callback alone would let reservations
retire before the kernel, proxy or browser drains. Waiting for an RPC ACK to
release transport space would couple the transport budget to application
consumption and reduce the usable window at high RTT. Pausing inbound socket
reads to manage outbound pressure could block the ACKs and control traffic
needed to make progress.

[Capacity implementation and writer patch](../../scripts/diagnostics/rpc-transport-capacity.cjs),
[Chromium A/B harness](../../scripts/diagnostics/rpc-concurrency.cjs),
[admission and failure tests](../../scripts/diagnostics/rpc-transport-capacity.test.cjs).

## Isolated A/B measurements

The 64 Chromium application cases and 16 Linux packet-level cases used two
balanced AB/BA pairs per profile and policy. Regular cases used two connections
with two concurrent streams each. Sources generated ordered, byte-verified
chunks on demand. The packet tests used a separate network namespace with
loopback MTU 1500 and segmentation offloads disabled. Delay was 25 ms at first
and changed to 100 ms with 20-ms jitter in the variable profile. The bandwidth
profile used 8 Mbit/s. The parent qdisc was verified unchanged and every private
qdisc was empty at teardown. The packet matrix ran under the 2-GiB cgroup with
swap disabled. Its cgroup peak was 715.8 MiB, with zero OOM events.

Throughput is aggregate decoded MiB per second from first production to last
consumption. The RPC wait column is the median of the per-run p95 wait values.
Forward values are maxima across both variants and repeats. Observe rows use
the prior additive accounting. Bounded rows show timely admission
reservations. The CSV includes the simultaneous aggregate, transport wait and
retry counts, memory, TCP observations and failure timings for each case.
[Per-case metrics](transport-backpressure-metrics.csv).

| Profile             | Policy       | A MiB/s | B MiB/s |  B vs A | A/B RPC wait p95 (ms) | Forward peak per connection |
| ------------------- | ------------ | ------: | ------: | ------: | --------------------: | --------------------------: |
| source-error        | bounded-stop |   2.389 |   2.349 |  -1.67% |           147.4/157.6 |                   396,748 B |
| compressed-variable | bounded-stop |   1.580 |   2.539 | +60.67% |           198.8/195.8 |                   396,515 B |
| port-hold           | bounded-stop |   5.552 |   5.535 |  -0.30% |           464.0/464.7 |                   396,974 B |
| atomic-boundary     | bounded-stop |   2.648 |   2.722 |  +2.77% |           164.1/165.9 |                   371,796 B |
| mixed-variable      | bounded-stop |   1.893 |   2.862 | +51.20% |           200.5/193.6 |                   490,153 B |
| variable            | bounded-stop |   1.589 |   2.561 | +61.14% |           197.9/194.0 |                   396,515 B |
| bandwidth           | bounded-stop |   0.371 |   0.371 |  -0.09% |         1002.2/1003.6 |                   396,515 B |
| slow                | bounded-stop |   2.365 |   2.365 |  -0.01% |           150.8/151.1 |                   396,515 B |
| stall               | bounded-stop |   1.694 |   1.708 |  +0.86% |           175.3/178.6 |                   396,699 B |
| cancel              | bounded-stop |   2.268 |   2.259 |  -0.42% |           143.1/167.8 |                   396,699 B |
| disconnect          | bounded-stop |   1.768 |   1.754 |  -0.82% |           148.1/156.8 |                   396,515 B |
| recovery-soak       | bounded-stop |   2.494 |   2.491 |  -0.10% |           179.7/171.8 |                   396,708 B |
| netem-bandwidth     | observe      |   0.622 |   0.622 |  -0.03% |           795.0/769.8 |                   523,022 B |
| netem-bandwidth     | bounded-stop |   0.624 |   0.618 |  -0.88% |           754.8/720.7 |                   396,515 B |
| netem-variable      | observe      |   1.243 |   1.957 | +57.50% |           260.4/254.9 |                   786,928 B |
| netem-variable      | bounded-stop |   1.210 |   1.851 | +53.03% |           256.4/242.0 |                   396,974 B |

The concurrent packet-level variable workload retained a **53.03% B
advantage** within the forward budget. Median bounded B throughput was **5.4%
below** its paired observe-only reference, while the observe-only reference had
a **57.50%** B advantage and exceeded the approved forward budget. The bounded
packet case peaked at **396,974 bytes per connection** and **793,030 bytes total**.
Its independently sampled aggregate TCP TX fell from **1,224,188** to **700,000**
bytes. Median total RPC credit wait across the concurrent streams was
**30.58 s in A** and **20.24 s in B**. The separate capacity gate parked a median
**45 writes in A** and **44 in B**. The longest capacity wait across the bounded
matrix was **286.1 ms**.

The modeled compression run negotiated permessage-deflate, both no-context-takeover
parameters and the server's 1,024-byte threshold configuration. Its 16,799,428
bytes of admitted JSON yielded 273,644 bytes recorded by the server socket,
including WebSocket framing and any close bytes. This fixture's patterned
payload compresses readily. The peak `ws.bufferedAmount` was still 262,470
bytes on that run because the sender can retain uncompressed inputs.

### Limits and failure behavior

| Resource                                             | Maximum observed in bounded cases | Enforced admission limit or sampled threshold |
| ---------------------------------------------------- | --------------------------------: | --------------------------------------------: |
| Forward reservations, per connection                 |                         490,153 B |                      524,288 B before enqueue |
| Forward reservations, aggregate                      |                         979,847 B |       1,048,576 B across two admitted clients |
| Largest atomic pre-reservation / actual frame charge |               124,176 / 123,718 B |     Whole frame reserved before serialization |
| Browser MessagePort, serialized-equivalent payload   |                         175,148 B |                      262,144 B before posting |
| Estimated outstanding credit, per stream             |                       1,836,828 B |        2,099,232 B, including atomic headroom |
| Estimated outstanding credit, aggregate              |                       5,248,080 B |                                   8,396,928 B |
| Decoded retention ledger, aggregate                  |                       1,245,184 B |         2,097,152 B before fixture allocation |
| Group RSS                                            |                      1,472.99 MiB |              1,536 MiB sampled stop threshold |
| Worker RSS / JS heap                                 |                148.63 / 53.17 MiB |          256 / 96 MiB sampled stop thresholds |
| Aggregate renderer JS heap                           |                          4.31 MiB |                128 MiB sampled stop threshold |

The connection and group ledger were checked on every reservation, shrink,
release and close. The exact-boundary test drove 80-KiB chunks into simultaneous
streams. It parked a frame that did not fit, continued to admit control traffic,
and advanced when a previously sent frame had both completion signals. The
browser-side hold also induced actual transport waits, with no more than two
waiters on a connection. The final application cases exercised the credit
recheck when a window contracted between initial eligibility and transport
admission. Atomic overshoot was zero in the transport ledger. RSS is a
sampled process-tree sum that can count shared pages more than once. The
separately measured cgroup peak includes page accounting and answers a
different question.

- All 56 regular bounded cases reached the expected outcome. Two-second
  body stalls produced a stable plateau, resumed to ordered EOF, and briefly
  reached 1,574,424 estimated bytes on one stream. Outstanding credit can still
  exceed 1 MiB under the separate approved estimator budget.
- One-stream cancellation reached the source within 107.85 ms of the
  host-observed trigger, and its sibling and the other client completed.
  Disconnect reached both affected sources within 14.31 ms. Credit drained
  within 4.57 ms of detected socket close. Healthy peers completed. An injected
  upstream source error reached only the affected reader as an error after
  eight chunks.
- With a missing receipt, the 500-ms probe closed the affected transports
  and rejected all reads. The third-client, third-stream and forced reverse
  limit probes stopped at admission or before enqueue. All 16 deliberate
  negative runs retired outstanding reservations and settled the expected
  errors. The transport tests also exercised canceling a parked write and a
  late local write callback after disconnect.
- The three-wave reuse cases returned all ledgers to zero at each barrier.
  After collecting garbage, barrier worker heap ranged from 38.31 to 45.56 MiB
  and renderer heap from 2.20 to 3.23 MiB across all waves and repeats. The
  run demonstrates short recovery under reuse. Long-lived session memory
  and the production proxy path are open validation items.

The pinned core fixture SHA-256 was
`ec5626bb25df0d6cd65b724aec2d876897103457b91fd4ab8e5b64d9c567a918`
in both matrices. Runtime versions were Node 22.23.2, ws 8.23.0 and Chromium
158.0.8127.18. The raw case files are in `/tmp/rpc-capacity-final` and
`/tmp/rpc-capacity-netem-final` on the test host. The regression suite passed
27 tests, including original browser RPC flow and new reservation tests.

## Available launcher and isolated rollback

The loopback listener on TCP 8214 is a Node 22 child of the local
`/tmp/rpc-flow-diag-20261117-01/launcher.cjs`. Its runtime metadata matches the
live child when checked against the process's PID namespace. It loads the
previously staged Desktop diagnostics copy in `normal` mode, with both
diagnostic environment switches unset. The working directory, CLI proxy path
and Unix socket match the launcher manifest. The listener belongs to a shared
session scope with `MemoryMax=infinity`. No matching system or user service
unit was found. The npm and Nix launch entries configure the executable.
[Package launch scripts](../../package.json), [Nix wrapper](../../default.nix).

The launcher polls its mode file every 500 ms. Its normal and diagnostics modes
load the same entrypoint, with different diagnostics environment. It signals
the child and waits for exit on a mode change. It reports readiness from the
listen log before the Desktop import finishes, and leaves a crashed child down
until another mode transition. It has no stop escalation, release hash check,
or automatic baseline recovery. An actual live run needs two versioned releases,
a health check stronger than listen readiness, and a rollback command with a
verified timeout and listener release.

The private rehearsal ran under a transient user systemd service with
`memory.max=2147483648`, `memory.swap.max=0` and `OOMPolicy=stop`. It verified
that the bounded child inherited the cgroup. The owned supervisor stopped and
reaped the baseline child during a stalled transfer, verified the old listener
was gone, and started the bounded release on the same loopback port. It checked
the active release hash, window constants and a 1-MiB ordered body. Injected
child and independent supervisor memory stops were tested, with an active
bounded transfer rejecting on the child watchdog stop. The rehearsal rejected
a modified release, recovered from an owned-child SIGKILL, restored the same
baseline hash and 1-MiB transfer, and checked final listener closure. No normal
stop needed forced escalation. The cgroup peak was **78.0 MiB** for this Node
rehearsal, with zero OOM events. A separate **64-MiB** transient cgroup with
swap disabled killed its own test allocator at a requested 96 MiB and advanced
`memory.events:oom_kill` from 0 to 1. [Private supervisor](../../scripts/diagnostics/rpc-isolated-supervisor.cjs).

## Remaining production integration

The fixture uses a configured, ordered connection and a known byte envelope. For the real bridge, version the receipt protocol on both
ends and scope it to the connection generation. Route every forward producer
on the shared socket through one admission ledger, including notifications,
startup diagnostics, invokes and error text. Profile real envelope bounds and
pre-admit control messages too. Support valid large payloads with safe
application framing before enabling the feature. The fixture caps control
before queue insertion, with serialization already performed on small fixture
messages.

A cooperative consumer receipt protects the end-to-end ledger. Production
should also enforce independent local socket capacity. Validate peer receipt
progress against actually sent sequences, cap inbound frame size, and account
for or bound local kernel send queues and reverse traffic. A peer that claims
receipt of sent bytes early could otherwise recycle end-to-end space while
local network queues retain work. The receipt window is a byte budget over
outstanding logical frames. The existing 32-KiB reverse guard in the fixture
checks its ACK timers and browser API send backlog, while TCP/TLS framing,
retransmission storage and other kernel or proxy allocations belong to their
own budgets. For a trial, give non-RPC traffic bounded, documented headroom
inside the same approved limits.

The app-specific rehearsal still needs the full Desktop bundles, a disposable
test account and profile, a private CLI/app-server and proxy path, service
readiness through editor/body checks, and rollback through the actual launcher.
Use a dedicated cgroup for the full trial process tree. A separate app-server
or same-host proxy must be explicitly included or have its own containment.
Record both RSS/heap and `memory.current`, `memory.peak` and `memory.events`
before granting live approval. Keep baseline artifacts and a healthy baseline
start path outside the candidate release so a kernel kill can be recovered
without restarting the candidate. [Linux cgroup v2 memory controller](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory).

Deployment requires separate explicit authorization after those gates pass.

## Reproduction

The worker reads the extracted bundle sources and writes to new temporary
directories. Set the paths to local Playwright and Chromium installations.

```bash
export PLAYWRIGHT_MODULE=/tmp/astro-generator-browser/node_modules/playwright
export CHROMIUM_PATH=/tmp/codex-browsers/chromium-1254/chrome-linux64/chrome

export RPC_CONCURRENCY_PROFILES=variable,mixed-variable,bandwidth,slow,stall,cancel,disconnect,recovery-soak,atomic-boundary,over-clients,over-streams,peer-stop-probe,compressed-variable,port-hold,receipt-timeout,source-error
RPC_CONCURRENCY_POLICIES=bounded-stop \
  node scripts/diagnostics/rpc-concurrency.cjs /tmp/rpc-transport-matrix-NEW

systemd-run --user --wait --pipe --collect \
  -p MemoryMax=2G -p MemorySwapMax=0 -p OOMPolicy=stop \
  "$(command -v node)" "$PWD/scripts/diagnostics/rpc-isolated-supervisor.cjs" \
  rehearse /tmp/rpc-transport-supervisor-NEW /tmp/rpc-transport-matrix-NEW/cores.json

export RPC_PARENT_NETNS="$(readlink /proc/self/ns/net)"
export RPC_PARENT_QDISC="$(tc -j qdisc show dev lo)"
systemd-run --user --wait --pipe --collect \
  --working-directory="$PWD" -p MemoryMax=2G -p MemorySwapMax=0 -p OOMPolicy=stop \
  --setenv="PLAYWRIGHT_MODULE=$PLAYWRIGHT_MODULE" --setenv="CHROMIUM_PATH=$CHROMIUM_PATH" \
  --setenv="RPC_PARENT_NETNS=$RPC_PARENT_NETNS" --setenv="RPC_PARENT_QDISC=$RPC_PARENT_QDISC" \
  --setenv=RPC_CONCURRENCY_POLICIES=observe,bounded-stop \
  unshare --user --map-root-user --net \
  "$(command -v node)" "$PWD/scripts/diagnostics/rpc-netem.cjs" /tmp/rpc-transport-netem-NEW
```
