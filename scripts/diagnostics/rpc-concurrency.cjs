// Private loopback fixtures only; not imported by the production server.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createRpcDiagnostics } = require("./rpc-runtime.cjs");
const { ResourceBudget, limits } = require("./rpc-resource-budget.cjs");
const { flushReady } = require("./rpc-resource.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profiles = [
  {
    name: "atomic-boundary",
    chunks: 8,
    rate: 2097152,
    forward: 20,
    ack: 40,
    chunkSizes: [81920],
  },
  {
    name: "over-clients",
    chunks: 8,
    rate: 2097152,
    forward: 20,
    ack: 40,
    extraClient: true,
  },
  {
    name: "over-streams",
    chunks: 8,
    rate: 2097152,
    forward: 20,
    ack: 40,
    streams: 3,
  },
  {
    name: "mixed-variable",
    chunks: 40,
    rate: 8388608,
    early: 5,
    forward: 130,
    ack: 30,
    chunkSizes: [16384, 65536, 80072, 65536],
  },
  {
    name: "variable",
    chunks: 48,
    rate: 8388608,
    early: 5,
    forward: 130,
    ack: 30,
  },
  { name: "bandwidth", chunks: 12, rate: 262144, forward: 40, ack: 40 },
  {
    name: "slow",
    chunks: 24,
    rate: 2097152,
    forward: 20,
    ack: 40,
    consumer: 100,
  },
  {
    name: "stall",
    chunks: 32,
    rate: 2097152,
    forward: 20,
    ack: 40,
    stallAt: 8,
    stallMs: 2000,
  },
  {
    name: "cancel",
    chunks: 32,
    rate: 2097152,
    forward: 20,
    ack: 40,
    cancelAt: 6,
  },
  {
    name: "disconnect",
    chunks: 32,
    rate: 2097152,
    forward: 20,
    ack: 40,
    disconnectAt: 8,
  },
  {
    name: "peer-stop-probe",
    chunks: 4,
    rate: 2097152,
    forward: 20,
    ack: 40,
    peerFault: true,
  },
  {
    name: "recovery-soak",
    chunks: 24,
    rate: 2097152,
    forward: 40,
    ack: 40,
    waves: 3,
  },
];
function instantiate(code, d) {
  return new Function("__codexRpcDiag", "t", code)(d, (fn) => {
    let done = false;
    return () => {
      if (!done) {
        done = true;
        fn();
      }
    };
  });
}
function resources(browserPid, rendererPids) {
  const records = [];
  for (const e of fs.readdirSync("/proc"))
    if (/^\d+$/.test(e))
      try {
        const stat = fs.readFileSync(`/proc/${e}/stat`, "utf8"),
          tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const rss =
          Number(
            fs
              .readFileSync(`/proc/${e}/status`, "utf8")
              .match(/VmRSS:\s+(\d+)/)[1],
          ) * 1024;
        records.push({ pid: Number(e), parent: Number(tail[1]), rss });
      } catch {}
  const descendants = new Set([browserPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of records)
      if (descendants.has(r.parent) && !descendants.has(r.pid)) {
        descendants.add(r.pid);
        changed = true;
      }
  }
  const chromiumRss = records
    .filter((r) => descendants.has(r.pid))
    .reduce((n, r) => n + r.rss, 0);
  const rendererRss = records
    .filter((r) => rendererPids.includes(r.pid))
    .reduce((n, r) => n + r.rss, 0);
  const m = process.memoryUsage();
  let controllerRss = 0;
  try {
    controllerRss =
      Number(
        fs
          .readFileSync(`/proc/${process.ppid}/status`, "utf8")
          .match(/VmRSS:\s+(\d+)/)[1],
      ) * 1024;
  } catch {}
  return {
    controllerRss,
    hostRss: m.rss,
    hostHeap: m.heapUsed,
    hostExternal: m.external,
    rendererRss,
    chromiumRss,
    totalRss: m.rss + chromiumRss + controllerRss,
  };
}
function kernelTx(connections) {
  const rows = fs
    .readFileSync("/proc/net/tcp", "utf8")
    .trim()
    .split("\n")
    .slice(1);
  let total = 0;
  for (const c of connections.values())
    if (c.ws?._socket) {
      const local = c.ws._socket.localPort,
        remote = c.ws._socket.remotePort;
      const r = rows
        .map((s) => s.trim().split(/\s+/))
        .find(
          (r) =>
            parseInt(r[1].split(":")[1], 16) === local &&
            parseInt(r[2].split(":")[1], 16) === remote,
        );
      if (r) total += parseInt(r[4].split(":")[0], 16);
    }
  return total;
}
async function worker(fixture, mode, config, enabled) {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE),
    { WebSocketServer } = require("ws");
  const cores = JSON.parse(fs.readFileSync(fixture));
  const waveBarriers = new Map();
  const actions = [];
  let kernelMarked = false;
  let progressAt = 0;
  const connections = new Map(),
    producers = new Map(),
    waveMemory = [],
    memory = [];
  let browser,
    timer,
    sampling = false,
    browserPid,
    rendererPids = [],
    pages = [],
    cdps = [],
    stopAt,
    stopReason;
  let extraSocket;
  let maxKernelTx = 0,
    maxWs = 0,
    firstProduced,
    lastConsumed,
    disconnectTriggered = false;
  const start = performance.now();
  const budget = new ResourceBudget({
    enabled,
    onStop(reason) {
      stopAt = performance.now();
      stopReason = reason;
      for (const c of connections.values()) c.ws.terminate();
      for (const barrier of waveBarriers.values())
        for (const resolve of barrier) resolve({ stopped: true });
      waveBarriers.clear();
    },
  });
  const close = (c) => {
    if (c.closed) return;
    c.closed = true;
    c.closedAt = performance.now();
    for (const j of c.jobs.values()) {
      clearTimeout(j.timer);
      j.text = undefined;
    }
    c.jobs.clear();
    c.shape = 0;
    c.rx.length = 0;
    c.reject?.(Error("isolated connection closed"));
    c.resolve = c.reject = undefined;
    budget.close(c.id);
  };
  const d = createRpcDiagnostics("host", true, () => {});
  const host = instantiate(cores[mode], d);
  const states = new Map(),
    stateOwner = new WeakMap();
  let sendingConnection;
  const priorSent = d.sent;
  d.sent = (session, op, stream) => {
    sendingConnection = session.connectionId;
    priorSent(session, op, stream);
  };
  const priorWindow = d.window;
  const rtts = [];
  d.window = (event, state, token) => {
    let entry = stateOwner.get(state);
    if (!entry) {
      assert.ok(
        connections.has(sendingConnection),
        "window must belong to a known connection",
      );
      entry = { id: states.size, connection: sendingConnection, state };
      states.set(entry.id, entry);
      stateOwner.set(state, entry);
    }
    if (!connections.get(entry.connection)?.closed) {
      budget.window(
        entry.connection,
        String(entry.id),
        state.window,
        token.size,
      );
      budget.set(
        "flight",
        entry.connection,
        String(entry.id),
        state.bytesInFlight,
      );
    }
    if (event === "send")
      assert.ok(state.bytesInFlight - token.size < token.windowAtSend);
    else rtts.push(performance.now() - token.sentTime);
    priorWindow(event, state, token);
  };
  const markDrained = (cid) => {
    const c = connections.get(cid);
    if (
      c?.closed &&
      !c.pendingCredit &&
      [...states.values()]
        .filter((s) => s.connection === cid)
        .every((s) => s.state.bytesInFlight === 0)
    )
      c.drainedAt ??= performance.now();
  };
  const oldError = host.Window.prototype.onError;
  host.Window.prototype.onError = function (token) {
    oldError.call(this, token);
    const e = stateOwner.get(this);
    if (e) markDrained(e.connection);
    if (e && !connections.get(e.connection)?.closed)
      budget.set("flight", e.connection, String(e.id), this.bytesInFlight);
  };
  const credit = d.credit;
  let pendingCredit = 0,
    rejectedCredit = 0;
  d.credit = (s) => {
    pendingCredit++;
    const cid = stateOwner.get(s)?.connection,
      c = connections.get(cid);
    if (c) c.pendingCredit = (c.pendingCredit || 0) + 1;
    const end = credit(s);
    return (outcome) => {
      pendingCredit--;
      if (c) c.pendingCredit--;
      if (cid !== undefined) markDrained(cid);
      if (outcome === "rejected") rejectedCredit++;
      end(outcome);
    };
  };
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
  });
  await new Promise((r) => server.once("listening", r));
  server.on("connection", (ws, req) => {
    const cid = new URL(req.url, "http://127.0.0.1").searchParams.get("client");
    const c = {
      id: cid,
      ws,
      rx: [],
      jobs: new Map(),
      shape: 0,
      sequence: 0,
      available: 0,
      writes: 0,
      closed: false,
    };
    connections.set(cid, c);
    ws.on("close", () => close(c));
    ws.on("error", () => close(c));
    if (!budget.admit(cid)) {
      ws.terminate();
      return;
    }
    if (config.extraClient && connections.size === 2)
      setTimeout(() => {
        extraSocket = new (require("ws").WebSocket)(
          `ws://127.0.0.1:${server.address().port}/?client=2`,
        );
        extraSocket.on("error", () => {});
      }, 50);
    ws.on("message", (raw) => {
      if (c.closed) return;
      const m = JSON.parse(String(raw));
      if (c.resolve) {
        const r = c.resolve;
        c.resolve = c.reject = undefined;
        r(m);
      } else c.rx.push(m);
    });
    class Service extends host.Target {
      fetch(id) {
        const key = String(id),
          p = {
            cid,
            key,
            produced: 0,
            consumed: 0,
            canceled: false,
            eof: false,
          };
        producers.set(`${cid}/${key}`, p);
        const count =
          config.disconnectAt && cid === "0" ? 10000 : config.chunks;
        if (!budget.admit(cid, key)) throw Error("isolated admission budget");
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (p.produced === count) {
                  p.eof = true;
                  controller.close();
                  return;
                }
                const size =
                  config.chunkSizes?.[p.produced % config.chunkSizes.length] ||
                  65536;
                if (size > limits.maxDecodedWrite)
                  throw Error("Unknown atomic decoded write");
                if (!budget.reserve("decoded", cid, key, size))
                  throw Error("isolated decoded budget");
                firstProduced ??= performance.now();
                if (config.kernelMarker && !kernelMarked) {
                  kernelMarked = true;
                  fs.writeFileSync(config.kernelMarker, "ready");
                }
                const chunk = new Uint8Array(size);
                for (let i = 0; i < chunk.length; i++)
                  chunk[i] =
                    (Number(cid) * 71 + id * 31 + p.produced * 17 + i * 13) %
                    251;
                p.produced++;
                controller.enqueue(chunk);
              },
              cancel() {
                p.canceled = true;
                p.cancelAt = performance.now();
                budget.set("decoded", cid, key, 0);
                budget.closeStream(cid, key);
              },
            },
            { highWaterMark: 0 },
          ),
        );
      }
    }
    const session = new host.Session(
      {
        encodingLevel: "jsonCompatible",
        send(m) {
          sendingConnection = cid;
          if (c.closed || (budget.tripped && enabled))
            throw Error("isolated stopped transport");
          const text = JSON.stringify(m),
            bytes = Buffer.byteLength(text);
          if (!budget.reserve("transport", cid, "outbound", bytes))
            throw Error("isolated transport budget");
          if (m[0] === "stream" && m[1]?.[2]?.[0] === "write") c.writes++;
          const forward =
            config.early !== undefined && c.writes <= 4
              ? config.early
              : config.forward;
          const now = performance.now();
          c.available =
            Math.max(now, c.available) + (bytes / config.rate) * 1000;
          const id = ++c.sequence,
            job = { text, bytes };
          c.jobs.set(id, job);
          c.shape += bytes;
          job.timer = setTimeout(
            () => {
              if (c.closed) return;
              job.ready = true;
              flushReady(c.jobs, (key, next) => {
                ws.send(next.text, () => {
                  if (c.jobs.delete(key)) {
                    c.shape -= next.bytes;
                    if (!c.closed)
                      budget.release("transport", cid, "outbound", next.bytes);
                  }
                  next.text = undefined;
                });
                maxWs = Math.max(maxWs, ws.bufferedAmount);
                if (!c.closed)
                  budget.set("transport", cid, "socket", ws.bufferedAmount);
              });
            },
            Math.max(0, c.available - now + forward),
          );
        },
        receive() {
          if (c.rx.length) return Promise.resolve(c.rx.shift());
          if (c.closed) return Promise.reject(Error("closed"));
          return new Promise((resolve, reject) => {
            c.resolve = resolve;
            c.reject = reject;
          });
        },
        abort() {
          close(c);
          ws.terminate();
        },
      },
      new Service(),
    );
    session.connectionId = cid;
    c.session = session;
  });
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      const m = resources(browserPid, rendererPids);
      m.rendererHeap = 0;
      for (const cdp of cdps)
        m.rendererHeap += (await cdp.send("Runtime.getHeapUsage")).usedSize;
      for (const key of [
        "controllerRss",
        "hostRss",
        "chromiumRss",
        "rendererRss",
      ])
        if (!(m[key] > 0)) budget.breach("telemetry", key, m[key], 0);
      memory.push(m);
      budget.memory(m);
      maxKernelTx = Math.max(maxKernelTx, kernelTx(connections));
      if (config.progressFile && performance.now() - progressAt > 1000) {
        progressAt = performance.now();
        const progress = {
          ms: progressAt,
          producers: [...producers.values()],
          credit: pendingCredit,
          budget: budget.current(),
          windows: [...states.values()].map((e) => ({
            connection: e.connection,
            window: e.state.window,
            flight: e.state.bytesInFlight,
          })),
          connections: [...connections.values()].map((c) => ({
            id: c.id,
            closed: c.closed,
            rx: c.rx.length,
            shape: c.shape,
            jobs: c.jobs.size,
            socket: c.ws.bufferedAmount,
          })),
        };
        fs.writeFileSync(
          config.progressFile + ".tmp",
          JSON.stringify(progress),
        );
        fs.renameSync(config.progressFile + ".tmp", config.progressFile);
      }
      for (const c of connections.values())
        if (!c.closed) {
          budget.set("transport", c.id, "socket", c.ws.bufferedAmount);
          budget.set(
            "transport",
            c.id,
            "kernel",
            kernelTx(new Map([[c.id, c]])),
          );
        }
    } finally {
      sampling = false;
    }
  }
  const pageResults = [];
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox"],
    });
    const browserCdp = await browser.newBrowserCDPSession();
    for (let client = 0; client < (config.clients || 2); client++) {
      const page = await browser.newPage();
      pages.push(page);
      cdps.push(await page.context().newCDPSession(page));
      await page.exposeFunction("action", (kind, id) => {
        actions.push({ kind, id, cid: String(client), ms: performance.now() });
      });
      await page.exposeFunction("peerBreach", (scope, value, cap) => {
        budget.breach(
          "peerTransport",
          String(client) + "/" + scope,
          value,
          cap,
        );
      });
      await page.exposeFunction("consume", async (id, bytes) => {
        const p = producers.get(`${client}/${id}`);
        if (!p) return;
        p.consumed++;
        p.consumedBytes = (p.consumedBytes || 0) + bytes;
        lastConsumed = performance.now();
        if (!p.canceled && !connections.get(String(client))?.closed)
          budget.release("decoded", String(client), String(id), bytes);
        if (p.consumed === config.chunks)
          budget.closeStream(String(client), String(id));
      });
      await page.exposeFunction("checkpoint", async (tag) => {
        if (tag?.startsWith("wave:") && config.waves > 1 && !budget.tripped) {
          return new Promise((resolve) => {
            const waiting = waveBarriers.get(tag) || [];
            waiting.push(resolve);
            waveBarriers.set(tag, waiting);
            if (waiting.length === pages.length) {
              (async () => {
                global.gc?.();
                for (const cdp of cdps)
                  await cdp.send("HeapProfiler.collectGarbage");
                await sample();
                const snap = {
                  tag,
                  budget: budget.current(),
                  memory: memory.at(-1),
                };
                waveMemory.push(snap);
                waveBarriers.delete(tag);
                for (const done of waiting) done(snap);
              })().catch((error) => {
                for (const done of waiting) done({ error: String(error) });
              });
            }
          });
        }
        await sample();
        return {
          budget: budget.current(),
          producers: [...producers.values()].map((p) => ({ ...p })),
          memory: memory.at(-1),
        };
      });
      await page.evaluate(
        ({ code, factory, instantiate }) => {
          const d = new Function("return (" + factory + ")")()(
              "browser",
              true,
              () => {},
            ),
            counters = { active: 0, peak: 0 };
          const a = d.writeStart,
            b = d.writeEnd;
          d.writeStart = (t, v) => {
            t.bytes = v.byteLength || 0;
            counters.active += t.bytes;
            counters.peak = Math.max(counters.peak, counters.active);
            a(t, v);
          };
          d.writeEnd = (t, f) => {
            if (t.started !== undefined) counters.active -= t.bytes;
            b(t, f);
          };
          globalThis.fixture = {
            api: new Function("return (" + instantiate + ")")()(code, d),
            d,
            counters,
          };
        },
        {
          code: cores.browser,
          factory: createRpcDiagnostics.toString(),
          instantiate: instantiate.toString(),
        },
      );
    }
    const infos = (await browserCdp.send("SystemInfo.getProcessInfo"))
      .processInfo;
    browserPid = infos.find((p) => p.type === "browser").id;
    rendererPids = infos.filter((p) => p.type === "renderer").map((p) => p.id);
    global.gc?.();
    for (const cdp of cdps) await cdp.send("HeapProfiler.collectGarbage");
    await sample();
    timer = setInterval(() => sample().catch(() => {}), 100);
    // Each page is one independent RPC connection; its streams share that socket.
    const run = async (page, client) =>
      page.evaluate(
        async ({ url, config, client, enabled, peerLimits }) => {
          const { api, d, counters } = globalThis.fixture;
          const ws = new WebSocket(url + "?client=" + client),
            channel = new MessageChannel(),
            queue = [],
            timers = new Set();
          let pending,
            closed = false,
            wsPeak = 0,
            ackBytes = 0,
            ackPeak = 0,
            portBytes = 0,
            portPeak = 0;
          const pause = (ms) => new Promise((r) => setTimeout(r, ms));
          const close = () => {
            if (closed) return;
            closed = true;
            for (const job of timers) clearTimeout(job.timer);
            timers.clear();
            ackBytes = 0;
            queue.length = 0;
            pending?.reject(Error("closed"));
            pending = undefined;
          };
          channel.port1.onmessage = (e) => {
            if (closed) return;
            const text = JSON.stringify(e.data),
              size = new TextEncoder().encode(text).byteLength,
              job = { text, size };
            if (ackBytes + size > (config.peerFault ? 1 : peerLimits.reverse)) {
              globalThis.peerBreach(
                "reverse",
                ackBytes + size,
                config.peerFault ? 1 : peerLimits.reverse,
              );
              if (enabled) {
                close();
                ws.close();
                return;
              }
            }
            ackBytes += size;
            ackPeak = Math.max(ackPeak, ackBytes);
            timers.add(job);
            job.timer = setTimeout(() => {
              job.ready = true;
              for (const next of timers) {
                if (!next.ready) break;
                timers.delete(next);
                ackBytes -= next.size;
                if (ws.readyState === 1) {
                  ws.send(next.text);
                  wsPeak = Math.max(wsPeak, ws.bufferedAmount);
                }
              }
            }, config.ack);
          };
          ws.onmessage = (e) => {
            if (closed) return;
            const m = JSON.parse(e.data),
              size = new TextEncoder().encode(e.data).byteLength;
            if (portBytes + size > peerLimits.receive) {
              globalThis.peerBreach(
                "receive",
                portBytes + size,
                peerLimits.receive,
              );
              if (enabled) {
                close();
                ws.close();
                return;
              }
            }
            portBytes += size;
            portPeak = Math.max(portPeak, portBytes);
            channel.port1.postMessage({ m, size });
          };
          channel.port2.onmessage = (e) => {
            portBytes -= e.data.size;
            if (closed) return;
            if (pending) {
              const p = pending;
              pending = undefined;
              p.resolve(e.data.m);
            } else queue.push(e.data.m);
          };
          ws.onclose = close;
          ws.onerror = close;
          await new Promise((r) => (ws.onopen = r));
          const session = new api.Session({
            encodingLevel: "jsonCompatible",
            send(m) {
              if (closed) throw Error("closed");
              channel.port2.postMessage(m);
            },
            receive() {
              if (queue.length) return Promise.resolve(queue.shift());
              if (closed) return Promise.reject(Error("closed"));
              return new Promise(
                (resolve, reject) => (pending = { resolve, reject }),
              );
            },
            abort() {
              close();
              ws.close();
            },
          });
          const outcomes = [],
            snapshots = [],
            waves = [];
          for (let wave = 0; wave < (config.waves || 1) && !closed; wave++) {
            const values = await Promise.all(
              Array.from({ length: config.streams || 2 }, async (_, stream) => {
                const id = wave * (config.streams || 2) + stream;
                let count = 0,
                  bytesRead = 0,
                  ended = false,
                  canceled = false,
                  error = false;
                try {
                  const response = await session.getRemoteMain().fetch(id),
                    reader = response.body.getReader();
                  for (;;) {
                    if (config.stallAt && count === config.stallAt) {
                      const before = await globalThis.checkpoint();
                      await pause(config.stallMs / 2);
                      const mid = await globalThis.checkpoint();
                      await pause(config.stallMs / 2);
                      const after = await globalThis.checkpoint();
                      snapshots.push({ id, before, mid, after });
                    }
                    if (
                      client === 0 &&
                      stream === 0 &&
                      config.cancelAt === count
                    ) {
                      await globalThis.action("cancel", id);
                      await reader.cancel(Error("isolated cancel"));
                      canceled = true;
                      break;
                    }
                    if (
                      client === 0 &&
                      stream === 0 &&
                      config.disconnectAt === count
                    ) {
                      await globalThis.action("disconnect", id);
                      ws.close();
                    }
                    const { done, value } = await reader.read();
                    if (done) {
                      ended = true;
                      break;
                    }
                    if (
                      value.byteLength !==
                        (config.chunkSizes?.[
                          count % config.chunkSizes.length
                        ] || 65536) ||
                      value.some(
                        (v, i) =>
                          v !==
                          (client * 71 + id * 31 + count * 17 + i * 13) % 251,
                      )
                    )
                      throw Error("CORRUPT");
                    count++;
                    bytesRead += value.byteLength;
                    await globalThis.consume(id, value.byteLength);
                    if (config.consumer) await pause(config.consumer);
                  }
                } catch (e) {
                  if (String(e).includes("CORRUPT")) throw e;
                  error = true;
                }
                return { id, count, bytesRead, ended, canceled, error };
              }),
            );
            outcomes.push(...values);
            await pause(config.drainMs ?? 3 * config.ack + 100);
            waves.push(await globalThis.checkpoint("wave:" + wave));
          }
          await pause(config.drainMs ?? 3 * config.ack + 100);
          const final = {
            writerBytes: counters.active,
            portBytes,
            ackBytes,
            rxMessages: queue.length,
          };
          d.close();
          ws.close();
          channel.port1.close();
          channel.port2.close();
          return {
            client,
            outcomes,
            snapshots,
            waves,
            final,
            writerPeak: counters.peak,
            ackPeak,
            wsPeak,
            portPeak,
          };
        },
        {
          url: `ws://127.0.0.1:${server.address().port}`,
          config,
          client,
          enabled,
          peerLimits: limits.peer,
        },
      );
    const values = await Promise.all(pages.map(run));
    pageResults.push(...values);
    extraSocket?.terminate();
    const cleanupStart = performance.now();
    const deadline = cleanupStart + 5000;
    while (
      (pendingCredit ||
        [...connections.values()].some((c) => !c.closed) ||
        [...states.values()].some((s) => s.state.bytesInFlight)) &&
      performance.now() < deadline
    )
      await sleep(20);
    const cleanupMs = performance.now() - cleanupStart;
    assert.equal(pendingCredit, 0);
    assert.ok([...connections.values()].every((c) => c.closed));
    if (enabled && config.extraClient)
      assert.ok(budget.violations.some((v) => v.kind === "clients"));
    if (enabled && config.streams === 3)
      assert.ok(budget.violations.some((v) => v.kind === "streams"));
    assert.ok([...states.values()].every((s) => s.state.bytesInFlight === 0));
    assert.deepEqual(budget.current(), { flight: 0, decoded: 0, transport: 0 });
    for (const p of pageResults) {
      assert.equal(p.final.writerBytes, 0);
      assert.equal(p.final.ackBytes, 0);
    }
    if (!budget.tripped) {
      for (const p of pageResults)
        assert.equal(
          p.outcomes.length,
          (config.streams || 2) * (config.waves || 1),
        );
      for (const p of pageResults)
        for (const o of p.outcomes) {
          if (config.disconnectAt && p.client === 0)
            assert.ok(o.error, "disconnected client must reject");
          else if (config.cancelAt && p.client === 0 && o.id === 0) {
            assert.ok(o.canceled);
            const source = producers.get("0/0");
            assert.ok(source.canceled || source.eof);
          } else {
            assert.ok(o.ended);
            assert.equal(o.count, config.chunks);
          }
        }
      if (config.stallAt)
        for (const p of pageResults)
          for (const snap of p.snapshots) {
            const source = (x) =>
              x.producers.find(
                (s) => s.cid === String(p.client) && s.key === String(snap.id),
              );
            assert.equal(
              source(snap.mid).produced,
              source(snap.after).produced,
              "stalled source must plateau",
            );
          }
    }
    global.gc?.();
    for (const cdp of cdps) await cdp.send("HeapProfiler.collectGarbage");
    await sleep(100);
    await sample();
    const elapsed = lastConsumed - firstProduced;
    return {
      mode,
      config,
      cleanupMs,
      enabled,
      status: budget.tripped ? "budget-stop" : "complete",
      runtime: {
        initial: 262144,
        minimum: host.minimum,
        maximum: host.maximum,
      },
      budget: budget.report(),
      waveMemory,
      windowOwners: [...states.values()].map((s) => s.connection),
      memory: { baseline: memory[0], last: memory.at(-1) },
      maxKernelTx,
      maxWs,
      pendingCredit,
      rejectedCredit,
      actions,
      lifecycle: [...connections.values()].map((c) => ({
        cid: c.id,
        closedAt: c.closedAt,
        drainedAt: c.drainedAt,
      })),
      elapsedMs: elapsed,
      throughputMiBs:
        [...producers.values()].reduce(
          (n, p) => n + (p.consumedBytes || 0),
          0,
        ) /
        1048576 /
        (elapsed / 1000),
      ackP95: rtts.toSorted((a, b) => a - b)[
        Math.max(0, Math.ceil(rtts.length * 0.95) - 1)
      ],
      pages: pageResults,
      producers: [...producers.values()],
      stopReason,
      stopAfterMs: stopAt ? stopAt - start : null,
      sourceHostHash: cores.sourceHostHash,
    };
  } finally {
    clearInterval(timer);
    d.close();
    for (const c of connections.values()) {
      close(c);
      c.ws.terminate();
    }
    await new Promise((r) => server.close(r));
    await browser?.close();
  }
}
function prepare(output) {
  const { patch, target } = require("./rpc-window-candidate.cjs"),
    { instrument } = require("./instrument-rpc.cjs"),
    { extract } = require("./rpc-core.cjs");
  const root = path.resolve(__dirname, "../../scratch/asar"),
    source = fs.readFileSync(path.join(root, target), "utf8");
  const fixture = {
    sourceHostHash: createHash("sha256").update(source).digest("hex"),
    browser: extract(
      instrument(
        fs.readFileSync(
          path.join(root, "webview/assets/app-shared-8bd9d0399038.js"),
          "utf8",
        ),
        "browser",
      ),
      "browser",
    ),
  };
  for (const mode of ["baseline", "512k"])
    fixture[mode] = extract(instrument(patch(source, mode), "host"), "host");
  const file = path.join(output, "cores.json");
  fs.writeFileSync(file, JSON.stringify(fixture));
  return file;
}
async function main() {
  if (!process.env.PLAYWRIGHT_MODULE || !process.env.CHROMIUM_PATH)
    throw Error("Chromium configuration required");
  if (process.argv[2] === "prepare") {
    console.log(prepare(process.argv[3]));
    return;
  }
  if (process.argv[2] === "prepare") {
    console.log(prepare(process.argv[3]));
    return;
  }
  if (process.argv[2] === "worker") {
    console.log(
      JSON.stringify(
        await worker(
          process.argv[3],
          process.argv[4],
          JSON.parse(process.argv[5]),
          process.argv[6] === "stop",
        ),
      ),
    );
    return;
  }
  const output = process.argv[2];
  if (!output || fs.existsSync(output))
    throw Error("Provide new output directory");
  fs.mkdirSync(output, { recursive: true });
  // Do AST preparation in a short-lived process, not in the measured collector.
  const prepared = spawnSync(
    process.execPath,
    ["--max-old-space-size=512", __filename, "prepare", output],
    { encoding: "utf8", env: process.env, timeout: 60000, maxBuffer: 1048576 },
  );
  if (prepared.status !== 0) throw Error(prepared.stderr);
  const fixture = prepared.stdout.trim(),
    rows = [];
  const selected = profiles.filter(
    (p) =>
      !process.env.RPC_CONCURRENCY_PROFILES ||
      process.env.RPC_CONCURRENCY_PROFILES.split(",").includes(p.name),
  );
  for (const config of selected)
    for (const policy of ["observe", "stop"])
      for (
        let repeat = 0;
        repeat < Number(process.env.RPC_CONCURRENCY_REPEATS || 2);
        repeat++
      )
        for (const mode of repeat
          ? ["512k", "baseline"]
          : ["baseline", "512k"]) {
          const result = spawnSync(
            process.execPath,
            [
              "--expose-gc",
              "--max-old-space-size=256",
              __filename,
              "worker",
              fixture,
              mode,
              JSON.stringify(config),
              policy,
            ],
            {
              env: process.env,
              encoding: "utf8",
              timeout: 120000,
              maxBuffer: 16 * 1048576,
            },
          );
          const name = `${config.name}-${policy}-${repeat}-${mode}`;
          fs.writeFileSync(
            path.join(output, name + ".log"),
            result.stderr || "",
          );
          if (result.status !== 0)
            throw Error(name + ": " + result.stderr + " " + result.stdout);
          rows.push({ ...JSON.parse(result.stdout), repeat });
          fs.writeFileSync(
            path.join(output, "results.json"),
            JSON.stringify(rows, null, 2) + "\n",
          );
          console.log(name, rows.at(-1).status);
        }
}
module.exports = { prepare, worker, resources };
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
