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

test("third client admission is independently rejected and healthy peers keep distinct ledgers", async () => {
  const b = new ResourceBudget({ enabled: true });
  assert.ok(b.admit("one", "stream"));
  assert.ok(b.admit("two", "stream"));
  b.reserve("decoded", "one", "stream", 65536);
  b.reserve("decoded", "two", "stream", 65536);
  assert.equal(b.peaks.decoded.total, 131072);
  assert.equal(b.admit("three"), false);
  assert.equal(b.clients.size, 2);
  b.close("one");
  assert.equal(b.current().decoded, 65536);
  b.close("two");
  assert.equal(b.current().decoded, 0);
});

test("packet shaping refuses the parent network namespace before creating artifacts", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-no-netem-"));
  try {
    const output = path.join(root, "must-not-exist");
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "rpc-netem.cjs"), output],
      {
        env: {
          ...process.env,
          RPC_PARENT_NETNS: fs.readlinkSync("/proc/self/ns/net"),
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing netem/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nonfinite memory or adaptive targets fail closed instead of looking like zero usage", () => {
  for (const value of [NaN, Infinity, -1]) {
    const memory = new ResourceBudget({ enabled: true });
    memory.memory({ hostRss: value });
    assert.equal(memory.tripped, true);
    assert.equal(memory.violations[0].kind, "telemetry");
    const window = new ResourceBudget({ enabled: true });
    window.window("connection", "stream", value, 262404);
    assert.equal(window.tripped, true);
    assert.equal(window.violations[0].kind, "telemetry");
  }
});
