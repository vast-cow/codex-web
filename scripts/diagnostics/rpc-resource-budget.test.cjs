const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ResourceBudget, limits } = require("./rpc-resource-budget.cjs");
test("each resource and scope stops independently, reserve rejects before allocation", async () => {
  for (const kind of ["flight", "decoded", "transport"])
    for (const scope of ["item", "connection", "total"]) {
      let stopped = 0;
      const profile = structuredClone(limits);
      profile[kind] = { item: 1000, connection: 2000, total: 4000 };
      profile[kind][scope] = 100;
      const b = new ResourceBudget({
        enabled: true,
        profile,
        onStop() {
          stopped++;
        },
      });
      const conn = scope === "total" ? "b" : "a",
        item = scope === "item" ? "x" : "y";
      if (scope !== "item") assert.ok(b.reserve(kind, "a", "x", 80));
      const before = b.current()[kind];
      assert.equal(b.reserve(kind, conn, item, 101), false);
      assert.equal(b.current()[kind], before);
      await new Promise(queueMicrotask);
      assert.equal(stopped, 1);
      assert.ok(b.violations.some((v) => v.kind === kind));
    }
});
test("default observes only; optional stop latches and new admissions fail; cleanup is reusable", async () => {
  const b = new ResourceBudget();
  assert.ok(b.reserve("decoded", "a", "s", limits.decoded.item + 1));
  assert.equal(b.tripped, false);
  let stopped = 0;
  const e = new ResourceBudget({
    enabled: true,
    onStop() {
      stopped++;
    },
  });
  assert.ok(e.admit("a", "one"));
  assert.ok(e.admit("a", "two"));
  assert.equal(e.admit("a", "three"), false);
  assert.equal(e.admit("b", "one"), false);
  await new Promise(queueMicrotask);
  assert.equal(stopped, 1);
  e.close("a");
  assert.deepEqual(e.current(), { flight: 0, decoded: 0, transport: 0 });
});
test("multi-client sums and memory budgets do not depend on the estimator ratio", async () => {
  const b = new ResourceBudget({ enabled: true });
  b.set("flight", "a", "1", 900);
  b.set("flight", "b", "1", 900);
  assert.equal(b.peaks.flight.total, 1800);
  b.reserve("decoded", "a", "1", 100);
  b.reserve("transport", "b", "queue", 300);
  b.release("decoded", "a", "1", 100);
  assert.throws(() => b.release("decoded", "a", "1", 1), /accounting/);
  b.window("a", "1", limits.window, 262404);
  assert.equal(b.tripped, false);
  b.window("a", "1", limits.window + 1, 262404);
  assert.equal(b.tripped, true);
  for (const key of Object.keys(limits.memory)) {
    const m = new ResourceBudget({ enabled: true });
    m.memory({ [key]: limits.memory[key] + 1 });
    assert.equal(m.tripped, true);
  }
  b.close("a");
  b.close("b");
  assert.deepEqual(b.current(), { flight: 0, decoded: 0, transport: 0 });
});
