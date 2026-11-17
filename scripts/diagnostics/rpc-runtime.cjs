// Embedded into each Desktop RPC bundle by instrument-rpc.cjs.
// Only numeric IDs, sizes, timings, and fixed event names leave this helper.
function createRpcDiagnostics(side, enabled, sink) {
  if (!enabled) return undefined;
  const ids = new WeakMap();
  const tokenOperations = new WeakMap();
  let lastSend;
  let nextId = 0,
    sequence = 0,
    dropped = 0,
    context;
  const queue = [];
  const now = () => performance.now();
  const id = (object) => {
    if (!ids.has(object)) ids.set(object, ++nextId);
    return ids.get(object);
  };
  const emit = (event, fields = {}) => {
    if (queue.length >= 2048) {
      dropped++;
      return;
    }
    queue.push({
      diagnostic: "rpc-flow",
      side,
      event,
      sequence: sequence++,
      ms: now(),
      epochMs: Date.now(),
      ...fields,
    });
  };
  const flush = () => {
    const batch = queue.splice(0);
    if (dropped) {
      batch.push({
        diagnostic: "rpc-flow",
        side,
        event: "dropped",
        count: dropped,
      });
      dropped = 0;
    }
    for (const record of batch) {
      try {
        if (sink) sink(record);
        else console.info(JSON.stringify(record));
      } catch {
        /* Diagnostics cannot fail RPC. */
      }
    }
  };
  const timer = setInterval(flush, 250);
  timer.unref?.();
  let loop, loopTimer;
  if (side === "host") {
    loop = require("node:perf_hooks").monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    loopTimer = setInterval(() => {
      emit("event-loop", {
        resolutionMs: 20,
        meanMs: loop.mean / 1e6,
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
      });
      loop.reset();
    }, 1000);
    loopTimer.unref();
  }
  return {
    id,
    emit,
    flush,
    sent(session, operationId, streamId) {
      lastSend = {
        sessionId: id(session),
        operationId,
        streamId: typeof streamId === "number" ? streamId : undefined,
      };
      emit("stream-send", lastSend);
    },
    operation(session, operationId, streamId, run) {
      const previous = context;
      context = {
        sessionId: id(session),
        operationId,
        streamId: typeof streamId === "number" ? streamId : undefined,
      };
      try {
        return run();
      } finally {
        context = previous;
      }
    },
    window(event, state, token) {
      if (event === "send") tokenOperations.set(token, lastSend);
      emit("window-" + event, {
        ...tokenOperations.get(token),
        windowId: id(state),
        tokenId: id(token),
        estimatedBytes: token.size,
        window: state.window,
        bytesInFlight: state.bytesInFlight,
        startup: state.inStartupPhase,
        minRttMs: Number.isFinite(state.minRtt) ? state.minRtt : null,
        shouldBlock: state.bytesInFlight >= state.window,
        ackRttMs: event === "ack" ? now() - token.sentTime : undefined,
      });
    },
    credit(state) {
      const started = now(),
        waitId = ++nextId;
      emit("credit-wait-start", { windowId: id(state), waitId });
      return (outcome) =>
        emit("credit-wait-end", {
          windowId: id(state),
          waitId,
          outcome,
          durationMs: now() - started,
        });
    },
    writerToken(writer) {
      return { writerId: id(writer), writeId: ++nextId, ...context };
    },
    writeStart(token, value) {
      token.started = now();
      emit("writer-start", {
        writerId: token.writerId,
        writeId: token.writeId,
        sessionId: token.sessionId,
        operationId: token.operationId,
        streamId: token.streamId,
        bytes: ArrayBuffer.isView(value) ? value.byteLength : undefined,
      });
    },
    writeEnd(token, failed = false) {
      if (token.started === undefined) return;
      emit("writer-end", {
        writerId: token.writerId,
        writeId: token.writeId,
        sessionId: token.sessionId,
        operationId: token.operationId,
        streamId: token.streamId,
        failed,
        durationMs: now() - token.started,
      });
      token.started = undefined;
    },
    close() {
      clearInterval(timer);
      clearInterval(loopTimer);
      loop?.disable();
      flush();
    },
  };
}
module.exports = { createRpcDiagnostics };
