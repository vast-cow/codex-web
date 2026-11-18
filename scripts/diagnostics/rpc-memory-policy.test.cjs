const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryPolicy } = require("./rpc-memory-policy.cjs");
const MiB = 1048576;
function feed(policy, end, mib = 1200, ready = true) {
  for (let now = policy.last + 100; now <= end; now += 100) {
    const reason = policy.sample({
      now,
      current: mib * MiB,
      peak: 1400 * MiB,
      ready,
    });
    if (reason) return reason;
  }
}
test("settling requires readiness and an uninterrupted below-threshold interval", () => {
  const p = new MemoryPolicy();
  feed(p, 20000, 1200, false);
  assert.equal(p.state, "startup");
  feed(p, 29000);
  feed(p, 30000, 1300);
  feed(p, 40000);
  assert.equal(p.state, "startup");
  feed(p, 40100);
  assert.equal(p.state, "settled");
});
test("settled grace cannot conceal long or frequent excursions", () => {
  const p = new MemoryPolicy();
  feed(p, 10200);
  assert.equal(feed(p, 15200, 1300), undefined);
  assert.match(feed(p, 15300, 1300), /sustained 5 s/);
  const q = new MemoryPolicy();
  feed(q, 10200);
  for (let cycle = 0; cycle < 3; cycle++) {
    const result = feed(q, q.last + 4000, 1300);
    if (cycle === 2) assert.match(result, /rolling 60 s/);
    else {
      assert.equal(result, undefined);
      feed(q, q.last + 1000);
    }
  }
});
test("absolute peak, readiness loss, observer loss, and events fail immediately", () => {
  for (const overrides of [
    { peak: 1537 * MiB },
    { events: { max: 1 } },
    { failure: "queue stalled" },
    { now: 1100 },
  ]) {
    const p = new MemoryPolicy();
    assert.ok(
      p.sample({
        now: 100,
        current: 1200 * MiB,
        peak: 1400 * MiB,
        ...overrides,
      }),
    );
  }
  const p = new MemoryPolicy();
  feed(p, 10200);
  assert.match(feed(p, 10300, 1200, false), /readiness lost/);
});
test("startup cannot be extended by readiness flapping or low memory", () => {
  const p = new MemoryPolicy();
  assert.match(feed(p, 90200, 1100, false), /deadline 90 s/);
});
test("growth below the settled threshold is still rejected", () => {
  const p = new MemoryPolicy();
  feed(p, 10200, 1000);
  feed(p, 70200, 1000);
  feed(p, 130200, 1040);
  assert.match(feed(p, 190300, 1080), /continuous growth/);
});

test("characterization records lower-gate failures but retains absolute stops", () => {
  const p = new MemoryPolicy(0, true);
  feed(p, 10200);
  assert.equal(feed(p, 20000, 1300), undefined);
  assert.ok(p.violations.has("settled excursion sustained 5 s"));
  assert.equal(p.state, "settled");
  assert.match(
    p.sample({
      now: 20100,
      current: 1540 * MiB,
      peak: 1540 * MiB,
      ready: true,
    }),
    /absolute/,
  );
});

test("characterization still stops continuous growth below the warning line", () => {
  const p = new MemoryPolicy(0, true);
  feed(p, 10200, 1000);
  feed(p, 70200, 1000);
  feed(p, 130200, 1040);
  assert.match(feed(p, 190300, 1080), /continuous growth/);
});

test("an active characterization excursion cannot skip independent growth checks", () => {
  const p = new MemoryPolicy(0, true);
  feed(p, 10200, 1000);
  feed(p, 70200, 1290);
  feed(p, 130200, 1330);
  assert.match(feed(p, 190300, 1370), /continuous growth/);
  assert.ok(p.violations.has("settled excursion sustained 5 s"));
  assert.ok(p.violations.has("settled excursions exceed 10 s in rolling 60 s"));
});
