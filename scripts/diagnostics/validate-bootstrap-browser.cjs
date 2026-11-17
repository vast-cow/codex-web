// Run with CODEX_BOOTSTRAP_DIAGNOSTICS=1 after build:server.
const r = require;
const Fastify = r("fastify"),
  staticPlugin = r("@fastify/static"),
  { WebSocketServer } = r("ws");
const { createBootstrapSender } = r(
  "../../src/server/diagnostics/bootstrap.js",
);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("assert/strict");
(async () => {
  const root = require("node:fs").mkdtempSync(
    require("node:os").tmpdir() + "/bootstrap-browser-",
  );
  const { build } = await import("vite");
  await build({
    configFile: false,
    define: {
      "process.env.NODE_ENV": '"production"',
      __CODEX_APP_VERSION__: '"diagnostic-test"',
    },
    build: {
      outDir: root,
      lib: {
        entry: require("node:path").resolve(
          __dirname,
          "../../src/browser/shim.ts",
        ),
        formats: ["es"],
        fileName: () => "shim.js",
      },
      minify: false,
    },
  });
  const app = Fastify();
  await app.register(staticPlugin, { root });
  app.get("/", (_, reply) =>
    reply
      .type("text/html")
      .send('<script type="module" src="/shim.js"></script>'),
  );
  const wss = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => {
      const send = createBootstrapSender(ws);
      send({
        type: "message-port-message",
        portId: "p",
        data: [
          "resolve",
          17,
          {
            response: [
              "response",
              ["readable", 10],
              { headers: [["x-codex-bootstrap-trace", "browser-fixture"]] },
            ],
          },
        ],
      });
      send({
        type: "message-port-message",
        portId: "p",
        data: ["stream", ["readable", 10, ["write"], [["bytes", "YWJj"]]]],
      });
      send({
        type: "message-port-message",
        portId: "p",
        data: ["stream", ["readable", 10, ["close"]]],
      });
    }),
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage(),
      logs = [],
      errors = [];
    page.on("console", (msg) => {
      if (msg.text().startsWith("[bootstrap-delivery]"))
        logs.push(JSON.parse(msg.text().slice("[bootstrap-delivery] ".length)));
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.server.address().port}`);
    await page.waitForTimeout(800);
    assert.deepEqual(errors, []);
    assert.equal(logs.filter((l) => l.event === "browser-receipt").length, 3);
    assert.equal(
      logs.findLast((l) => l.event === "browser-receipt").operation,
      "close",
    );
    assert.equal(
      logs.findLast((l) => l.event === "browser-receipt").totalBytes,
      3,
    );
    console.log(JSON.stringify({ passed: true, logs }, null, 2));
  } finally {
    await browser.close();
    wss.close();
    await app.close();
    require("node:fs").rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
