#!/usr/bin/env node
// CODEX_BOOTSTRAP_DIAGNOSTICS=1 node ... after build:server.
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { WebSocketServer, WebSocket } = require("ws");
const {
  diagnosticFetch,
  withBootstrapRequest,
  createBootstrapSender,
} = require("../../src/server/diagnostics/bootstrap.js");
assert.equal(process.env.CODEX_BOOTSTRAP_DIAGNOSTICS, "1");
const records = [];
const originalError = console.error;
console.error = (line) => {
  try {
    records.push(JSON.parse(line));
  } catch {
    originalError(line);
  }
};
(async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "secret=never-log",
    });
    res.write("first");
    setTimeout(() => res.end("second"), 60);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const connected = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const received = [];
  client.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "bootstrap-clock")
      client.send(
        JSON.stringify({
          type: "bootstrap-clock-reply",
          probeId: m.probeId,
          browserMs: performance.now(),
          timeOrigin: performance.timeOrigin,
        }),
      );
    else received.push(m);
  });
  const [socket] = await connected;
  const send = createBootstrapSender(socket);
  try {
    const requestId = "diagnostic-fixture";
    const response = await withBootstrapRequest(
      {
        data: [
          "push",
          [
            "pipeline",
            -1,
            ["fetch"],
            [requestId, { url: "/wham/statsig/bootstrap" }],
          ],
        ],
      },
      () =>
        diagnosticFetch(
          `http://127.0.0.1:${upstream.address().port}/wham/statsig/bootstrap`,
        ),
    );
    assert.equal(response.headers.get("x-codex-bootstrap-trace"), requestId);
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
            { headers: [...response.headers] },
          ],
        },
      ],
    });
    const reader = response.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      send({
        type: "message-port-message",
        portId: "p",
        data: [
          "stream",
          [
            "readable",
            10,
            ["write"],
            [["bytes", Buffer.from(value).toString("base64url")]],
          ],
        ],
      });
    }
    send({
      type: "message-port-message",
      portId: "p",
      data: ["stream", ["readable", 10, ["close"]]],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(total, 11);
    assert.equal(received.at(-1).bootstrapTrace.operation, "close");
    assert.equal(received.at(-1).bootstrapTrace.totalBytes, 11);
    assert.deepEqual(
      received.map((m) => m.bootstrapTrace.sequence),
      [-1, 0, 1, 2],
    );
    assert.equal(
      records.find((r) => r.event === "upstream-start").correlated,
      true,
    );
    assert.equal(
      records.find((r) => r.event === "upstream-end").totalBytes,
      11,
    );
    assert(records.some((r) => r.event === "clock-sample"));
    assert.equal(
      records.filter((r) => r.event === "local-write-complete").length,
      4,
    );
    assert(!JSON.stringify(records).includes("secret"));
    const writes = records.filter((r) => r.event === "upstream-read");
    assert(writes[1].hostMs - writes[0].hostMs >= 30);
    const cancelled = await diagnosticFetch(
      `http://127.0.0.1:${upstream.address().port}/wham/statsig/bootstrap`,
    );
    await cancelled.body.cancel();
    assert(records.some((r) => r.event === "upstream-cancel"));
    console.log(
      JSON.stringify({ passed: true, totalBytes: total, records }, null, 2),
    );
  } finally {
    client.close();
    await once(client, "close");
    await new Promise((resolve) => server.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    console.error = originalError;
  }
})().catch((error) => {
  originalError(error);
  process.exitCode = 1;
});
