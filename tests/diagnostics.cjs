const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto");
function load(file, context, imports = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  vm.runInNewContext(
    js,
    {
      performance,
      ...context,
      exports,
      require: (id) => {
        if (!(id in imports)) throw Error(id);
        return imports[id];
      },
    },
    { filename: file },
  );
  return exports;
}
const core = load("src/server/diagnostics/core.ts", {});
test("disabled, sink failure, strict metadata and trace suppression", () => {
  let calls = 0;
  core.createLogger("browser", null, () => calls++).log("error", "test");
  assert.equal(calls, 0);
  const logger = core.createLogger("browser", "trace", () => {
    throw Error("secret");
  });
  assert.doesNotThrow(() => logger.log("error", "failure"));
  const rows = [];
  const active = core.createLogger("browser", "trace", (r) => rows.push(r));
  for (let i = 0; i < 101; i++)
    active.log("trace", "traffic", {
      args: "SECRET prompt",
      url: "https://secret/?prompt=secret",
      path: "/home/secret",
      error: Error("secret"),
      requestId: "prompt secret",
      portId: "/private/secret",
    });
  assert.equal(active.suppressed, 80);
  assert.doesNotMatch(JSON.stringify(rows), /secret|SECRET/);
});
test("tail bounds and malformed envelopes", () => {
  const tail = new core.DiagnosticTail(3, 500);
  for (let i = 0; i < 20; i++) tail.add({ sequence: i });
  assert.equal(tail.records.length, 3);
  assert.equal(tail.dropped, 17);
  assert.equal(core.validEnvelope(null), false);
  assert.equal(core.validEnvelope({ type: "ipc-main-event", args: [] }), false);
  assert.equal(
    core.validEnvelope({ type: "message-port-message", portId: "p" }),
    true,
  );
});
function browser(storage = new Map(), fail = false) {
  let now = 0;
  const events = [],
    timers = [],
    sockets = [];
  const store = {
    getItem(k) {
      if (fail) throw Error("quota");
      return storage.get(k) ?? null;
    },
    setItem(k, v) {
      if (fail) throw Error("quota");
      storage.set(k, v);
    },
    removeItem(k) {
      storage.delete(k);
    },
  };
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    bufferedAmount = 0;
    listeners = {};
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    addEventListener(k, f) {
      this.listeners[k] = f;
    }
    send(v) {
      this.sent.push(v);
    }
    fire(k, data = {}) {
      if (k === "close") this.readyState = 3;
      this.listeners[k](data);
    }
  }
  const window = {
    addEventListener() {},
    location: {
      protocol: "http:",
      host: "localhost",
      pathname: "/",
      search: "",
      reload() {
        events.push("reload");
      },
    },
    history: { pushState() {}, replaceState() {} },
    setTimeout(f) {
      timers.push(f);
      return timers.length;
    },
    setInterval(f) {
      timers.push(f);
      return timers.length;
    },
  };
  const context = {
    window,
    document: { hidden: false, addEventListener() {} },
    navigator: { onLine: true },
    crypto,
    localStorage: { ...store, getItem: () => "trace" },
    sessionStorage: store,
    console: { debug() {} },
    performance: { now: () => now },
    matchMedia: () => ({ matches: false }),
    WebSocket: Socket,
    MessagePort: class {},
    __CODEX_APP_VERSION__: "1.2.3",
  };
  const diag = load("src/browser/diagnostics.ts", context, {
    "../server/diagnostics/core": core,
  });
  const shim = load("src/browser/shim.ts", context, {
    "./diagnostics": diag,
    "../server/diagnostics/core": core,
    "./routes": {
      mapBrowserPathToInitialRoute: () => ({ memoryPath: "/" }),
      mapMemoryPathToBrowserPath: () => null,
    },
    "./files": { isLocalFilePickerMessage: () => false },
    "./workspace-root-dialog": {},
  });
  return {
    window,
    diag,
    shim,
    sockets,
    timers,
    events,
    advance(n) {
      now += n;
    },
    records() {
      return JSON.parse(window.codexWebDiagnostics.export()).records;
    },
  };
}
test("decode versus listener failure, unknown IDs, slow observation and disconnect/reload tail", async () => {
  const storage = new Map();
  const b = browser(storage);
  const socket = b.sockets[0];
  socket.readyState = 1;
  socket.fire("open");
  socket.fire("message", { data: "{" });
  b.shim.ipcRenderer.on("test", () => {
    throw Error("SECRET prompt /home/private");
  });
  socket.fire("message", {
    data: JSON.stringify({ type: "ipc-main-event", channel: "test", args: [] }),
  });
  socket.fire("message", {
    data: JSON.stringify({
      type: "ipc-renderer-invoke-result",
      requestId: "ipc_bridge_999",
      ok: true,
    }),
  });
  socket.fire("message", {
    data: JSON.stringify({
      type: "message-port-message",
      portId: "message_port_ipc_bridge_999",
      data: "SECRET",
    }),
  });
  const request = b.shim.ipcRenderer.invoke("test");
  b.advance(11000);
  for (const timer of [...b.timers]) timer();
  assert(b.records().some((r) => r.event === "request.slow"));
  assert(b.records().some((r) => r.event === "transport.decode-failure"));
  assert(b.records().some((r) => r.event === "ipc.listener-failure"));
  socket.fire("close", { code: 1006, wasClean: false });
  await assert.rejects(request, /lost/);
  // Reconnect timer is last; storage batching may also be queued.
  b.timers.at(-1)();
  const next = b.sockets[1];
  next.readyState = 1;
  next.fire("open");
  assert.deepEqual(b.events, ["reload"]);
  const reloaded = browser(storage);
  assert(reloaded.records().some((r) => r.event === "socket.close"));
  assert(reloaded.records().some((r) => r.event === "page.reload"));
  assert.equal(reloaded.diag.sessionId, b.diag.sessionId);
  assert.notEqual(reloaded.diag.pageId, b.diag.pageId);
  assert.notEqual(
    new URL(socket.url).searchParams.get("diagConnection"),
    new URL(next.url).searchParams.get("diagConnection"),
  );
  assert.doesNotMatch(JSON.stringify(b.records()), /SECRET|private/);
});
test("storage failure does not prevent initialization or pending settlement", async () => {
  const b = browser(new Map(), true),
    socket = b.sockets[0];
  const request = b.shim.ipcRenderer.invoke("test");
  socket.fire("close", { code: 1006, wasClean: false });
  await assert.rejects(request, /lost/);
  assert.doesNotThrow(() => b.diag.flushDiagnostics());
});
test("two connections with overlapping local IDs remain distinct", async () => {
  const a = browser(),
    b = browser();
  for (const instance of [a, b]) {
    const socket = instance.sockets[0];
    socket.readyState = 1;
    socket.fire("open");
    const pending = instance.shim.ipcRenderer.invoke("test");
    socket.fire("message", {
      data: JSON.stringify({
        type: "ipc-renderer-invoke-result",
        requestId: "ipc_bridge_1",
        ok: true,
        result: 42,
      }),
    });
    assert.equal(await pending, 42);
  }
  const x = a.records().find((r) => r.event === "request.settle");
  const y = b.records().find((r) => r.event === "request.settle");
  assert.equal(x.requestId, y.requestId);
  assert.notEqual(x.connectionId, y.connectionId);
});

