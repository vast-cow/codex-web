const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");

test("Vite development navigation, assets, HTTP and WebSocket proxies", async (t) => {
  const { createServer, loadConfigFromFile } = await import("vite");
  const backend = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, method: req.method }));
  });
  const sockets = new WebSocketServer({ server: backend });
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => socket.send(data)),
  );
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => {
    sockets.close();
    backend.close();
  });
  const { config } = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    "vite.browser.config.ts",
  );
  assert.equal(config.server.proxy["/__backend/ipc"].ws, true);
  const target = `http://127.0.0.1:${backend.address().port}`;
  config.server.proxy["/__backend/ipc"].target = target;
  config.server.proxy["/__backend/upload"].target = target;
  const vite = await createServer({
    ...config,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, port: 0, open: false },
  });
  t.after(() => vite.close());
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  for (const url of [
    "/",
    "/thread/test?refresh=1",
    "/share/receive?text=test",
  ]) {
    const response = await fetch(base + url, {
      headers: { accept: "text/html" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /html/);
  }
  const client = await fetch(base + "/@vite/client");
  assert.equal(client.status, 200);
  assert.match(client.headers.get("content-type"), /javascript/);
  for (const url of [
    "/missing.js?x=1",
    "/missing.css",
    "/missing.map",
    "/api/unknown",
    "/__backend/unknown",
    "/unknown",
    "/@fs/nonexistent-codex-test-file",
  ]) {
    const response = await fetch(base + url, { headers: { accept: "*/*" } });
    assert.equal(response.status, 404, url);
  }
  const upload = await fetch(base + "/__backend/upload", { method: "POST" });
  assert.deepEqual(await upload.json(), {
    url: "/__backend/upload",
    method: "POST",
  });
  const socket = new WebSocket(base.replace("http:", "ws:") + "/__backend/ipc");
  t.after(() => socket.terminate());
  await once(socket, "open");
  socket.send("proxy-check");
  const [message] = await once(socket, "message");
  assert.equal(message.toString(), "proxy-check");
  socket.close();
  await once(socket, "close");
});
