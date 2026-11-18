// Private transport experiment for the fixture's byte-stream RPC shape.
const { limits } = require("./rpc-resource-budget.cjs");
const controlReserve = 32 * 1024;
const envelopeSlack = 512;
const frameOverhead = 10; // One unmasked, final server WebSocket frame.
const charge = (jsonBytes) =>
  // Fixed-block deflate bound plus headroom for a single sync flush.
  jsonBytes +
  Math.ceil(jsonBytes / 8) +
  Math.ceil(jsonBytes / 256) +
  Math.ceil(jsonBytes / 512) +
  64 +
  frameOverhead;

class TransportCapacity {
  constructor({ change, fail, timeoutMs = 15000 }) {
    this.change = change;
    this.fail = fail;
    this.timeoutMs = timeoutMs;
    this.data = 0;
    this.control = 0;
    this.waiters = new Set();
    this.pending = new Map();
    this.sent = 0;
    this.forwarded = 0;
    this.received = 0;
    this.stats = {
      admitted: 0,
      waits: 0,
      rejected: 0,
      creditRetries: 0,
      waitMs: 0,
      maxWaitMs: 0,
      waiterPeak: 0,
      peak: 0,
      maxAtomic: 0,
      maxReservation: 0,
      jsonBytes: 0,
    };
  }
  publish() {
    const bytes = this.data + this.control;
    this.stats.peak = Math.max(this.stats.peak, bytes);
    this.change(bytes);
  }
  async write(value, signal, send) {
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > limits.maxDecodedWrite
    )
      throw Error("Unsupported atomic transport write");
    const bytes = charge(4 * Math.ceil(value.byteLength / 3) + envelopeSlack);
    this.stats.maxReservation = Math.max(this.stats.maxReservation, bytes);
    const ticket = await this.reserve(bytes, signal);
    try {
      if (this.error || signal.aborted) throw this.error || signal.reason;
      this.active = ticket;
      const result = send();
      if (result === false) this.stats.creditRetries++;
      return result;
    } finally {
      this.active = undefined;
      if (!ticket.sequence) this.release(ticket);
    }
  }
  reserve(bytes, signal) {
    return new Promise((resolve, reject) => {
      if (this.error || signal.aborted) {
        reject(this.error || signal.reason);
        return;
      }
      const started = performance.now();
      const finish = (failed = false) => {
        signal.removeEventListener("abort", abort);
        this.waiters.delete(waiter);
        if (waiter.waited) {
          const ms = performance.now() - started;
          this.stats.waitMs += ms;
          this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, ms);
          if (failed) this.stats.rejected++;
        }
      };
      const abort = () => {
        finish(true);
        reject(signal.reason);
        this.pump();
      };
      const waiter = {
        bytes,
        admit: () => {
          finish();
          this.data += bytes;
          this.stats.admitted++;
          this.publish();
          resolve({ bytes, bulk: true });
        },
        reject: (error) => {
          finish(true);
          reject(error);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.add(waiter);
      this.pump();
      if (this.waiters.has(waiter)) {
        waiter.waited = true;
        this.stats.waits++;
        this.stats.waiterPeak = Math.max(
          this.stats.waiterPeak,
          this.waiters.size,
        );
      }
    });
  }
  pump() {
    if (this.error) return;
    for (const waiter of this.waiters) {
      if (
        this.data + waiter.bytes >
        limits.transport.connection - controlReserve
      )
        break;
      waiter.admit();
    }
  }
  enqueue(message, jsonBytes) {
    if (this.error) throw this.error;
    const bytes = charge(jsonBytes);
    const bulk = message[0] === "stream" && message[1]?.[2]?.[0] === "write";
    const ticket = bulk ? this.active : { bytes, bulk: false };
    if (
      (bulk && (!ticket || ticket.sequence || bytes > ticket.bytes)) ||
      (!bulk && this.control + bytes > controlReserve)
    ) {
      const error = Error("Transport frame exceeds its reservation");
      this.stop(error);
      throw error;
    }
    if (bulk) {
      this.data -= ticket.bytes - bytes;
      ticket.bytes = bytes;
    } else this.control += bytes;
    ticket.sequence = ++this.sent;
    this.pending.set(ticket.sequence, ticket);
    this.stats.maxAtomic = Math.max(this.stats.maxAtomic, bytes);
    this.stats.jsonBytes += jsonBytes;
    this.publish();
    this.pump();
    ticket.timer = setTimeout(
      () => this.stop(Error("Transport receipt deadline exceeded")),
      this.timeoutMs,
    ).unref();
    return ticket;
  }
  forward(ticket) {
    if (this.error) return false;
    if (ticket.sequence !== ++this.forwarded) {
      this.stop(Error("Transport send order violation"));
      return false;
    }
    return true;
  }
  receipt(sequence) {
    if (this.error) return;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= this.received ||
      sequence > this.forwarded
    ) {
      this.stop(Error("Invalid transport receipt"));
      return;
    }
    for (let i = this.received + 1; i <= sequence; i++) {
      const ticket = this.pending.get(i);
      ticket.received = true;
      this.finish(ticket);
    }
    this.received = sequence;
  }
  written(ticket, error) {
    if (this.error) return;
    if (error) return this.stop(error);
    ticket.written = true;
    this.finish(ticket);
  }
  finish(ticket) {
    if (!ticket.written || !ticket.received) return;
    clearTimeout(ticket.timer);
    this.pending.delete(ticket.sequence);
    this.release(ticket);
  }
  release(ticket) {
    if (this.error) return;
    if (ticket.bulk) this.data -= ticket.bytes;
    else this.control -= ticket.bytes;
    this.publish();
    this.pump();
  }
  close(error) {
    if (this.error) return;
    this.error = error;
    for (const ticket of this.pending.values()) clearTimeout(ticket.timer);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.data = this.control = 0;
    this.publish();
  }
  stop(error) {
    if (this.error) return;
    this.close(error);
    this.fail(error);
  }
}