test("server MessagePort queues, flushes, preserves listener exceptions and disconnects", () => {
  const source = fs.readFileSync("src/server/main.ts", "utf8");
  const fragment =
    source.slice(
      source.indexOf("class WebSocketMessagePort"),
      source.indexOf("function workspaceDirectoryEntryTypeRank"),
    ) + "\nexports.Port = WebSocketMessagePort;";
  const code = ts.transpileModule(fragment, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, performance });
  const events = [],
    sent = [];
  let closed = 0,
    received = 0;
  const port = new exports.Port(
    "message_port_ipc_bridge_1",
    (m) => sent.push(m),
    () => closed++,
    (level, event, fields) => events.push({ level, event, ...fields }),
  );
  port.receiveMessage("SECRET");
  assert(events.some((r) => r.event === "port.queue" && r.queueLength === 1));
  port.on("message", () => received++);
  assert.equal(received, 1);
  assert(events.some((r) => r.event === "port.flush" && r.queueLength === 1));
  port.on("message", () => {
    throw Error("listener");
  });
  assert.throws(() => port.receiveMessage("SECRET"), /listener/);
  assert(events.some((r) => r.event === "port.listener-failure"));
  port.disconnect();
  port.disconnect();
  port.postMessage("SECRET");
  assert.equal(closed, 1);
  assert.equal(sent.length, 0);
  assert(events.some((r) => r.event === "port.closed-use"));
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});

