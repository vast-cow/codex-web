const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { instrument } = require("./instrument-rpc.cjs");
const { createRpcDiagnostics } = require("./rpc-runtime.cjs");
const hostPath = path.resolve(
  __dirname,
  "../../scratch/asar/.vite/build/startup-requirements-C6B1x9gL.js",
);
const browserPath = path.resolve(
  __dirname,
  "../../scratch/asar/webview/assets/app-shared-8bd9d0399038.js",
);
const { patch } = require("./rpc-window-candidate.cjs");
const mode = process.env.RPC_WINDOW_MODE || "baseline";
const ackDelay = Number(process.env.RPC_TEST_ACK_MS || 0);
const consumerDelay = Number(process.env.RPC_TEST_CONSUMER_MS || 3);
const hostSource = patch(fs.readFileSync(hostPath, "utf8"), mode);
const browserSource = fs.readFileSync(browserPath, "utf8");
const { load } = require("./rpc-core.cjs");
const hostPatched = instrument(hostSource, "host");
const browserPatched = instrument(browserSource, "browser");
function diagnostic(side, records) {
  const d = createRpcDiagnostics(side, true, (record) => records.push(record));
  d.collect = () => d.flush();
  return d;
}
test("bundle edits are repeatable, version guarded, and preserve window algorithm", () => {
  for (const [source, side] of [
    [hostSource, "host"],
    [browserSource, "browser"],
  ]) {
    const patched = instrument(source, side);
    assert.equal(instrument(patched, side), patched);
    assert.throws(
      () => instrument(source.replaceAll("onAck(", "renamedAck("), side),
      /onAck/,
    );
    const original = load(source, side),
      modified = load(patched, side);
    let clock = 100;
    const a = new original.Window(() => clock),
      b = new modified.Window(() => clock);
    for (let i = 0; i < 20; i++) {
      const x = a.onSend(90000),
        y = b.onSend(90000);
      assert.deepEqual(x, y);
      clock += 17 + i;
      assert.equal(a.onAck(x.token), b.onAck(y.token));
      assert.deepEqual({ ...a, now: 0 }, { ...b, now: 0 });
    }
  }
  assert.equal(createRpcDiagnostics("host", false), undefined);
});
async function transfer(enabled, fail = false) {
  const records = [];
  const hd = enabled ? diagnostic("host", records) : undefined;
  const bd = enabled ? diagnostic("browser", records) : undefined;
  const host = load(hostPatched, "host", hd);
  const browser = load(browserPatched, "browser", bd);
  const { WebSocket, WebSocketServer } = require("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const accepted = new Promise((resolve) => server.once("connection", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const socket = await accepted;
  await new Promise((resolve) =>
    client.readyState === WebSocket.OPEN
      ? resolve()
      : client.once("open", resolve),
  );
  const sessions = [];
  function transport(ws) {
    const queue = [];
    let pending;
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (pending) {
        const p = pending;
        pending = undefined;
        p(message);
      } else queue.push(message);
    });
    return {
      encodingLevel: "jsonCompatible",
      send(message) {
        setTimeout(
          () => ws.send(JSON.stringify(message)),
          ws === client ? ackDelay : 0,
        );
      },
      receive() {
        return queue.length
          ? Promise.resolve(queue.shift())
          : new Promise((resolve) => {
              pending = resolve;
            });
      },
      abort() {},
    };
  }
  let reads = 0,
    canceled = false,
    completed;
  const chunks = Array.from({ length: 32 }, (_, i) =>
    new Uint8Array(65536).fill(i),
  );
  const gaps = [];
  class Service extends host.Target {
    fetch() {
      let last;
      const body = new ReadableStream(
        {
          cancel() {
            canceled = true;
          },
          pull(controller) {
            const now = performance.now();
            if (last !== undefined) gaps.push(now - last);
            if (reads === chunks.length) {
              controller.close();
              return;
            }
            controller.enqueue(chunks[reads++]);
            last = performance.now();
          },
        },
        { highWaterMark: 0 },
      );
      // Actual host HTTP-service wrapper's identity TransformStream.
      const pipe = new TransformStream();
      completed = body.pipeTo(pipe.writable).catch(() => {});
      return new Response(pipe.readable);
    }
  }
  const hs = new host.Session(transport(socket), new Service());
  const bs = new browser.Session(transport(client));
  sessions.push(hs, bs);
  try {
    const response = await bs.getRemoteMain().fetch();
    const reader = response.body.getReader();
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.ok(
      reads < chunks.length,
      "browser pause must stop upstream draining",
    );
    if (fail) {
      for (
        let index = 0;
        index < (typeof fail === "number" ? fail : 0);
        index++
      ) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        assert.equal(
          Buffer.compare(Buffer.from(value), Buffer.from(chunks[index])),
          0,
        );
      }
      await reader.cancel(new Error("synthetic cancellation"));
      const cancelDeadline = performance.now() + 2000 + 6 * ackDelay;
      while (
        !canceled &&
        reads !== chunks.length &&
        performance.now() < cancelDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 3 * ackDelay + 80));
      assert.ok(
        canceled || reads === chunks.length,
        "source must cancel or already reach EOF",
      );
      const stoppedAt = reads;
      await new Promise((resolve) => setTimeout(resolve, ackDelay + 30));
      assert.equal(reads, stoppedAt, "no production after cancel settles");
    } else {
      let index = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        assert.equal(
          Buffer.compare(Buffer.from(value), Buffer.from(chunks[index++])),
          0,
        );
        await new Promise((resolve) => setTimeout(resolve, consumerDelay));
      }
      assert.equal(index, chunks.length);
      await completed;
      await hs.drain();
      await bs.drain();
    }
    hd?.collect();
    bd?.collect();
    if (enabled) {
      assert.ok(
        records.some((e) => e.event === "credit-wait-end" && e.durationMs > 10),
      );
      assert.ok(
        records.some(
          (e) =>
            e.side === "browser" &&
            e.event === "writer-end" &&
            e.operationId !== undefined,
        ),
      );
      assert.ok(
        records.some(
          (e) => e.event === "window-send" && e.estimatedBytes === 262404,
        ),
      );
      if (mode === "512k" && !fail)
        assert.ok(
          records.some((e) => e.event === "window-ack" && e.window >= 524288),
        );
      if (!fail) assert.ok(records.some((e) => e.event === "window-ack"));
      else if (canceled)
        assert.ok(
          records.some(
            (e) => e.event === "credit-wait-end" && e.outcome === "rejected",
          ),
        );
      const sends = records.filter(
        (e) => e.side === "host" && e.event === "stream-send",
      );
      if (!fail)
        assert.ok(
          sends.some((e) =>
            records.some(
              (a) =>
                a.side === "browser" &&
                a.event === "ack-send" &&
                a.operationId === e.operationId,
            ),
          ),
        );
      assert.ok(!JSON.stringify(records).includes("synthetic cancellation"));
    }
    if (!fail)
      assert.ok(
        Math.max(...gaps) > 10,
        "credit wait must propagate to source reads",
      );
    return {
      mode,
      ackDelay,
      consumerDelay,
      enabled,
      fail,
      records: records.length,
      maxReadGapMs: Math.max(...gaps),
    };
  } finally {
    // Closing transport avoids any Desktop app lifecycle or production listener.
    client.terminate();
    socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    hd?.close();
    bd?.close();
  }
}
test("actual host/browser RPC cores: slow consumer, unchanged bytes, ACKs, cancellation", async (t) => {
  for (const enabled of [false, true]) {
    t.diagnostic(JSON.stringify(await transfer(enabled)));
    if (enabled)
      for (const point of [true, 8, 28])
        t.diagnostic(JSON.stringify(await transfer(true, point)));
  }
});
test("bounded metadata and host event-loop sampling", async () => {
  const records = [],
    d = diagnostic("host", records);
  try {
    for (let i = 0; i < 3000; i++) d.emit("test", { index: i });
    d.collect();
    assert.equal(records.length, 2049);
    assert.equal(records.at(-1).count, 952);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    d.collect();
    assert.ok(records.some((e) => e.event === "event-loop" && e.maxMs >= 0));
  } finally {
    d.close();
  }
});

