const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { patch, target } = require("./rpc-window-candidate.cjs");
const { load } = require("./rpc-core.cjs");
const source = fs.readFileSync(
  path.resolve(__dirname, "../../scratch/asar", target),
  "utf8",
);
test("controller flight can exceed 1 MiB in A and B without violating atomic overshoot or the maximum", (t) => {
  for (const mode of ["baseline", "512k"]) {
    const api = load(patch(source, mode), "host");
    let now = 100,
      peak = 0,
      maxWindow = 0;
    const w = new api.Window(() => now);
    for (let round = 0; round < 24; round++) {
      const tokens = [];
      for (let i = 0; i < 8192; i++) {
        const before = w.window;
        const sent = w.onSend(262404);
        tokens.push(sent.token);
        assert.ok(w.bytesInFlight < before + 262404);
        peak = Math.max(peak, w.bytesInFlight);
        if (sent.shouldBlock) break;
      }
      now += 100;
      for (const token of tokens) {
        now += 0.01;
        w.onAck(token);
        maxWindow = Math.max(maxWindow, w.window);
        assert.ok(w.window <= api.maximum);
      }
      assert.equal(w.bytesInFlight, 0);
    }
    assert.ok(peak > 1048576);
    assert.equal(maxWindow, api.maximum);
    // A stopped consumer sends no further ACKs: the controller neither grows nor
    // shrinks with elapsed time alone, including when already above 1 MiB.
    const tokens = [];
    while (true) {
      const sent = w.onSend(262404);
      tokens.push(sent.token);
      if (sent.shouldBlock) break;
    }
    const paused = { window: w.window, flight: w.bytesInFlight };
    now += 3600000;
    assert.deepEqual({ window: w.window, flight: w.bytesInFlight }, paused);
    for (const token of tokens) w.onError(token);
    assert.equal(w.bytesInFlight, 0);
    t.diagnostic(
      JSON.stringify({ mode, maxWindow, peak, pausedFlight: paused.flight }),
    );
  }
});
test("offline A-B-A rollback restores exact source and fresh runtime state", () => {
  const a = patch(source),
    b = patch(source, "512k"),
    a2 = patch(source);
  assert.equal(a, source);
  assert.equal(a2, a);
  assert.notEqual(b, a);
  for (const [text, min] of [
    [a, 65536],
    [b, 524288],
    [a2, 65536],
  ]) {
    const api = load(text, "host"),
      w = new api.Window(() => 1);
    assert.equal(w.window, 262144);
    assert.equal(api.minimum, min);
    assert.equal(w.bytesInFlight, 0);
  }
});

test("shaper never sends close or another frame ahead of an earlier write", () => {
  const { flushReady } = require("./rpc-resource.cjs");
  const jobs = new Map([
    [1, { text: "write", ready: false }],
    [2, { text: "close", ready: true }],
  ]);
  const sent = [];
  const send = (id, job) => sent.push(job.text);
  flushReady(jobs, send);
  assert.deepEqual(sent, []);
  jobs.get(1).ready = true;
  flushReady(jobs, send);
  assert.deepEqual(sent, ["write", "close"]);
  flushReady(jobs, send);
  assert.equal(sent.length, 2);
});
