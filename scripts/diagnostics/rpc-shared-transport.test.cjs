const assert = require("node:assert/strict");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { SharedWebSocketTransport } = require("./rpc-shared-module.cjs").load();

function endpoints(t, timeout = 1000) {
  const sides = {};
  for (const [side, peer] of [
    ["server", "browser"],
    ["browser", "server"],
  ]) {
    const frames = [],
      received = [],
      failures = [],
      samples = [];
    const transport = new SharedWebSocketTransport(
      side,
      {
        bufferedAmount: () =>
          frames.reduce((sum, frame) => sum + frame.length, 0),
        send: (frame) => frames.push(frame),
        deliver: (message) => received.push(message),
        fail: (error) => failures.push(error),
        change: (sample) => samples.push(sample),
      },
      timeout,
    );
    t.after(() => transport.close());
    sides[side] = {
      transport,
      frames,
      received,
      failures,
      samples,
      step() {
        const frame = frames.shift();
        if (frame) sides[peer].transport.receive(frame);
        return !!frame;
      },
    };
    transport.start();
  }
  const drain = async () => {
    for (let turn = 0; turn < 1000; turn++) {
      if (!sides.server.step() && !sides.browser.step()) {
        await delay(25);
        if (!sides.server.frames.length && !sides.browser.frames.length) return;
      }
    }
    throw Error("Unable to drain the fixture");
  };
  return { ...sides, drain };
}

test("both directions fragment large IPC, preserve FIFO, and share the cap", async (t) => {
  const { server, browser, drain } = endpoints(t);
  const notice = { type: "ipc-main-event", args: ["⇄💡".repeat(250000)] };
  const request = { type: "ipc-renderer-invoke", args: ["🍣".repeat(100000)] };
  const close = { type: "message-port-close", portId: "port" };
  assert.ok(server.transport.send(notice));
  assert.ok(server.transport.send(close));
  assert.ok(browser.transport.send(request));
  await drain();
  assert.deepEqual(browser.received, [notice, close]);
  assert.deepEqual(server.received, [request]);
  assert.deepEqual([...server.failures, ...browser.failures], []);
  for (const [endpoint, limit] of [
    [server, 448 * 1024],
    [browser, 64 * 1024],
  ]) {
    assert.ok(endpoint.samples.some((s) => s.data > 0));
    assert.ok(endpoint.samples.every((s) => s.data <= limit));
    assert.equal(endpoint.samples.at(-1).data, 0);
    assert.equal(endpoint.samples.at(-1).queued, 0);
    assert.equal(endpoint.samples.at(-1).assembly, 0);
  }
});

test("only a void resolution can overtake partially sent FIFO data", async (t) => {
  const { server, browser, drain } = endpoints(t);
  const envelope = (data) => ({
    type: "message-port-message",
    portId: "app",
    data,
  });
  const ordinary = envelope(["resolve", 1, "x".repeat(900000)]);
  const rejection = envelope(["reject", 2, ["error", "failure"]]);
  const ack = envelope(["resolve", 3, ["undefined"]]);
  assert.ok(server.transport.send(ordinary));
  assert.ok(server.transport.send(rejection));
  assert.ok(server.transport.send(ack));
  await drain();
  assert.deepEqual(browser.received, [ack, ordinary, rejection]);
  assert.ok(server.samples.some((s) => s.priority > 0));
  assert.ok(server.samples.every((s) => s.priority <= 8192));
  assert.equal(server.samples.at(-1).priority, 0);
});

test("canceling a parked writer consumes no data and a stalled peer times out independently", async (t) => {
  const slow = endpoints(t, 100);
  const healthy = endpoints(t);
  const signal = new AbortController();
  let writes = 0;
  slow.server.transport.send({ text: "x".repeat(950000) });
  const waiting = slow.server.transport.beforeStreamWrite(
    new Uint8Array(65536),
    signal.signal,
    () => writes++,
  );
  signal.abort(Error("Canceled"));
  await assert.rejects(waiting, /Canceled/);
  healthy.browser.transport.send({ type: "bootstrap-clock-reply" });
  await healthy.drain();
  assert.equal(healthy.server.received.length, 1);
  await delay(160);
  assert.equal(writes, 0);
  assert.match(slow.server.failures[0].message, /deadline/);
  assert.equal(slow.server.samples.at(-1).data, 0);
  assert.equal(slow.server.samples.at(-1).queued, 0);
  assert.equal(slow.server.samples.at(-1).waitingWriters, 0);
  const reconnected = endpoints(t);
  reconnected.server.transport.send({ type: "ipc-renderer-invoke-result" });
  await reconnected.drain();
  assert.equal(reconnected.browser.received.length, 1);
});

test("invalid receipts, synchronous staging overflow and send errors fail visibly", (t) => {
  const first = endpoints(t);
  first.server.transport.receive(Uint8Array.from([4, 0, 0, 0, 1]));
  assert.match(first.server.failures[0].message, /receipt/);
  const second = endpoints(t);
  assert.equal(
    second.server.transport.send({ text: "x".repeat(16 * 1024 * 1024) }),
    false,
  );
  assert.match(second.server.failures[0].message, /limit/);
  const failures = [];
  const samples = [];
  const broken = new SharedWebSocketTransport("server", {
    bufferedAmount: () => 0,
    send: () => {
      throw Error("send failed");
    },
    deliver: () => assert.fail("Unexpected delivery"),
    fail: (error) => failures.push(error),
    change: (sample) => samples.push(sample),
  });
  t.after(() => broken.close());
  broken.start();
  assert.equal(broken.send({ type: "ipc-main-event" }), false);
  broken.close();
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /send failed/);
  assert.equal(samples.at(-1).data, 0);
});

test("a half-open idle connection retires its heartbeat ticket", async (t) => {
  const { server } = endpoints(t, 100);
  await delay(190);
  assert.match(server.failures[0].message, /deadline/);
  assert.ok(server.samples.some((sample) => sample.priority > 0));
  assert.equal(server.samples.at(-1).priority, 0);
});

test("a larger upstream chunk stays bounded and is written as ordered byte slices", async (t) => {
  const { server } = endpoints(t);
  const input = Uint8Array.from({ length: 280000 }, (_, i) => i % 251);
  const sizes = [];
  await server.transport.splitStreamWrite(input, async (part) => {
    const offset = sizes.reduce((sum, size) => sum + size, 0);
    assert.deepEqual(part, input.subarray(offset, offset + part.length));
    sizes.push(part.length);
  });
  assert.deepEqual(sizes, [81920, 81920, 81920, 34240]);
  assert.equal(
    Math.max(...server.samples.map((sample) => sample.writerBytes)),
    input.length,
  );
  assert.equal(server.samples.at(-1).writerBytes, 0);
});