test(
  "Chromium: actual browser RPC core over WebSocket and MessagePort",
  { skip: !process.env.PLAYWRIGHT_MODULE, timeout: 20000 },
  async (t) => {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
    const { WebSocketServer } = require("ws");
    const records = [];
    const hd = diagnostic("host", records);
    const host = load(hostPatched, "host", hd);
    let reads = 0;
    class Service extends host.Target {
      fetch() {
        return new Response(
          new ReadableStream(
            {
              pull(c) {
                if (reads === 24) {
                  c.close();
                  return;
                }
                c.enqueue(new Uint8Array(65536).fill(reads++));
              },
            },
            { highWaterMark: 0 },
          ),
        );
      }
    }
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => {
      const queue = [];
      let pending;
      socket.on("message", (data) => {
        const m = JSON.parse(String(data));
        if (pending) {
          const p = pending;
          pending = undefined;
          p(m);
        } else queue.push(m);
      });
      new host.Session(
        {
          encodingLevel: "jsonCompatible",
          send(m) {
            socket.send(JSON.stringify(m));
          },
          receive() {
            return queue.length
              ? Promise.resolve(queue.shift())
              : new Promise((r) => {
                  pending = r;
                });
          },
          abort() {},
        },
        new Service(),
      );
    });
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH,
        args: ["--no-sandbox"],
        headless: true,
      });
      const page = await browser.newPage();
      const cdp = await browser.newBrowserCDPSession();
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const rendererIds = processInfo
        .filter((p) => p.type === "renderer")
        .map((p) => p.id);
      const samples = [];
      const sample = () => {
        const rendererRss = rendererIds.reduce((sum, pid) => {
          try {
            return (
              sum +
              Number(
                fs
                  .readFileSync(`/proc/${pid}/status`, "utf8")
                  .match(/VmRSS:\s+(\d+)/)[1],
              ) *
                1024
            );
          } catch {
            return sum;
          }
        }, 0);
        samples.push({
          host: process.memoryUsage().rss,
          heap: process.memoryUsage().heapUsed,
          rendererRss,
        });
      };
      global.gc?.();
      sample();
      const sampler = setInterval(sample, 20);
      t.after(() => clearInterval(sampler));
      const patched = browserPatched;
      const core = patched.slice(
        patched.indexOf("function JP(e)"),
        patched.indexOf("\nvar X;\nfunction bF()"),
      );
      const result = await page.evaluate(
        async ({ core, factory, url, ackDelay, consumerDelay }) => {
          const records = [];
          const d = new Function("return (" + factory + ")")()(
            "browser",
            true,
            (r) => records.push(r),
          );
          const api = new Function(
            "__codexRpcDiag",
            "t",
            core + ";yF();yF();return {Session:BFt};",
          )(d, (fn) => {
            let initialized = false;
            return () => {
              if (!initialized) {
                initialized = true;
                fn();
              }
            };
          });
          const ws = new WebSocket(url),
            channel = new MessageChannel();
          const queue = [];
          let pending;
          // Same local MessagePort handoff as the browser shim, with JSON on the wire.
          channel.port1.onmessage = (e) =>
            setTimeout(() => ws.send(JSON.stringify(e.data)), ackDelay);
          ws.onmessage = (e) => channel.port1.postMessage(JSON.parse(e.data));
          channel.port2.onmessage = (e) => {
            if (pending) {
              const p = pending;
              pending = undefined;
              p(e.data);
            } else queue.push(e.data);
          };
          await new Promise((r) => (ws.onopen = r));
          const session = new api.Session({
            encodingLevel: "jsonCompatible",
            send(m) {
              channel.port2.postMessage(m);
            },
            receive() {
              return queue.length
                ? Promise.resolve(queue.shift())
                : new Promise((r) => {
                    pending = r;
                  });
            },
            abort() {},
          });
          const response = await session.getRemoteMain().fetch();
          const reader = response.body.getReader();
          const stalled = [];
          for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 100 + ackDelay));
            d.flush();
            stalled.push({
              started: records.filter((r) => r.event === "writer-start").length,
              ended: records.filter((r) => r.event === "writer-end").length,
            });
          }
          let count = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength !== 65536 || value.some((v) => v !== count))
              throw Error("Corrupt stream");
            count++;
            await new Promise((r) => setTimeout(r, consumerDelay));
          }
          await new Promise((r) => setTimeout(r, ackDelay + 30));
          d.close();
          ws.close();
          channel.port1.close();
          channel.port2.close();
          return { count, records, stalled };
        },
        {
          core,
          ackDelay,
          consumerDelay,
          factory: createRpcDiagnostics.toString(),
          url: `ws://127.0.0.1:${server.address().port}`,
        },
      );
      clearInterval(sampler);
      sample();
      global.gc?.();
      const pageCdp = await page.context().newCDPSession(page);
      await pageCdp.send("HeapProfiler.collectGarbage");
      sample();
      hd.collect();
      const resource = Object.fromEntries(
        Object.keys(samples[0]).map((key) => [
          key,
          {
            start: samples[0][key],
            peak: Math.max(...samples.map((s) => s[key])),
            end: samples.at(-1)[key],
          },
        ]),
      );
      assert.equal(result.count, 24);
      assert.deepEqual(
        result.stalled[1],
        result.stalled[2],
        "stalled Chromium writer queue must plateau",
      );
      assert.ok(
        result.stalled[2].started > result.stalled[2].ended,
        "no ACK before writer settlement",
      );
      assert.ok(
        result.records.some(
          (r) => r.event === "writer-end" && r.durationMs > 50,
        ),
      );
      assert.ok(result.records.some((r) => r.event === "ack-send"));
      assert.ok(
        records.some((r) => r.event === "credit-wait-end" && r.durationMs > 50),
      );
      t.diagnostic(
        JSON.stringify({
          mode,
          ackDelay,
          consumerDelay,
          resource,
          stalled: result.stalled,
          maxEstimatedFlight: Math.max(
            ...records
              .filter((r) => r.event === "window-send")
              .map((r) => r.bytesInFlight),
          ),
          browserChunks: result.count,
          hostEvents: records.length,
          browserEvents: result.records.length,
        }),
      );
    } finally {
      await browser?.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise((r) => server.close(r));
      hd.close();
    }
  },
);