test("oversized tail record is evicted without affecting future records", () => {
  const tail = new core.DiagnosticTail(10, 100);
  tail.add({ oversized: "x".repeat(200) });
  assert.equal(tail.records.length, 0);
  assert.equal(tail.dropped, 1);
  tail.add({ count: 1 });
  assert.equal(tail.records.length, 1);
  tail.clear();
  assert.equal(tail.dropped, 0);
});

test("RPC metadata keeps correlation without payloads", () => {
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        core.rpcMetadata({
          args: [
            {
              request: {
                id: 42,
                method: "plugin/installed",
                params: { secret: "SECRET" },
              },
            },
          ],
        }),
      ),
    ),
    { rpcId: "42", method: "plugin/installed" },
  );
  assert.doesNotMatch(
    JSON.stringify(
      core.rpcMetadata({ data: { id: "private prompt", method: "SECRET" } }),
    ),
    /SECRET|private/,
  );
});

test("upstream result cleanup and late response hook preserve settlement", () => {
  const patch = fs.readFileSync(
    "patches/webview-request-diagnostics.patch",
    "utf8",
  );
  const asset = "scratch/asar/webview/assets/app-shared-8bd9d0399038.js";
  assert(fs.existsSync(asset), "prepared upstream asset is required");
  const source = fs.readFileSync(asset, "utf8");
  const start = source.indexOf("onResult(e, t, n) {");
  const end = source.indexOf("onError(e, t, n) {", start);
  const events = [];
  const client = vm.runInNewContext(
    "({" + source.slice(start, end).trim() + "})",
    {
      globalThis: { __codexWebRequestDiagnostic: (e) => events.push(e) },
      Date,
      zf: { debug() {}, error() {} },
      l6() {},
      rpn() {
        return {};
      },
    },
  );
  const timeoutStart = source.indexOf("onTimeout(e) {");
  const timeoutEnd = source.indexOf("clearRequestTimeout(e) {", timeoutStart);
  const timeoutClient = vm.runInNewContext(
    "({" + source.slice(timeoutStart, timeoutEnd).trim() + "})",
    {
      Date,
      Error,
      zf: { warning() {} },
      l6() {},
      rpn() {
        return {};
      },
    },
  );
  let rejected = 0;
  timeoutClient.requestPromises = new Map([
    [
      "43",
      {
        method: "plugin/installed",
        reject() {
          rejected++;
        },
      },
    ],
  ]);
  timeoutClient.clearRequestTimeout = () => {};
  timeoutClient.releaseRequestCapacity = () => {};
  timeoutClient.emitRequestLifecycleEvent = (e) => events.push(e);
  timeoutClient.onTimeout("43");
  assert.equal(rejected, 1);
  assert.equal(timeoutClient.requestPromises.size, 0);
  assert.equal(events.at(-1).type, "timed-out");
  timeoutClient.onTimeout("43");
  assert.equal(rejected, 1);
  let resolved = 0,
    cleared = 0;
  client.requestPromises = new Map([
    [
      "42",
      {
        resolve() {
          resolved++;
        },
        method: "plugin/installed",
        queuedAtMs: 0,
      },
    ],
  ]);
  client.clearRequestTimeout = () => cleared++;
  client.releaseRequestCapacity = () => {};
  client.emitRequestLifecycleEvent = () => {};
  client.onResult("42", {}, null);
  assert.equal(client.requestPromises.size, 0);
  assert.equal(cleared, 1);
  client.onResult("42", {}, null);
  assert.equal(resolved, 1);
  assert.equal(events.at(-1).type, "late-response");
  assert.match(patch, /requestPromises\.set/);
});