// Patch only an extracted, version-pinned fixture core. The synchronous send
// still allocates its original operation ID and starts its original RPC credit.
function patchTransportWriter(core) {
  const creditWait =
    "new Promise((e,t)=>{if(__codexRpcDiag){const end=__codexRpcDiag.credit(r);i=()=>{end('released');e()};a=reason=>{end('rejected');t(reason)}}else{i=e;a=t}})";
  const edits = [
    [
      "function ct(e){let t,",
      "function ct(e){const transport=e.entry?.session.transport, transportAbort=new AbortController();let t,",
    ],
    [creditWait, "waitForCredit()"],
    [
      "return new WritableStream({write(n,s){",
      `const waitForCredit=()=>${creditWait};
        async function gated(value, streamSignal, send) {
          const signal = AbortSignal.any([streamSignal, transportAbort.signal]);
          for (;;) {
            if (t !== void 0) throw t;
            if (signal.aborted) throw signal.reason;
            if (r.bytesInFlight >= r.window) {
              await waitForCredit();
            } else {
              // The window can shrink while the transport ticket is pending.
              // Returning false releases the ticket before retrying RPC credit.
              const result = await transport.beforeStreamWrite(value, signal,
                () => r.bytesInFlight < r.window ? send() : false);
              if (result !== false) return result;
            }
          }
        }
        return new WritableStream({write(n,s){const send=(n)=>{`,
    ],
    ["s.error(n),o()", "transportAbort.abort(n),s.error(n),o()"],
    [
      "}},async close()",
      "}};if(!transport?.beforeStreamWrite)return send(n);const write=part=>gated(part,s.signal,()=>send(part));return transport.splitStreamWrite?transport.splitStreamWrite(n,write):write(n)},async close()",
    ],
    [
      "t=n??Error(`WritableStream was aborted`),",
      "t=n??Error(`WritableStream was aborted`),transportAbort.abort(t),",
    ],
    ["tt=1073741824", `tt=${limits.window}`],
  ];
  for (const [before, after] of edits) {
    // Most anchors are only meaningful inside the host's WritableStream.
    const isController = before.startsWith("tt=");
    const start = isController ? 0 : core.indexOf("function ct(e){");
    const end = isController ? core.length : core.indexOf("var lt=", start);
    const segment = core.slice(start, end);
    if (start < 0 || end < 0 || segment.split(before).length !== 2)
      throw Error("Unknown transport writer anchor: " + before);
    core =
      core.slice(0, start) + segment.replace(before, after) + core.slice(end);
  }
  return core;
}
module.exports = { TransportCapacity, patchTransportWriter };