test("bootstrap reader gaps are opt-in and retain the real fetch body", async () => {
  const os = require("node:os"),
    http = require("node:http"),
    ts = require("typescript");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-reader-"));
  const oldBootstrap = process.env.CODEX_BOOTSTRAP_DIAGNOSTICS,
    oldRpc = process.env.CODEX_RPC_DIAGNOSTICS;
  const server = http.createServer((req, res) =>
    res.end(Buffer.alloc(200000, 37)),
  );
  const records = [],
    log = console.error;
  try {
    const compiled = ts.transpileModule(
      fs.readFileSync(
        path.resolve(__dirname, "../../src/server/diagnostics/bootstrap.ts"),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    fs.writeFileSync(path.join(dir, "bootstrap.cjs"), compiled);
    process.env.CODEX_BOOTSTRAP_DIAGNOSTICS = "1";
    const { diagnosticFetch } = require(path.join(dir, "bootstrap.cjs"));
    console.error = (line) => records.push(JSON.parse(line));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    for (const enabled of [false, true]) {
      process.env.CODEX_RPC_DIAGNOSTICS = enabled ? "1" : "0";
      records.length = 0;
      const response = await diagnosticFetch(
        `http://127.0.0.1:${server.address().port}/statsig/bootstrap`,
      );
      const reader = response.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        assert.ok(value.every((v) => v === 37));
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(total, 200000);
      const gaps = records.filter((r) => r.event === "upstream-read-gap");
      if (enabled) assert.ok(gaps.some((r) => r.gapMs >= 20));
      else assert.equal(gaps.length, 0);
    }
  } finally {
    console.error = log;
    if (oldBootstrap === undefined)
      delete process.env.CODEX_BOOTSTRAP_DIAGNOSTICS;
    else process.env.CODEX_BOOTSTRAP_DIAGNOSTICS = oldBootstrap;
    if (oldRpc === undefined) delete process.env.CODEX_RPC_DIAGNOSTICS;
    else process.env.CODEX_RPC_DIAGNOSTICS = oldRpc;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installer refuses deployed artifacts and shared files; writes only isolated copies", () => {
  const { apply } = require("./instrument-rpc.cjs"),
    os = require("node:os");
  assert.throws(
    () => apply(path.resolve(__dirname, "../../scratch/asar")),
    /deployed/,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-install-"));
  try {
    const hp = path.join(dir, ".vite/build/startup-requirements-C6B1x9gL.js");
    const bp = path.join(dir, "webview/assets/app-shared-8bd9d0399038.js");
    fs.mkdirSync(path.dirname(hp), { recursive: true });
    fs.mkdirSync(path.dirname(bp), { recursive: true });
    fs.writeFileSync(hp, hostSource);
    fs.writeFileSync(bp, "incompatible Desktop");
    assert.throws(() => apply(dir), /expected/);
    assert.equal(fs.readFileSync(hp, "utf8"), hostSource);
    fs.writeFileSync(bp, browserSource);
    apply(dir);
    assert.ok(
      fs.readFileSync(bp, "utf8").includes("codex-rpc-flow-diagnostics-v1"),
    );
    fs.linkSync(hp, path.join(dir, "hardlink"));
    assert.throws(() => apply(dir), /hard-linked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
