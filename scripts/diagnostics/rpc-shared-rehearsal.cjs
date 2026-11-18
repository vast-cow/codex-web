// Run inside the private mount/PID/network namespace and transient memory unit.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const { execFileSync, spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { extract } = require("./rpc-core.cjs");

const root = fs.realpathSync(process.argv[2]);
const control = path.join(root, "control");
const socketName = "bridge-" + process.pid + ".sock";
const socket = path.join(control, "daemon", socketName);
const evidence = { steps: [] };
const fixtureUrl = "data:application/vnd.codex-isolated,statsig/bootstrap";
const children = new Set();
let memorySampler;
let memoryObserver;
const digest = (file) => {
  // The CLI is 281 MiB. Verification must not retain a CLI-sized Buffer.
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
};
const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
const memory = path.join("/sys/fs/cgroup", cgroup.trim().split("::")[1]);
const readMemory = (name) =>
  fs.readFileSync(path.join(memory, name), "utf8").trim();
const readCounters = (name) =>
  Object.fromEntries(
    readMemory(name)
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(" ");
        return [key, Number(value)];
      }),
  );
const save = () =>
  fs.writeFileSync(
    path.join(root, "rehearsal.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
const record = (step, data) => {
  memoryObserver?.phase(step);
  const memoryCurrent = Number(readMemory("memory.current"));
  const memoryPeak = Number(readMemory("memory.peak"));
  evidence.steps.push({ step, ...data, memoryCurrent, memoryPeak });
  save();
  console.log(step, JSON.stringify(data));
};

// /proc is the private PID namespace. Do not export argv or environment.
function processTree() {
  return fs
    .readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((pid) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const [state, parent, group, session] = stat
          .slice(close + 2)
          .split(" ");
        assert.equal(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"), cgroup);
        return [
          {
            pid: Number(pid),
            parent: Number(parent),
            group: Number(group),
            session: Number(session),
            name: stat.slice(stat.indexOf("(") + 1, close),
            state,
          },
        ];
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
        return [];
      }
    });
}

function own(label, executable, args, env = process.env) {
  const log = path.join(control, label + ".log");
  const fd = fs.openSync(log, "w", 0o600);
  const child = spawn(executable, args, { env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", () => children.delete(child));
  assert.equal(fs.readFileSync(`/proc/${child.pid}/cgroup`, "utf8"), cgroup);
  return child;
}

async function until(label, probe, timeout = 15_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw Error("Timed out waiting for " + label);
}

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

const serving = (port) =>
  new Promise((resolve) => {
    const client = net.connect(port, "127.0.0.1");
    client.once("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.once("error", () => resolve(false));
  });

const runtime = () =>
  JSON.parse(fs.readFileSync(path.join(control, "runtime.json")));
const managed = (runtime) => {
  const loc = `/proc/${runtime.pid}`;
  assert.equal(fs.readFileSync(loc + "/cgroup", "utf8"), cgroup);
  const env = fs.readFileSync(loc + "/environ", "utf8").split("\0");
  const names = new Set([
    "HOME",
    "CODEX_HOME",
    "CODEX_API_BASE_URL",
    "CODEX_CLI_PATH",
    "CODEX_UNIX_SOCKET",
    "CODEX_WEB_SHARED_TRANSPORT",
    "CODEX_WEB_TRANSPORT_METRICS",
    "CODEX_RPC_DIAGNOSTICS",
    "CODEX_BOOTSTRAP_DIAGNOSTICS",
    "TMPDIR",
    "PATH",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "NODE_OPTIONS",
    "REHEARSAL_UPSTREAM_URL",
  ]);
  return {
    mode: runtime.mode,
    args: fs
      .readFileSync(loc + "/cmdline", "utf8")
      .split("\0")
      .filter(Boolean),
    executable: fs.readlinkSync(loc + "/exe"),
    cwd: fs.readlinkSync(loc + "/cwd"),
    env: env.filter((entry) => names.has(entry.split("=")[0])).sort(),
    envSha256: createHash("sha256").update(env.sort().join("\0")).digest("hex"),
  };
};

function artifactManifest(release) {
  const files = [
    "src/server/main.js",
    "src/server/electron/index.js",
    "scratch/asar/package.json",
    "scratch/asar/.vite/build/main-CqEoQDOU.js",
    "scratch/asar/.vite/build/startup-requirements-C6B1x9gL.js",
    "scratch/asar/webview/assets/app-shared-8bd9d0399038.js",
    "scratch/asar/webview/assets/preload.js",
    "scratch/asar/webview/assets/preload.js.br",
    "scratch/asar/webview/assets/preload.js.gz",
  ];
  return Object.fromEntries(
    files.map((file) => [file, digest(path.join(root, release, file))]),
  );
}

async function main() {
  assert.match(root, /^\/tmp\/rpc-shared\.[^/]+$/);
  assert.notEqual(
    fs.readlinkSync("/proc/self/ns/net"),
    process.env.REHEARSAL_PARENT_NETNS,
  );
  assert.ok(process.env.REHEARSAL_PARENT_NETNS);
  assert.deepEqual(
    JSON.parse(
      execFileSync("ip", ["-j", "link", "show"], { encoding: "utf8" }),
    ).map((link) => link.ifname),
    ["lo"],
  );
  assert.equal(readMemory("memory.max"), "2147483648");
  assert.equal(readMemory("memory.swap.max"), "0");
  if (process.env.REHEARSAL_MEMORY_DIRECTORY) {
    memoryObserver = require("./rpc-memory-observer.cjs").observe(
      process.env.REHEARSAL_MEMORY_DIRECTORY,
      memory,
    );
    require("./rpc-memory-node.cjs");
  }
  assert.equal(process.env.CODEX_HOME, path.join(root, "profile/codex"));
  assert.equal(process.env.HOME, path.join(root, "profile"));
  assert.ok(
    !fs.existsSync(process.env.REHEARSAL_PRODUCTION_HOME + "/Projects"),
  );
  assert.ok(!fs.existsSync("/tmp/rpc-flow-diag-20261117-01"));
  evidence.isolation = {
    network: fs.readlinkSync("/proc/self/ns/net"),
    parentNetwork: process.env.REHEARSAL_PARENT_NETNS,
    memoryMax: Number(readMemory("memory.max")),
    memorySwapMax: Number(readMemory("memory.swap.max")),
    cgroup: cgroup.trim(),
    launcherSha256: digest(path.join(control, "launcher.cjs")),
    proxySha256: digest(path.join(root, "bin/codex_remote_proxy")),
    appServerSha256: digest(path.join(root, "bin/codex")),
  };
  let sampledPeak;
  memorySampler = setInterval(() => {
    const current = Number(readMemory("memory.current"));
    if (current <= (sampledPeak?.current ?? 0)) return;
    const { anon, file, kernel, sock, shmem } = readCounters("memory.stat");
    sampledPeak = {
      current,
      anon,
      file,
      kernel,
      sock,
      shmem,
      afterStep: evidence.steps.at(-1)?.step,
    };
    evidence.sampledMemoryPeak = sampledPeak;
  }, 100).unref();

  const alias = path.join(control, "app-server-" + process.pid + ".sock");
  const appLog = own("app-server", path.join(root, "bin/codex"), [
    "app-server",
    "--listen",
    "unix://" + alias,
  ]);
  await until("private app-server socket", () => fs.existsSync(alias));
  // The app-server exposes an alias to its daemon socket. A real directory
  // entry beside the release survives the Desktop child's /tmp mount.
  const daemonSocket = fs.realpathSync(alias);
  fs.linkSync(daemonSocket, path.join(path.dirname(daemonSocket), socketName));
  assert.equal(fs.statSync(daemonSocket).ino, fs.statSync(socket).ino);
  const initialize = spawn(
    path.join(root, "bin/codex_remote_proxy"),
    ["app-server"],
    {
      env: { ...process.env, CODEX_UNIX_SOCKET: socket },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  children.add(initialize);
  initialize.once("exit", () => children.delete(initialize));
  initialize.stdin.write(
    JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "isolated-rehearsal", version: "1" } },
    }) + "\n",
  );
  let appReply = "";
  initialize.stdout.on("data", (data) => {
    appReply += data;
  });
  await until("JSON-RPC initialize through production proxy", () =>
    appReply.includes('"id":1'),
  );
  const initialized = JSON.parse(
    appReply.split("\n").find((line) => line.includes('"id":1')),
  );
  assert.equal(initialized.result.codexHome, process.env.CODEX_HOME);
  initialize.stdin.write(
    '{"method":"initialized"}\n' +
      '{"id":2,"method":"account/read","params":{"refreshToken":false}}\n',
  );
  const account = await until("account/read through production proxy", () =>
    appReply
      .split("\n")
      .slice(0, -1)
      .map(JSON.parse)
      .find((row) => row.id === 2),
  );
  assert.equal(account.result?.account, null);
  record("app-server", {
    privateSocket: true,
    initialized: true,
    accountAuthenticated: false,
    inheritedCgroup: true,
  });

  const chunkSizes = fs
    .readFileSync(path.join(control, "bootstrap-chunks.csv"), "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((row, index) => {
      const [sequence, start, end, size] = row.split(",").map(Number);
      assert.equal(sequence, index);
      assert.equal(end - start, size);
      assert.ok(Number.isSafeInteger(size) && size > 0);
      return size;
    });
  const replaySize = chunkSizes.reduce((sum, size) => sum + size, 0);
  assert.equal(chunkSizes.length, 135);
  assert.equal(replaySize, 7956397);
  const encodeFixture = (fixture) =>
    JSON.stringify({ statsigPayload: JSON.stringify({ fixture }) });
  const payloadSize = replaySize - Buffer.byteLength(encodeFixture(""));
  const payload = randomBytes(Math.ceil(payloadSize / 2))
    .toString("hex")
    .slice(0, payloadSize);
  const sample = Buffer.from(encodeFixture(payload));
  assert.equal(sample.length, replaySize);
  const expected = createHash("sha256").update(sample).digest("hex");
  let upstreamHits = 0;
  let heldSourceClosed = false;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/statsig/bootstrap?held") {
      upstreamHits++;
      res.once("close", () => {
        heldSourceClosed = !res.writableFinished;
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.write(sample.subarray(0, chunkSizes[0]));
      return;
    }
    if (req.url !== "/statsig/bootstrap") {
      res.writeHead(404).end();
      return;
    }
    upstreamHits++;
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": sample.length,
    });
    let offset = 0;
    let index = 0;
    function writeNext(error) {
      if (error || res.destroyed) return;
      if (index === chunkSizes.length) {
        res.end();
        return;
      }
      const end = offset + chunkSizes[index++];
      const chunk = sample.subarray(offset, end);
      offset = end;
      res.write(chunk, writeNext);
    }
    writeNext();
  });
  record("bootstrap-fixture", {
    decodedBytes: replaySize,
    upstreamWrites: chunkSizes.length,
    syntheticJson: true,
  });
  const upstreamPort = await listen(upstream);
  const ephemeral = net.createServer();
  const bridgePort = await listen(ephemeral);
  await new Promise((resolve) => ephemeral.close(resolve));
  assert.notEqual(bridgePort, 8214);
  const key = fs.readFileSync(path.join(control, "key.pem"));
  const cert = fs.readFileSync(path.join(control, "cert.pem"));
  const relay = tls.createServer({ key, cert }, (client) => {
    const backend = net.connect(bridgePort, "127.0.0.1");
    client.on("error", () => backend.destroy());
    backend.on("error", () => client.destroy());
    client.on("close", () => backend.destroy());
    backend.on("close", () => client.destroy());
    client.pipe(backend).pipe(client);
  });
  const relayPort = await listen(relay);
  const origin = `https://localhost:${relayPort}`;
  const localUpstream = `http://127.0.0.1:${upstreamPort}`;
  const fixturePreload = path.join(control, "rehearsal-fetch.cjs");
  fs.writeFileSync(
    fixturePreload,
    `
const fetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const base = ${JSON.stringify(fixtureUrl)};
  if (url !== base && url !== base + "?held") return fetch(input, init);
  const target = new URL(process.env.REHEARSAL_UPSTREAM_URL);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw Error("Invalid local body fixture");
  return fetch(new URL("/statsig/bootstrap" + url.slice(base.length), target), { method: "GET", signal: init?.signal });
};
`,
    { mode: 0o600 },
  );
  const deploy = {
    candidateDirectory: path.join(root, "active"),
    workingDirectory: path.join(root, "work"),
    cliPath: path.join(root, "bin/codex_remote_proxy"),
    unixSocket: socket,
    host: "127.0.0.1",
    port: bridgePort,
    sourceRevision: "isolated-release-link",
  };
  fs.writeFileSync(
    path.join(control, "deployment.json"),
    JSON.stringify(deploy),
  );
  const mode = (value) =>
    fs.writeFileSync(path.join(control, "mode"), value + "\n");

  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const browserCore = extract(
    fs.readFileSync(
      path.join(
        root,
        "A/scratch/asar/webview/assets/app-shared-8bd9d0399038.js",
      ),
      "utf8",
    ),
    "browser",
  );
  const document = () =>
    new Promise((resolve, reject) => {
      https
        .get(origin + "/", { ca: cert }, (response) => {
          const result = {
            status: response.statusCode,
            verified: response.socket.authorized,
            tls: response.socket.getProtocol(),
          };
          response.resume();
          response.on("end", () => resolve(result));
        })
        .on("error", reject);
    });
  async function ipcProbe(release, stopWhileReading) {
    const { WebSocket } = require("ws");
    const { SharedWebSocketTransport, sharedTransportProtocol } = require(
      path.join(root, "B/src/shared/websocket-transport.js"),
    );
    const bounded = release === "B";
    const ws = new WebSocket(
      origin.replace("https:", "wss:") + "/__backend/ipc",
      bounded ? [sharedTransportProtocol] : [],
      { ca: cert },
    );
    let completed;
    const done = new Promise((resolve) => {
      completed = resolve;
    });
    const payload = {
      type: "workspace-directory-entries-request",
      requestId: "rehearsal",
      directoryPath: deploy.workingDirectory,
      directoriesOnly: false,
    };
    const portId = "rehearsal-rpc";
    const messages = [];
    let waiting;
    let closed;
    const close = (reason) => {
      closed = reason;
      waiting?.reject(reason);
      waiting = undefined;
    };
    const deliver = (message) => {
      if (
        message.type === "message-port-message" &&
        message.portId === portId
      ) {
        if (waiting) {
          waiting.resolve(message.data);
          waiting = undefined;
        } else messages.push(message.data);
        return;
      }
      if (
        message.type === "workspace-directory-entries-result" &&
        message.requestId === payload.requestId
      )
        completed({
          ok: message.ok,
          correctPath:
            message.result?.directoryPath === deploy.workingDirectory,
        });
    };
    const transport =
      bounded &&
      new SharedWebSocketTransport("browser", {
        bufferedAmount: () => ws.bufferedAmount,
        send: (frame) => ws.send(frame),
        deliver,
        fail: (error) => {
          completed({ error: error.message });
          close(error);
        },
      });
    const send = (message) => {
      if (transport) {
        if (!transport.send(message))
          throw Error("Rehearsal IPC transport failed");
      } else if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(message));
      else throw Error("Rehearsal WebSocket is closed");
    };
    ws.on("open", () => {
      if (transport) {
        transport.start();
        transport.send(payload);
      } else ws.send(JSON.stringify(payload));
    });
    ws.on("message", (data) => {
      if (transport) transport.receive(data);
      else deliver(JSON.parse(data.toString()));
    });
    ws.on("error", (error) => completed({ error: error.message }));
    ws.on("close", (code) => {
      completed({ closed: code });
      close(Error("Rehearsal WebSocket closed with " + code));
    });
    try {
      const ipc = await Promise.race([
        done,
        delay(17000, { timeout: true }, { ref: false }),
      ]);
      if (!ipc.ok) return { ipc, bodies: [] };
      const { Session } = new Function("__codexRpcDiag", "t", browserCore)(
        undefined,
        (fn) => {
          let initialized = false;
          return () => {
            if (!initialized) {
              initialized = true;
              fn();
            }
          };
        },
      );
      send({
        type: "ipc-renderer-post-message",
        channel: "codex_desktop:connect-app-host",
        portIds: [portId],
      });
      const session = new Session({
        encodingLevel: "jsonCompatible",
        send(data) {
          send({ type: "message-port-message", portId, data });
        },
        receive() {
          if (messages.length) return Promise.resolve(messages.shift());
          if (closed) return Promise.reject(closed);
          return new Promise((resolve, reject) => {
            waiting = { resolve, reject };
          });
        },
        abort: close,
      });
      const fetch = session.getRemoteMain().services.httpFetch;
      if (stopWhileReading) {
        const { response } = await fetch.fetch("active-shutdown", {
          url: fixtureUrl + "?held",
          method: "GET",
          headers: {},
          retry: false,
        });
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        let firstBytes = 0;
        while (firstBytes < chunkSizes[0]) {
          const next = await reader.read();
          assert.ok(!next.done && next.value.byteLength > 0);
          firstBytes += next.value.byteLength;
        }
        assert.equal(firstBytes, chunkSizes[0]);
        const started = performance.now();
        const interrupted = reader.read().then(
          () => {
            throw Error("Active response ended without a reader rejection");
          },
          () => performance.now() - started,
        );
        const [readerRejectedMs] = await Promise.all([
          Promise.race([interrupted, delay(8000, undefined, { ref: false })]),
          stopWhileReading(),
        ]);
        assert.ok(Number.isFinite(readerRejectedMs));
        await until("held upstream socket closed", () => heldSourceClosed);
        assert.ok(closed);
        return { ipc, firstBytes, readerRejectedMs, heldSourceClosed };
      }
      const bodies = await Promise.race([
        Promise.all(
          [0, 1].map(async (id) => {
            try {
              const result = await fetch.fetch("rehearsal-" + id, {
                url: fixtureUrl,
                method: "GET",
                headers: {},
                retry: false,
              });
              if (!result.response)
                return {
                  id,
                  status: result.status,
                  error: String(result.error).slice(0, 140),
                };
              const bytes = await result.response.arrayBuffer();
              const json = JSON.parse(new TextDecoder().decode(bytes));
              return {
                id,
                bytes: bytes.byteLength,
                nestedJsonValid:
                  typeof JSON.parse(json.statsigPayload).fixture === "string",
                sha256: createHash("sha256")
                  .update(new Uint8Array(bytes))
                  .digest("hex"),
              };
            } catch (error) {
              return { id, error: String(error).slice(0, 140) };
            }
          }),
        ),
        delay(30_000, [{ timeout: true }], { ref: false }),
      ]);
      return { ipc, bodies };
    } finally {
      if (transport) transport.close();
      ws.terminate();
      if (ws.readyState !== WebSocket.CLOSED)
        await once(ws, "close").catch(() => {});
    }
  }

  async function activate(release, label) {
    const next = path.join(root, "active-next");
    fs.symlinkSync(release, next);
    fs.renameSync(next, deploy.candidateDirectory);
    mode("normal");
    const env = {
      ...process.env,
      CODEX_API_BASE_URL: localUpstream,
      REHEARSAL_UPSTREAM_URL: localUpstream,
      NODE_OPTIONS: [
        "--require=" + fixturePreload,
        process.env.REHEARSAL_CAPTURE &&
          "--require=" + process.env.REHEARSAL_CAPTURE,
        process.env.REHEARSAL_MEMORY_DIRECTORY &&
          "--require=" + path.join(control, "rpc-memory-node.cjs"),
      ]
        .filter(Boolean)
        .join(" "),
    };
    if (release === "B") {
      env.CODEX_WEB_SHARED_TRANSPORT = "1";
      env.CODEX_WEB_TRANSPORT_METRICS = "1";
    }
    const launcher = own(
      label,
      process.execPath,
      [path.join(control, "launcher.cjs")],
      env,
    );
    await until(label + " listener", () => serving(bridgePort));
    const child = runtime();
    const configuration = managed(child);
    assert.equal(child.mode, "normal");
    assert.equal(
      fs.realpathSync(child.entrypoint),
      path.join(root, release, "src/server/main.js"),
    );
    const tlsHealth = await document();
    assert.equal(tlsHealth.status, 200);
    assert.ok(tlsHealth.verified);
    record(label + "-launch", {
      configuration,
      artifacts: artifactManifest(release),
      tls: tlsHealth,
    });
    return { launcher, child, configuration };
  }

  async function health(release, label) {
    memoryObserver?.phase(label + "-bootstrap");
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      const protocol = [];
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      cdp.on("Network.webSocketHandshakeResponseReceived", ({ response }) => {
        if (response.status === 101)
          protocol.push(
            Object.entries(response.headers).find(
              ([key]) => key.toLowerCase() === "sec-websocket-protocol",
            )?.[1] ?? "legacy",
          );
      });
      const result = await page.goto(origin, { waitUntil: "domcontentloaded" });
      memoryObserver?.phase(label + "-document-loaded");
      assert.equal(result.status(), 200);
      await page.waitForFunction(() => !!window.electronBridge);
      await until("browser WebSocket upgrade", () => protocol.length > 0);
      memoryObserver?.phase(label + "-fixture-transfer");
      assert.equal(
        protocol[0],
        release === "B" ? "codex-ipc-budget-v1" : "legacy",
      );
      const editor = page.locator('textarea, [contenteditable="true"]').first();
      const [{ ipc, bodies }, editorVisible] = await Promise.all([
        ipcProbe(release).then((result) => {
          memoryObserver?.phase(label + "-fixture-complete");
          return result;
        }),
        editor.waitFor({ state: "visible", timeout: 8000 }).then(
          () => true,
          () => false,
        ),
      ]);
      const bodyMatches =
        bodies.length === 2 &&
        bodies.every(
          (row) =>
            row.sha256 === expected &&
            row.bytes === sample.length &&
            row.nestedJsonValid,
        );
      assert.deepEqual(ipc, { ok: true, correctPath: true });
      assert.ok(bodyMatches, "Incomplete or corrupt fixture body");
      record(label + "-health", {
        protocol,
        ipc,
        editorVisible,
        bodies,
        upstreamHits,
        bodyMatches,
        ...(release === "B" && { processTree: processTree() }),
      });
      if (process.env.REHEARSAL_MEMORY_DIRECTORY) {
        await delay(30_000);
        record(label + "-settled", {});
      }
      return { editorVisible, bodies };
    } finally {
      await context.close();
    }
  }

  async function stop(active, label) {
    const done = once(active.launcher, "exit");
    mode("stop");
    const [code, signal] = await Promise.race([
      done,
      delay(8000, ["timeout"], { ref: false }),
    ]);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(!fs.existsSync(`/proc/${active.child.pid}`));
    assert.ok(!(await serving(bridgePort)));
    record(label + "-stop", {
      listenerReleased: true,
      childReaped: true,
      code,
    });
    if (process.env.REHEARSAL_MEMORY_DIRECTORY) {
      await delay(30_000);
      record(label + "-stop-settled", {});
    }
  }

  try {
    // Optional balanced memory-only order. The default still exercises crashes.
    if (process.env.REHEARSAL_MEMORY_ORDER) {
      assert.ok(memoryObserver, "Memory order requires isolated attribution");
      const order = process.env.REHEARSAL_MEMORY_ORDER.split(",");
      assert.ok(
        order.length >= 3 && order.every((arm) => ["A", "B"].includes(arm)),
      );
      assert.equal(order.at(-1), "A", "Always finish by restoring A");
      for (const [index, release] of order.entries()) {
        const label = `memory-${index}-${release}`;
        const active = await activate(release, label);
        await health(release, label);
        await stop(active, label);
      }
      record("rollback", {
        exactAArtifacts: artifactManifest("A"),
        memoryOrder: order,
      });
      assert.ok(
        Number(readMemory("memory.peak")) <= 1280 * 1024 * 1024,
        "Full stack exceeded the experimental 1,280 MiB acceptance ceiling",
      );
      for (const event of ["max", "oom", "oom_kill", "oom_group_kill"])
        assert.equal(readCounters("memory.events")[event], 0);
      return;
    }
    const a = await activate("A", "A-before");
    await health("A", "A-before");
    await stop(a, "A-before");
    const b = await activate("B", "B");
    await health("B", "B");
    const reconnect = await browser.newContext({ ignoreHTTPSErrors: true });
    const reconnectPage = await reconnect.newPage();
    const reconnectCdp = await reconnect.newCDPSession(reconnectPage);
    let upgrades = 0;
    let socketCloses = 0;
    await reconnectCdp.send("Network.enable");
    reconnectCdp.on(
      "Network.webSocketHandshakeResponseReceived",
      ({ response }) => {
        if (response.status === 101) upgrades++;
      },
    );
    reconnectCdp.on("Network.webSocketClosed", () => socketCloses++);
    await reconnectPage.goto(origin, { waitUntil: "domcontentloaded" });
    await until("pre-crash browser upgrade", () => upgrades > 0);
    const crashedAt = performance.now();
    let reloads = 0;
    reconnectPage.on("framenavigated", (frame) => {
      if (frame === reconnectPage.mainFrame()) reloads++;
    });
    const killed = runtime().pid;
    process.kill(killed, "SIGKILL");
    await until("crash reaped", () => !fs.existsSync(`/proc/${killed}`));
    await delay(1100);
    assert.ok(!(await serving(bridgePort)));
    assert.equal(runtime().pid, killed);
    mode("diagnostics");
    const recovered = await until(
      "mode-file crash recovery",
      () => runtime().pid !== killed && runtime(),
    );
    await until("recovered listener", () => serving(bridgePort));
    assert.equal(recovered.mode, "diagnostics");
    assert.equal((await document()).status, 200);
    await until(
      "browser reload after reconnect",
      () => reloads > 0 && upgrades > 1,
      10000,
    );
    const browserReloadedMs = performance.now() - crashedAt;
    await reconnectPage.waitForFunction(() => !!window.electronBridge);
    await reconnectPage.reload({ waitUntil: "domcontentloaded" });
    await until("post-crash browser upgrade", () => upgrades > 2);
    await reconnect.close();
    record("B-crash-recovery", {
      noAutomaticRestart: true,
      recoveredByModeTransition: true,
      browserReloaded: true,
      browserReloadedMs,
      upgrades,
      socketCloses,
      inheritedCgroup: managed(recovered).mode === "diagnostics",
    });
    const activeShutdown = await ipcProbe("B", () =>
      stop({ ...b, child: recovered }, "B"),
    );
    assert.deepEqual(activeShutdown.ipc, { ok: true, correctPath: true });
    record("B-active-stream-shutdown", activeShutdown);
    const after = await activate("A", "A-after");
    assert.deepEqual(after.configuration, a.configuration);
    assert.deepEqual(
      evidence.steps.find((s) => s.step === "A-after-launch").artifacts,
      evidence.steps.find((s) => s.step === "A-before-launch").artifacts,
    );
    await health("A", "A-after");
    await stop(after, "A-after");
    record("rollback", {
      exactRecordedArtifactsAndRuntime: true,
      upstreamHits,
    });
    assert.ok(
      Number(readMemory("memory.peak")) <= 1280 * 1024 * 1024,
      "Full stack exceeded the experimental 1,280 MiB acceptance ceiling",
    );
    const memoryEvents = readCounters("memory.events");
    for (const event of ["max", "oom", "oom_kill", "oom_group_kill"])
      assert.equal(memoryEvents[event], 0);
  } finally {
    await browser.close();
    relay.close();
    upstream.close();
    initialize.stdin.end();
    if (appLog.exitCode === null && appLog.signalCode === null) {
      const done = once(appLog, "exit");
      appLog.kill("SIGTERM");
      await done;
    }
    if (memoryObserver) {
      await delay(1000);
      record("cleanup", {
        browserClosed: true,
        appServerReaped: appLog.exitCode !== null || appLog.signalCode !== null,
      });
    }
  }
}

main()
  .catch((error) => {
    evidence.error = String(error);
    process.exitCode = 1;
    console.error(error);
  })
  .finally(() => {
    clearInterval(memorySampler);
    memoryObserver?.close();
    for (const child of children) child.kill("SIGKILL");
    if (fs.existsSync(memory + "/memory.peak")) {
      evidence.memory = {
        peak: Number(readMemory("memory.peak")),
        events: readCounters("memory.events"),
      };
    }
    save();
  });
