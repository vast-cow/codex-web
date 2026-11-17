const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { patch, verify, build, target } = require("./rpc-window-candidate.cjs");
const { load } = require("./rpc-core.cjs");
const { instrument } = require("./instrument-rpc.cjs");
const source = fs.readFileSync(
  path.resolve(__dirname, "../../scratch/asar", target),
  "utf8",
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("runtime initial/minimum invariant and exact two-write atomic overshoot", () => {
  for (const mode of ["baseline", "512k"]) {
    const output = patch(source, mode),
      r = verify(output);
    assert.equal(r.initial, 262144);
    assert.equal(r.afterFirstAck, 262144); // initial < minimum is intentional, not clamped at construction.
    assert.equal(r.minimum, mode === "512k" ? 524288 : 65536);
    const { Window } = load(output, "host");
    let now = 100;
    const w = new Window(() => now);
    for (let i = 0; i < 100; i++) {
      const a = w.onSend(262404);
      now += i === 0 ? 1 : 180;
      w.onAck(a.token);
    }
    assert.equal(w.window, r.minimum);
    const a = w.onSend(262404);
    assert.equal(a.shouldBlock, mode === "baseline");
    if (mode === "512k") {
      const b = w.onSend(262404);
      assert.equal(b.shouldBlock, true);
      assert.equal(w.bytesInFlight, 524808);
    }
    assert.equal(patch(source), source);
    assert.equal(
      verify(patch(instrument(source, "host"), mode)).minimum,
      r.minimum,
    );
  }
  assert.throws(
    () => patch(source.replace("nt=65536", "nt=65537")),
    /expected|constant|65536|Unknown/,
  );
  assert.throws(
    () => patch(source.replace("window=et", "window=nt")),
    /controller/,
  );
  assert.throws(() => patch(source, "typo"), /mode/);
});
test("candidate builder validates before writing and preserves baseline/browser/sidecars", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-floor-builder-"));
  try {
    const input = path.join(dir, "source");
    fs.mkdirSync(path.join(input, path.dirname(target)), { recursive: true });
    fs.mkdirSync(path.join(input, "webview/assets"), { recursive: true });
    fs.writeFileSync(
      path.join(input, "package.json"),
      JSON.stringify({ version: "26.1007.30912" }),
    );
    fs.writeFileSync(path.join(input, target), source);
    fs.writeFileSync(path.join(input, target + ".gz"), "stale");
    fs.writeFileSync(
      path.join(input, "webview/assets/app-shared-8bd9d0399038.js"),
      "unchanged browser",
    );
    const a = build(input, path.join(dir, "a")),
      b = build(input, path.join(dir, "b"), "512k");
    assert.equal(a.before, a.after);
    assert.notEqual(b.before, b.after);
    assert.equal(a.browser, b.browser);
    assert.equal(
      require("node:zlib")
        .gunzipSync(fs.readFileSync(path.join(dir, "b", target + ".gz")))
        .toString(),
      patch(source, "512k"),
    );
    assert.equal(fs.readFileSync(path.join(input, target), "utf8"), source);
    assert.throws(() => build(input, input), /exist/);
    fs.linkSync(path.join(input, target), path.join(dir, "link"));
    assert.throws(() => build(input, path.join(dir, "bad")), /linked/);
    assert.equal(fs.existsSync(path.join(dir, "bad")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// Use the real writable adapter. A hook promise represents the actual remote
// writer settlement; withholding it must bound producer demand without early ACK.
test("slow/stalled writers: bounded queues, mixed atomic sizes, failure and concurrent streams", async (t) => {
  for (const mode of ["baseline", "512k"]) {
    const api = load(patch(source, mode), "host");
    for (const delay of [0, 10, 50]) {
      let queued = 0,
        peak = 0,
        produced = 0,
        settled = 0,
        estimatedQueued = 0;
      const pending = [];
      global.gc?.();
      const start = process.memoryUsage();
      function stream(stall) {
        const hook = {
          dispose() {},
          stream(op, args) {
            if (op[0] !== "write") {
              args.dispose();
              return { promise: Promise.resolve() };
            }
            const size = [900, 262404, 320547][produced++ % 3];
            queued++;
            estimatedQueued += size;
            peak = Math.max(peak, queued);
            const promise = new Promise((resolve, reject) => {
              const finish = () => {
                queued--;
                estimatedQueued -= size;
                args.dispose();
                settled++;
                resolve();
              };
              if (stall.enabled)
                pending.push((reason) => {
                  queued--;
                  estimatedQueued -= size;
                  args.dispose();
                  reject(reason);
                });
              else setTimeout(finish, delay);
            });
            return { size, promise };
          },
        };
        return api.writable(hook).getWriter();
      }
      const writers = [stream({ enabled: false }), stream({ enabled: false })];
      await Promise.all(
        writers.map(async (w) => {
          for (let i = 0; i < 30; i++) await w.write(new Uint8Array(65536));
          await w.close();
        }),
      );
      await sleep(delay + 10);
      assert.equal(queued, 0);
      assert.equal(settled, 60);
      const control = { enabled: false },
        stalled = stream(control);
      for (let i = 0; i < 4; i++) {
        await stalled.write(new Uint8Array(65536));
        await sleep(delay + 10);
      }
      control.enabled = true;
      let stopped = false;
      const production = (async () => {
        try {
          for (let i = 0; i < 10000; i++)
            await stalled.write(new Uint8Array(65536));
        } catch {
          stopped = true;
        }
      })();
      await sleep(50);
      const plateau = { produced, queued, estimatedQueued };
      assert.ok(queued > 0 && queued <= 4);
      const memory1 = process.memoryUsage();
      await sleep(150);
      assert.deepEqual(
        { produced, queued, estimatedQueued },
        plateau,
        "stalled producer must plateau",
      );
      // Failure of actual remote writes rejects the existing credit promise.
      for (const reject of pending) reject(Error("stalled consumer canceled"));
      pending.length = 0;
      await production;
      assert.ok(stopped);
      assert.equal(queued, 0);
      global.gc?.();
      await sleep(20);
      const end = process.memoryUsage();
      t.diagnostic(
        JSON.stringify({
          mode,
          delay,
          peakQueue: peak,
          stalledQueue: plateau.queued,
          stalledEstimatorBytes: plateau.estimatedQueued,
          rssStart: start.rss,
          rssStall: memory1.rss,
          rssEnd: end.rss,
          heapStall: memory1.heapUsed,
          heapEnd: end.heapUsed,
        }),
      );
    }
  }
});
