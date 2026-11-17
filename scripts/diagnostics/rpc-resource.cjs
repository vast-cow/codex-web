// Isolated measurement only. Never loads Desktop startup or a production endpoint.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createRpcDiagnostics } = require("./rpc-runtime.cjs");
const { extract } = require("./rpc-core.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenarios = [
  { name: "loop-0-0", chunks: 24, ackMs: 0, consumerMs: 0, pauseMs: 300 },
  { name: "loop-40-3", chunks: 24, ackMs: 40, consumerMs: 3, pauseMs: 420 },
  { name: "loop-100-30", chunks: 24, ackMs: 100, consumerMs: 30, pauseMs: 600 },
  {
    name: "wan-stable",
    chunks: 64,
    ackMs: 40,
    forwardMs: 40,
    bytesPerSec: 2097152,
  },
  {
    name: "wan-variable",
    chunks: 64,
    ackMs: 30,
    forwardMs: 130,
    earlyForwardMs: 5,
    earlyWrites: 4,
    bytesPerSec: 8388608,
  },
  {
    name: "bandwidth",
    chunks: 24,
    ackMs: 40,
    forwardMs: 40,
    bytesPerSec: 262144,
  },
  {
    name: "slow",
    chunks: 64,
    ackMs: 40,
    forwardMs: 20,
    bytesPerSec: 2097152,
    consumerMs: 100,
  },
  {
    name: "stall-resume",
    chunks: 64,
    ackMs: 40,
    forwardMs: 20,
    bytesPerSec: 2097152,
    stallAt: 16,
    stallMs: 2000,
  },
  {
    name: "stall-8s",
    chunks: 64,
    ackMs: 40,
    forwardMs: 20,
    bytesPerSec: 2097152,
    stallAt: 16,
    stallMs: 8000,
  },
  {
    name: "disconnect",
    chunks: 10000,
    ackMs: 40,
    forwardMs: 20,
    bytesPerSec: 2097152,
    stallAt: 16,
    stallMs: 2000,
    disconnect: true,
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
function flushReady(jobs, send) {
  for (const [id, job] of jobs) {
    if (job.sent) continue;
    if (!job.ready) break;
    job.sent = true;
    send(id, job);
  }
}
async function worker(fixture, mode, config) {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const { WebSocketServer } = require("ws");
  const cores = JSON.parse(fs.readFileSync(fixture));
  const d = createRpcDiagnostics("host", true, () => {});
  const host = instantiate(cores[mode], d);
  let state,
    lastAt = performance.now(),
    aboveMs = 0,
    aboveStart,
    longestAboveMs = 0;
  const maxima = {
    window: 0,
    estimated: 0,
    atomic: 0,
    overshoot: 0,
    hostWsBuffered: 0,
    shapeBytes: 0,
    shapeMessages: 0,
    receiveBytes: 0,
    logicalDecodedUpperBound: 0,
  };
  let currentEstimated = 0,
    firstProduced,
    lastProduced,
    lastAck,
    produced = 0,
    reportedConsumed = 0,
    lastConsumedAt,
    canceled = false,
    sourceCancelAt,
    hostDisconnectedAt,
    hostDrainedAt;
  function observe() {
    const now = performance.now();
    if (currentEstimated > 1048576) aboveMs += now - lastAt;
    if (currentEstimated <= 1048576 && state?.bytesInFlight > 1048576)
      aboveStart = now;
    if (currentEstimated > 1048576 && state?.bytesInFlight <= 1048576) {
      longestAboveMs = Math.max(longestAboveMs, now - aboveStart);
      aboveStart = undefined;
    }
    lastAt = now;
    currentEstimated = state?.bytesInFlight || 0;
    if (
      hostDisconnectedAt !== undefined &&
      currentEstimated === 0 &&
      creditPending === 0
    )
      hostDrainedAt ??= now;
    maxima.window = Math.max(maxima.window, state?.window || 0);
    maxima.estimated = Math.max(maxima.estimated, currentEstimated);
  }
  const rtts = [];
  const oldWindow = d.window;
  d.window = (event, s, token) => {
    state = s;
    observe();
    if (event === "send") {
      maxima.atomic = Math.max(maxima.atomic, token.size);
      maxima.overshoot = Math.max(
        maxima.overshoot,
        s.bytesInFlight - token.windowAtSend,
      );
      assert.ok(
        s.bytesInFlight - token.size < token.windowAtSend,
        "existing await must gate next send",
      );
      assert.ok(
        s.bytesInFlight < token.windowAtSend + token.size,
        "atomic overshoot bound",
      );
    } else {
      lastAck = performance.now();
      rtts.push(lastAck - token.sentTime);
    }
    oldWindow(event, s, token);
  };
  const oldError = host.Window.prototype.onError;
  host.Window.prototype.onError = function (token) {
    oldError.call(this, token);
    state = this;
    observe();
  };
  const credit = d.credit;
  let creditPending = 0,
    creditRejected = 0;
  d.credit = (s) => {
    creditPending++;
    const end = credit(s);
    return (outcome) => {
      creditPending--;
      if (outcome === "rejected") creditRejected++;
      end(outcome);
    };
  };
  class Service extends host.Target {
    fetch() {
      return new Response(
        new ReadableStream(
          {
            pull(c) {
              if (produced === config.chunks) {
                c.close();
                return;
              }
              firstProduced ??= performance.now();
              lastProduced = performance.now();
              const v = new Uint8Array(65536);
              for (let i = 0; i < v.length; i++)
                v[i] = (produced * 17 + i * 13) % 251;
              produced++;
              c.enqueue(v);
              maxima.logicalDecodedUpperBound = Math.max(
                maxima.logicalDecodedUpperBound,
                (produced - reportedConsumed) * 65536,
              );
            },
            cancel() {
              canceled = true;
              sourceCancelAt = performance.now();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    }
  }
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
  });
  await new Promise((r) => server.once("listening", r));
  let socket, session, pendingReceive, failure;
  const rx = [],
    jobs = new Map();
  let receiveBytes = 0,
    shapeBytes = 0,
    available = 0,
    writes = 0,
    closed = false,
    jobId = 0;
  const snapshots = [];
  function socketSample() {
    maxima.hostWsBuffered = Math.max(
      maxima.hostWsBuffered,
      socket?.bufferedAmount || 0,
    );
  }
  function closeTransport() {
    if (closed) return;
    closed = true;
    hostDisconnectedAt = performance.now();
    failure = Error("isolated disconnected transport");
    for (const job of jobs.values()) {
      clearTimeout(job.timer);
      job.text = undefined;
    }
    jobs.clear();
    shapeBytes = 0;
    rx.length = 0;
    receiveBytes = 0;
    pendingReceive?.reject(failure);
    pendingReceive = undefined;
  }
  server.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const text = String(raw),
        value = JSON.parse(text);
      if (pendingReceive) {
        const p = pendingReceive;
        pendingReceive = undefined;
        p.resolve(value);
      } else {
        rx.push({ value, bytes: Buffer.byteLength(text) });
        receiveBytes += Buffer.byteLength(text);
        maxima.receiveBytes = Math.max(maxima.receiveBytes, receiveBytes);
      }
    });
    ws.on("close", closeTransport);
    ws.on("error", closeTransport);
    session = new host.Session(
      {
        encodingLevel: "jsonCompatible",
        send(m) {
          if (closed) throw failure;
          const text = JSON.stringify(m),
            bytes = Buffer.byteLength(text),
            now = performance.now();
          if (m[0] === "stream" && m[1]?.[2]?.[0] === "write") writes++;
          const forward =
            config.earlyWrites && writes <= config.earlyWrites
              ? config.earlyForwardMs
              : config.forwardMs || 0;
          available =
            Math.max(now, available) +
            (config.bytesPerSec ? (bytes / config.bytesPerSec) * 1000 : 0);
          const job = { text, bytes },
            id = ++jobId;
          jobs.set(id, job);
          shapeBytes += bytes;
          maxima.shapeBytes = Math.max(maxima.shapeBytes, shapeBytes);
          maxima.shapeMessages = Math.max(maxima.shapeMessages, jobs.size);
          job.timer = setTimeout(
            () => {
              if (closed) return;
              job.ready = true;
              flushReady(jobs, (nextId, next) => {
                ws.send(next.text, () => {
                  if (jobs.delete(nextId)) shapeBytes -= next.bytes;
                  next.text = undefined;
                  socketSample();
                });
                socketSample();
              });
            },
            Math.max(0, available - now + forward),
          );
          // Deliberately return undefined: preserve the real serialized-size estimator.
        },
        receive() {
          if (rx.length) {
            const item = rx.shift();
            receiveBytes -= item.bytes;
            return Promise.resolve(item.value);
          }
          if (closed) return Promise.reject(failure);
          return new Promise((resolve, reject) => {
            pendingReceive = { resolve, reject };
          });
        },
        abort() {
          closeTransport();
          ws.terminate();
        },
      },
      new Service(),
    );
  });
  let browser,
    timer,
    pageCdp,
    rendererPids = [];
  const memory = [];
  let sampling = false;
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      observe();
      socketSample();
      const rss = rendererPids.reduce((n, pid) => {
        try {
          return (
            n +
            Number(
              fs
                .readFileSync(`/proc/${pid}/status`, "utf8")
                .match(/VmRSS:\s+(\d+)/)[1],
            ) *
              1024
          );
        } catch {
          return n;
        }
      }, 0);
      const heap = pageCdp
        ? (await pageCdp.send("Runtime.getHeapUsage")).usedSize
        : 0;
      const m = process.memoryUsage();
      memory.push({
        hostRss: m.rss,
        hostHeap: m.heapUsed,
        hostExternal: m.external,
        rendererRss: rss,
        rendererHeap: heap,
      });
    } finally {
      sampling = false;
    }
  }
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: ["--no-sandbox"],
      headless: true,
    });
    const page = await browser.newPage();
    pageCdp = await page.context().newCDPSession(page);
    const browserCdp = await browser.newBrowserCDPSession();
    rendererPids = (
      await browserCdp.send("SystemInfo.getProcessInfo")
    ).processInfo
      .filter((p) => p.type === "renderer")
      .map((p) => p.id);
    await page.exposeFunction("consumed", (n) => {
      reportedConsumed = n;
      lastConsumedAt = performance.now();
    });
    await page.exposeFunction("snapshot", async (tag) => {
      await sample();
      const value = {
        tag,
        produced,
        estimated: state?.bytesInFlight || 0,
        window: state?.window || 0,
        shapeBytes,
        shapeMessages: jobs.size,
        receiveBytes,
        creditPending,
        memory: memory.at(-1),
      };
      snapshots.push(value);
      return value;
    });
    // Compile/init first; keep compilation out of transfer-memory deltas.
    await page.evaluate(
      ({ code, factory, instantiate }) => {
        const counters = { active: 0, peak: 0, starts: 0, ends: 0, failed: 0 };
        const d = new Function("return (" + factory + ")")()(
          "browser",
          true,
          () => {},
        );
        const start = d.writeStart,
          end = d.writeEnd;
        d.writeStart = (t, v) => {
          t.bytes = v.byteLength || 0;
          counters.active += t.bytes;
          counters.peak = Math.max(counters.peak, counters.active);
          counters.starts++;
          start(t, v);
        };
        d.writeEnd = (t, failed) => {
          if (t.started !== undefined) {
            counters.active -= t.bytes;
            counters.ends++;
            if (failed) counters.failed++;
          }
          end(t, failed);
        };
        globalThis.rpcFixture = {
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
    global.gc?.();
    await pageCdp.send("HeapProfiler.collectGarbage");
    await sample();
    timer = setInterval(() => {
      sample().catch(() => {});
    }, 20);
    const result = await page.evaluate(
      async ({ url, config }) => {
        const { api, d, counters } = globalThis.rpcFixture;
        const ws = new WebSocket(url),
          channel = new MessageChannel(),
          queue = [],
          ackJobs = new Set();
        let pending,
          error,
          rxBytes = 0,
          maxRxBytes = 0,
          ackBytes = 0,
          maxAckBytes = 0,
          wsPeak = 0,
          portBytes = 0,
          maxPortBytes = 0,
          ended = false;
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const bytes = (m) =>
          new TextEncoder().encode(JSON.stringify(m)).byteLength;
        const close = () => {
          error = Error("isolated transport closed");
          for (const j of ackJobs) clearTimeout(j.timer);
          ackJobs.clear();
          ackBytes = 0;
          queue.length = 0;
          rxBytes = 0;
          pending?.reject(error);
          pending = undefined;
        };
        channel.port1.onmessage = (e) => {
          const text = JSON.stringify(e.data),
            size = new TextEncoder().encode(text).byteLength;
          ackBytes += size;
          maxAckBytes = Math.max(maxAckBytes, ackBytes);
          const job = { text, size, ready: false };
          ackJobs.add(job);
          job.timer = setTimeout(() => {
            job.ready = true;
            for (const next of ackJobs) {
              if (!next.ready) break;
              ackJobs.delete(next);
              ackBytes -= next.size;
              if (ws.readyState === 1) {
                ws.send(next.text);
                wsPeak = Math.max(wsPeak, ws.bufferedAmount);
              }
            }
          }, config.ackMs || 0);
        };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data),
            size = bytes(m);
          portBytes += size;
          maxPortBytes = Math.max(maxPortBytes, portBytes);
          channel.port1.postMessage({ m, size });
        };
        channel.port2.onmessage = (e) => {
          const { m, size } = e.data;
          portBytes -= size;
          if (pending) {
            const p = pending;
            pending = undefined;
            p.resolve(m);
          } else {
            queue.push({ m, size });
            rxBytes += size;
            maxRxBytes = Math.max(maxRxBytes, rxBytes);
          }
        };
        ws.onclose = close;
        ws.onerror = close;
        await new Promise((r) => (ws.onopen = r));
        const session = new api.Session({
          encodingLevel: "jsonCompatible",
          send(m) {
            if (error) throw error;
            channel.port2.postMessage(m);
          },
          receive() {
            if (queue.length) {
              const q = queue.shift();
              rxBytes -= q.size;
              return Promise.resolve(q.m);
            }
            if (error) return Promise.reject(error);
            return new Promise(
              (resolve, reject) => (pending = { resolve, reject }),
            );
          },
          abort() {
            close();
            ws.close();
          },
        });
        const response = await session.getRemoteMain().fetch(),
          reader = response.body.getReader();
        if (config.pauseMs) await pause(config.pauseMs);
        let count = 0,
          firstRead,
          lastRead,
          disconnectedAt,
          disconnectError = false,
          resumeAt,
          stalledBacklogTarget,
          stalledBacklogDrainMs;
        const stall = [];
        for (;;) {
          if (config.stallAt === count) {
            for (let i = 0; i < 4; i++) {
              await pause(config.stallMs / 4);
              const host = await globalThis.snapshot("stall-" + i);
              stall.push({
                host,
                writerBytes: counters.active,
                starts: counters.starts,
                ends: counters.ends,
                rxBytes,
                portBytes,
                ackBytes,
                wsBuffered: ws.bufferedAmount,
              });
            }
            resumeAt = performance.now();
            stalledBacklogTarget = stall.at(-1).host.produced;
            if (config.disconnect) {
              disconnectedAt = performance.now();
              ws.close();
              try {
                while (!(await reader.read()).done) {}
              } catch {
                disconnectError = true;
              }
              break;
            }
          }
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          firstRead ??= performance.now();
          lastRead = performance.now();
          if (
            value.byteLength !== 65536 ||
            value.some((v, i) => v !== (count * 17 + i * 13) % 251)
          )
            throw Error("Byte/order mismatch");
          count++;
          if (resumeAt !== undefined && count >= stalledBacklogTarget)
            stalledBacklogDrainMs ??= performance.now() - resumeAt;
          await globalThis.consumed(count);
          if (config.consumerMs) await pause(config.consumerMs);
        }
        const completedAt = performance.now();
        if (!config.disconnect) await session.drain();
        await pause(3 * (config.ackMs || 0) + 100);
        const final = {
          writerBytes: counters.active,
          rxBytes,
          portBytes,
          ackBytes,
          wsBuffered: ws.bufferedAmount,
        };
        const metrics = {
          count,
          ended,
          disconnectError,
          disconnectSettleMs: disconnectedAt
            ? completedAt - disconnectedAt
            : null,
          readSpanMs: lastRead - firstRead,
          stalledBacklogDrainMs,
          writerPeakBytes: counters.peak,
          writerFailed: counters.failed,
          maxRxBytes,
          maxPortBytes,
          maxAckBytes,
          wsPeak,
          stall,
          final,
        };
        d.close();
        ws.close();
        channel.port1.close();
        channel.port2.close();
        return metrics;
      },
      { url: `ws://127.0.0.1:${server.address().port}`, config },
    );
    const drainStart = performance.now();
    while (
      (jobs.size || state?.bytesInFlight || creditPending) &&
      performance.now() - drainStart < 5000
    )
      await sleep(10);
    const drainAdditionalWaitMs = performance.now() - drainStart;
    observe();
    await sample();
    const beforeGc = memory.at(-1);
    global.gc?.();
    await pageCdp.send("HeapProfiler.collectGarbage");
    await sleep(100);
    await sample();
    assert.equal(jobs.size, 0);
    assert.equal(state?.bytesInFlight, 0);
    assert.equal(creditPending, 0);
    assert.equal(result.final.writerBytes, 0);
    assert.equal(result.final.rxBytes, 0);
    assert.equal(result.final.ackBytes, 0);
    if (config.disconnect) {
      assert.ok(canceled);
      assert.ok(result.disconnectError);
      assert.ok(creditRejected > 0);
    } else {
      assert.equal(result.count, config.chunks);
      assert.ok(result.ended);
    }
    if (config.stallAt) {
      const a = result.stall[2],
        b = result.stall[3];
      assert.equal(a.host.produced, b.host.produced, "stalled source plateau");
      assert.equal(a.writerBytes, b.writerBytes, "stalled writer plateau");
      assert.ok(b.writerBytes > 0);
      assert.equal(
        b.host.shapeBytes,
        0,
        "transport must finish delivering bounded backlog",
      );
    }
    if (aboveStart !== undefined)
      longestAboveMs = Math.max(longestAboveMs, performance.now() - aboveStart);
    return {
      mode,
      config,
      runtime: {
        initial: new host.Window(() => 1).window,
        minimum: host.minimum,
        maximum: host.maximum,
      },
      maxima,
      ackRtt: {
        count: rtts.length,
        p50Ms: rtts.toSorted((a, b) => a - b)[Math.floor(rtts.length * 0.5)],
        p95Ms: rtts.toSorted((a, b) => a - b)[
          Math.min(rtts.length - 1, Math.ceil(rtts.length * 0.95) - 1)
        ],
      },
      aboveMiB: { totalMs: aboveMs, longestMs: longestAboveMs },
      decodedBytes: result.count * 65536,
      sourceSpanMs: lastProduced - firstProduced,
      bodyDeliveryMs: config.disconnect ? null : lastConsumedAt - firstProduced,
      bodyThroughputMiBs: config.disconnect
        ? null
        : (result.count * 65536) /
          1048576 /
          ((lastConsumedAt - firstProduced) / 1000),
      deliveryThroughputMiBs:
        result.readSpanMs > 0
          ? ((result.count - 1) * 65536) / 1048576 / (result.readSpanMs / 1000)
          : null,
      tailAckDrainMs: config.disconnect ? null : lastAck - lastProduced,
      drainAdditionalWaitMs,
      disconnectHostDrainMs: config.disconnect
        ? hostDrainedAt - hostDisconnectedAt
        : null,
      disconnectSourceCancelMs: config.disconnect
        ? sourceCancelAt - hostDisconnectedAt
        : null,
      canceled,
      creditRejected,
      result,
      memory: {
        baseline: memory[0],
        peak: Object.fromEntries(
          Object.keys(memory[0]).map((k) => [
            k,
            Math.max(...memory.map((m) => m[k])),
          ]),
        ),
        beforeGc,
        afterGc: memory.at(-1),
        samples: memory.length,
      },
      final: {
        estimated: state?.bytesInFlight,
        shapeBytes,
        receiveBytes,
        creditPending,
        hostWsBuffered: socket?.bufferedAmount || 0,
      },
    };
  } finally {
    clearInterval(timer);
    d.close();
    closeTransport();
    socket?.terminate();
    for (const s of server.clients) s.terminate();
    await new Promise((r) => server.close(r));
    await browser?.close();
  }
}
async function main() {
  if (!process.env.PLAYWRIGHT_MODULE || !process.env.CHROMIUM_PATH)
    throw Error("Chromium configuration required");
  if (process.argv[2] === "worker") {
    const result = await worker(
      process.argv[3],
      process.argv[4],
      JSON.parse(process.argv[5]),
    );
    console.log(JSON.stringify(result));
    return;
  }
  const output = process.argv[2];
  if (!output || fs.existsSync(output))
    throw Error("Provide a new output directory");
  fs.mkdirSync(output, { recursive: true });
  const { patch, target } = require("./rpc-window-candidate.cjs");
  const { instrument } = require("./instrument-rpc.cjs");
  const root = path.resolve(__dirname, "../../scratch/asar");
  const source = fs.readFileSync(path.join(root, target), "utf8"),
    browser = fs.readFileSync(
      path.join(root, "webview/assets/app-shared-8bd9d0399038.js"),
      "utf8",
    );
  const fixture = {
    browser: extract(instrument(browser, "browser"), "browser"),
  };
  for (const mode of ["baseline", "512k"])
    fixture[mode] = extract(instrument(patch(source, mode), "host"), "host");
  const fixturePath = path.join(output, "cores.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  const results = [];
  // Two paired replicates, balanced AB/BA, fresh Node and Chromium per case.
  for (const config of scenarios.filter(
    (c) =>
      !process.env.RPC_RESOURCE_SCENARIOS ||
      process.env.RPC_RESOURCE_SCENARIOS.split(",").includes(c.name),
  )) {
    for (
      let repeat = 0;
      repeat < Number(process.env.RPC_RESOURCE_REPEATS || 2);
      repeat++
    ) {
      for (const mode of repeat ? ["512k", "baseline"] : ["baseline", "512k"]) {
        const run = spawnSync(
          process.execPath,
          [
            "--expose-gc",
            __filename,
            "worker",
            fixturePath,
            mode,
            JSON.stringify(config),
          ],
          {
            env: process.env,
            encoding: "utf8",
            timeout: 120000,
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        const name = `${config.name}-${repeat}-${mode}`;
        fs.writeFileSync(path.join(output, name + ".log"), run.stderr || "");
        if (run.status !== 0)
          throw Error(name + ": " + run.stderr + " " + run.stdout);
        const result = JSON.parse(run.stdout);
        result.repeat = repeat;
        results.push(result);
        fs.writeFileSync(
          path.join(output, "results.json"),
          JSON.stringify(
            {
              sourceHostHash: createHash("sha256").update(source).digest("hex"),
              results,
            },
            null,
            2,
          ) + "\n",
        );
        console.log(config.name, repeat, mode, "PASS");
      }
    }
  }
}
module.exports = { flushReady };
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
