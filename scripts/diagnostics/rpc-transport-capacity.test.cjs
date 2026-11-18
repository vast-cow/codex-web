const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TransportCapacity } = require("./rpc-transport-capacity.cjs");
const { limits } = require("./rpc-resource-budget.cjs");

const bulk = ["stream", ["pipeline", 1, ["write"]]];
const control = ["resolve", 2];
const block = new Uint8Array(limits.maxDecodedWrite);
const signal = () => new AbortController().signal;
const create = (fail = assert.fail) =>
  new TransportCapacity({
    change(bytes) {
      assert.ok(bytes >= 0 && bytes <= limits.transport.connection);
    },
    fail,
  });

async function fill(capacity, atom = block) {
  const frames = [];
  for (let i = 0; i < 3; i++) {
    const ticket = await capacity.write(atom, signal(), () =>
      capacity.enqueue(bulk, 4 * Math.ceil(atom.length / 3) + 70),
    );
    assert.ok(capacity.forward(ticket));
    frames.push(ticket);
  }
  return frames;
}

test("a maximum-sized write parks before serialization, and RPC control still fits", async () => {
  const capacity = create();
  const [first, second, third] = await fill(capacity);
  let serialized = false;
  const parked = capacity.write(block, signal(), () => {
    serialized = true;
    return capacity.enqueue(bulk, 4 * Math.ceil(block.length / 3) + 70);
  });
  assert.equal(capacity.waiters.size, 1);
  assert.equal(serialized, false);
  const rpc = capacity.enqueue(control, 200);
  assert.ok(capacity.forward(rpc));
  capacity.receipt(first.sequence);
  await Promise.resolve();
  assert.equal(
    serialized,
    false,
    "receipt alone cannot release socket capacity",
  );
  capacity.written(first);
  const fourth = await parked;
  assert.ok(serialized);
  assert.ok(capacity.forward(fourth));
  for (const ticket of [second, third, rpc, fourth]) capacity.written(ticket);
  capacity.receipt(fourth.sequence);
  assert.equal(capacity.data + capacity.control, 0);
  assert.equal(capacity.pending.size, 0);
});

test("aborting a parked write and retrying RPC credit never enqueue a frame", async () => {
  const capacity = create();
  const frames = await fill(capacity);
  const abort = new AbortController();
  const write = capacity.write(block, abort.signal, assert.fail);
  abort.abort(Error("stream cancelled"));
  await assert.rejects(write, /stream cancelled/);
  assert.equal(capacity.waiters.size, 0);
  assert.equal(capacity.stats.rejected, 1);
  for (const ticket of frames) capacity.written(ticket);
  capacity.receipt(frames.at(-1).sequence);
  assert.equal(await capacity.write(block, signal(), () => false), false);
  assert.equal(capacity.stats.creditRetries, 1);
  assert.equal(capacity.data, 0);
  assert.equal(capacity.pending.size, 0);
});

test("an oversized, unreserved or invalid frame closes the connection before enqueue", async () => {
  const errors = [];
  const fail = (reason) => errors.push(reason.message);
  const mismatch = create(fail);
  await assert.rejects(
    mismatch.write(block, signal(), () => mismatch.enqueue(bulk, 512 * 1024)),
    /exceeds its reservation/,
  );
  assert.equal(mismatch.sent, 0);
  const unavailable = create(fail);
  assert.throws(() => unavailable.enqueue(control, 32 * 1024), /reservation/);
  assert.equal(unavailable.sent, 0);
  const forged = create(fail);
  const ticket = forged.enqueue(control, 10);
  forged.receipt(1);
  assert.equal(forged.forward(ticket), false);
  forged.written(ticket);
  forged.receipt(1);
  assert.equal(forged.pending.size, 0);
  assert.equal(errors.length, 3);
});

test("disconnect rejects queued writes and retires pending receipts", async () => {
  const capacity = create();
  const frames = await fill(capacity);
  const parked = capacity.write(block, signal(), assert.fail);
  capacity.close(Error("disconnected"));
  await assert.rejects(parked, /disconnected/);
  for (const frame of frames) capacity.written(frame, Error("late callback"));
  assert.equal(capacity.waiters.size + capacity.pending.size, 0);
  assert.equal(capacity.data + capacity.control, 0);
});
