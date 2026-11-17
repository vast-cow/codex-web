// Private rehearsal supervisor. Controls only children it forks, never system units.
const fs = require("node:fs"),
  path = require("node:path"),
  net = require("node:net"),
  http = require("node:http");
const { fork } = require("node:child_process");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const modes = ["baseline", "512k"];
function api(code) {
  return new Function("__codexRpcDiag", "t", code)(undefined, (fn) => {
    let done = false;
    return () => {
      if (!done) {
        done = true;
        fn();
      }
    };
  });
}
function release(root, mode) {
  if (!modes.includes(mode)) throw Error("Unknown release");
  const dir = path.join(root, "releases", mode),
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"))),
    code = fs.readFileSync(path.join(dir, "host.js"), "utf8");
  if (hash(code) !== manifest.sha256) throw Error("Release hash mismatch");
  const core = api(code),
    runtime = {
      initial: new core.Window(() => 1).window,
      minimum: core.minimum,
      maximum: core.maximum,
    };
  assert.deepEqual(runtime, manifest.runtime);
  return { core, manifest, runtime };
}
async function service(root, mode, port) {
  const { WebSocketServer } = require("ws");
  const { ResourceBudget } = require("./rpc-resource-budget.cjs");
  const loaded = release(root, mode),
    core = loaded.core;
  let server, wsServer;
  const connections = new Set();
  let produced = 0,
    canceled = 0,
    exiting = false;
  function stop(code = 0) {
    if (exiting) return;
    exiting = true;
    for (const ws of connections) ws.terminate();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 1000).unref();
  }
  const budget = new ResourceBudget({
    enabled: process.env.RPC_ISOLATED_BUDGET_STOP === "1",
    onStop: () => stop(72),
  });
  setInterval(() => {
    const m = process.memoryUsage();
    budget.memory({
      hostRss: m.rss,
      hostHeap: m.heapUsed,
      hostExternal: m.external,
    });
  }, 100).unref();
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        pid: process.pid,
        mode,
        sha256: loaded.manifest.sha256,
        runtime: loaded.runtime,
        produced,
        canceled,
        budgetEnabled: budget.enabled,
      }),
    );
  });
  wsServer = new WebSocketServer({ server, perMessageDeflate: false });
  wsServer.on("connection", (ws) => {
    connections.add(ws);
    const queue = [];
    let pending, error;
    const fail = () => {
      error = Error("rehearsal disconnect");
      pending?.reject(error);
      pending = undefined;
      queue.length = 0;
      connections.delete(ws);
    };
    ws.on("close", fail);
    ws.on("error", fail);
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (pending) {
        const p = pending;
        pending = undefined;
        p.resolve(m);
      } else queue.push(m);
    });
    class Service extends core.Target {
      fetch(count = 16) {
        let i = 0;
        return new Response(
          new ReadableStream(
            {
              pull(c) {
                if (i === count) {
                  c.close();
                  return;
                }
                produced++;
                c.enqueue(new Uint8Array(65536).fill(i++ % 251));
              },
              cancel() {
                canceled++;
              },
            },
            { highWaterMark: 0 },
          ),
        );
      }
    }
    new core.Session(
      {
        encodingLevel: "jsonCompatible",
        send(m) {
          if (error) throw error;
          ws.send(JSON.stringify(m));
        },
        receive() {
          if (queue.length) return Promise.resolve(queue.shift());
          if (error) return Promise.reject(error);
          return new Promise(
            (resolve, reject) => (pending = { resolve, reject }),
          );
        },
        abort() {
          fail();
          ws.terminate();
        },
      },
      new Service(),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  process.on("SIGTERM", () => stop());
  process.on("message", (m) => {
    if (m === "synthetic-memory-probe")
      budget.memory({ hostRss: budget.limits.memory.hostRss + 1 });
  });
  process.send?.({
    ready: true,
    port: server.address().port,
    pid: process.pid,
  });
}
async function command(root, action, mode) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(root, "control.sock"));
    let data = "";
    sock.on("error", reject);
    sock.on("connect", () =>
      sock.write(JSON.stringify({ action, mode }) + "\n"),
    );
    sock.on("data", (part) => {
      data += part;
      if (data.includes("\n")) {
        sock.end();
        const result = JSON.parse(data.trim());
        if (result.error) reject(Error(result.error));
        else resolve(result);
      }
    });
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(Error("private supervisor timeout"));
    });
  });
}
async function supervisor(root) {
  let child,
    port = 0,
    selected,
    lastExit,
    memoryProbe,
    watching = false;
  const watchdogEvents = [];
  async function stop() {
    if (!child) return { stopped: true, forced: false };
    const owned = child;
    const exited = new Promise((r) => owned.once("exit", r));
    owned.kill("SIGTERM");
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      owned.kill("SIGKILL");
    }, 3000);
    await exited;
    clearTimeout(timer);
    if (child === owned) child = undefined;
    return { stopped: true, forced };
  }
  const server = net.createServer((socket) => {
    let data = "";
    socket.on("data", async (part) => {
      data += part;
      if (!data.includes("\n")) return;
      try {
        const { action, mode } = JSON.parse(data.trim());
        let result;
        if (action === "start") {
          if (child)
            throw Error("Stop current isolated child before switching");
          release(root, mode);
          const next = fork(__filename, ["service", root, mode, String(port)], {
            cwd: root,
            env: { ...process.env, RPC_ISOLATED_BUDGET_STOP: "1" },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });
          child = next;
          let errorLog = "";
          next.stderr.on("data", (x) => (errorLog += x));
          next.on("exit", (code, signal) => {
            lastExit = { code, signal };
            if (child === next) child = undefined;
          });
          const ready = await new Promise((resolve, reject) => {
            next.once("message", resolve);
            next.once("error", reject);
            next.once("exit", () =>
              reject(Error("Isolated startup failed: " + errorLog)),
            );
          });
          port = ready.port;
          selected = mode;
          result = { ...ready, selected };
        } else if (action === "stop") result = await stop();
        else if (action === "status")
          result = {
            running: !!child,
            pid: child?.pid,
            port,
            selected,
            lastExit,
            watchdogEvents,
          };
        else if (action === "probe-memory") {
          if (!child) throw Error("No child");
          child.send("synthetic-memory-probe");
          result = { synthetic: true };
        } else if (action === "probe-supervisor-memory") {
          if (!child) throw Error("No child");
          memoryProbe = 256 * 1048576 + 1;
          result = { synthetic: true, independentSupervisor: true };
        } else if (action === "crash") {
          if (!child) throw Error("No child");
          child.kill("SIGKILL");
          result = { crashed: true };
        } else if (action === "shutdown") {
          await stop();
          result = { shutdown: true };
          server.close();
        } else throw Error("Unknown isolated supervisor command");
        socket.end(JSON.stringify(result) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ error: String(error.message) }) + "\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(root, "control.sock"), resolve);
  });
  const watchdog = setInterval(async () => {
    if (!child || watching) return;
    watching = true;
    try {
      const rss =
        Number(
          fs
            .readFileSync(`/proc/${child.pid}/status`, "utf8")
            .match(/VmRSS:\s+(\d+)/)[1],
        ) * 1024;
      const value = memoryProbe ?? rss,
        synthetic = memoryProbe !== undefined;
      memoryProbe = undefined;
      if (value > 256 * 1048576) {
        watchdogEvents.push({
          rss: value,
          limit: 256 * 1048576,
          synthetic,
          ownedPid: child.pid,
        });
        await stop();
      }
    } catch {
    } finally {
      watching = false;
    }
  }, 100);
  server.on("close", () => clearInterval(watchdog));
  fs.chmodSync(path.join(root, "control.sock"), 0o600);
  process.send?.({ ready: true });
}
function init(root, fixture) {
  if (fs.existsSync(root)) throw Error("Rehearsal destination must not exist");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const cores = JSON.parse(fs.readFileSync(fixture));
  for (const mode of modes) {
    const dir = path.join(root, "releases", mode);
    fs.mkdirSync(dir, { recursive: true });
    const code = cores[mode],
      core = api(code);
    fs.writeFileSync(path.join(dir, "host.js"), code);
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify(
        {
          mode,
          sha256: hash(code),
          runtime: {
            initial: new core.Window(() => 1).window,
            minimum: core.minimum,
            maximum: core.maximum,
          },
        },
        null,
        2,
      ),
    );
  }
  fs.writeFileSync(path.join(root, "browser-core.js"), cores.browser);
}
function health(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (res) => {
        let s = "";
        res.on("data", (x) => (s += x));
        res.on("end", () => resolve(JSON.parse(s)));
      })
      .on("error", reject);
  });
}
async function transfer(root, port, count = 16, hold = false) {
  const { WebSocket } = require("ws"),
    core = api(fs.readFileSync(path.join(root, "browser-core.js"), "utf8"));
  const ws = new WebSocket(`ws://127.0.0.1:${port}`),
    queue = [];
  let pending, error;
  ws.on("message", (raw) => {
    const value = JSON.parse(String(raw));
    if (pending) {
      const p = pending;
      pending = undefined;
      p.resolve(value);
    } else queue.push(value);
  });
  ws.on("close", () => {
    error = Error("closed");
    pending?.reject(error);
    pending = undefined;
  });
  await new Promise((r) => ws.once("open", r));
  const session = new core.Session({
    encodingLevel: "jsonCompatible",
    send(m) {
      ws.send(JSON.stringify(m));
    },
    receive() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (error) return Promise.reject(error);
      return new Promise((resolve, reject) => (pending = { resolve, reject }));
    },
    abort() {
      ws.terminate();
    },
  });
  const response = await session.getRemoteMain().fetch(count),
    reader = response.body.getReader();
  let chunks = 0;
  try {
    if (hold) {
      await pause(200);
      return { reader, ws };
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      assert.equal(value.byteLength, 65536);
      assert.ok(value.every((x) => x === chunks % 251));
      chunks++;
    }
    await session.drain();
    assert.equal(chunks, count);
    return { chunks, bytes: chunks * 65536 };
  } finally {
    if (!hold) ws.terminate();
  }
}
async function rehearse(root, fixture) {
  init(root, fixture);
  const commands = [];
  const parent = fork(__filename, ["serve", root], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  parent.stderr.on("data", (s) => (errors += s));
  await new Promise((resolve, reject) => {
    parent.once("message", resolve);
    parent.once("error", reject);
  });
  const exec = async (action, mode) => {
    const args = [__filename, action, root, ...(mode ? [mode] : [])];
    const done = require("node:child_process").spawnSync(
      process.execPath,
      args,
      { encoding: "utf8", timeout: 10000 },
    );
    if (done.status !== 0) throw Error(done.stderr);
    const result = JSON.parse(done.stdout);
    commands.push({
      command: `node scripts/diagnostics/rpc-isolated-supervisor.cjs ${action} ${root}${mode ? " " + mode : ""}`,
      result,
    });
    return result;
  };
  try {
    const initial = await exec("start", "baseline");
    let port = initial.port;
    const a1 = await health(port);
    assert.equal(a1.runtime.minimum, 65536);
    const bodyA1 = await transfer(root, port);
    const stalled = await transfer(root, port, 10000, true);
    const paused = (await health(port)).produced;
    await pause(200);
    assert.equal((await health(port)).produced, paused);

    assert.equal((await exec("stop")).forced, false);
    await assert.rejects(() => health(port));
    await assert.rejects(async () => {
      while (!(await stalled.reader.read()).done) {}
    }, /closed|disconnect|RPC|stream/);
    stalled.ws.terminate();
    await exec("start", "512k");
    const b = await health(port);
    assert.equal(b.runtime.minimum, 524288);
    const bodyB = await transfer(root, port);
    // A resource-watchdog stop exits only the private child with a distinct code.
    await exec("probe-memory");
    for (let i = 0; i < 100 && (await command(root, "status")).running; i++)
      await pause(20);
    const fault = await exec("status");
    assert.equal(fault.running, false);
    assert.equal(fault.lastExit.code, 72);
    await exec("start", "baseline");
    const a2 = await health(port);
    assert.equal(a2.sha256, a1.sha256);
    const bodyA2 = await transfer(root, port);
    await exec("stop");
    const file = path.join(root, "releases/512k/host.js"),
      before = fs.readFileSync(file, "utf8");
    fs.appendFileSync(file, "\n// corrupt candidate");
    await assert.rejects(() => exec("start", "512k"), /hash mismatch/);
    fs.writeFileSync(file, before);
    await exec("start", "512k");
    await exec("crash");
    for (let i = 0; i < 100 && (await command(root, "status")).running; i++)
      await pause(20);
    await exec("start", "baseline");
    assert.equal((await health(port)).sha256, a1.sha256);
    await exec("probe-supervisor-memory");
    for (let i = 0; i < 100 && (await command(root, "status")).running; i++)
      await pause(20);
    const independent = await exec("status");
    assert.equal(independent.running, false);
    assert.equal(independent.watchdogEvents.at(-1).synthetic, true);
    await exec("start", "baseline");
    assert.equal((await health(port)).sha256, a1.sha256);
    await exec("stop");
    await exec("shutdown");
    return {
      root,
      port,
      commands,
      health: { a1, b, a2 },
      transfers: { bodyA1, bodyB, bodyA2 },
      activeTransferRejectedOnStop: true,
      syntheticMemoryFault: true,
      independentSupervisorMemoryFault: true,
      hashMismatchRejected: true,
      crashRecovery: true,
      finalListenerClosed: true,
      supervisor: "owned Node child processes; systemd activation unavailable",
    };
  } finally {
    try {
      await command(root, "shutdown");
    } catch {}
    parent.kill("SIGTERM");
  }
}
async function main() {
  const [action, root, arg] = process.argv.slice(2);
  if (!root)
    throw Error(
      "Usage: rpc-isolated-supervisor.cjs init|serve|start|stop|status|probe-memory|crash|shutdown|rehearse ROOT [CORES|MODE]",
    );
  if (action === "service") return service(root, arg, Number(process.argv[5]));
  if (action === "init") return init(root, arg);
  if (action === "serve") return supervisor(root);
  if (action === "rehearse") {
    console.log(JSON.stringify(await rehearse(root, arg), null, 2));
    return;
  }
  console.log(JSON.stringify(await command(root, action, arg), null, 2));
}
module.exports = { rehearse };
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
