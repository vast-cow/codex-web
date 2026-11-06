const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");
const { registerStaticRoutes } = require("../src/server/staticRoutes.js");
const { createLogger } = require("../src/server/diagnostics/core.js");

test("built static routes, navigation, backend isolation and safe diagnostics", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "static-routes-"));
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "index.html"), "<html>SPA</html>");
  await fs.writeFile(path.join(root, "private.js"), "export {};");
  await fs.writeFile(path.join(root, "private.css"), "body {}");
  const rows = [];
  const logger = createLogger("server", "debug", (row) => rows.push(row));
  app.post("/__backend/upload", async () => ({ ok: true }));
  await registerStaticRoutes(app, root, logger.log);
  for (const [url, type] of [
    ["/private.js?secret=1", /javascript/],
    ["/private.css", /css/],
  ]) {
    const reply = await app.inject(url);
    assert.equal(reply.statusCode, 200);
    assert.match(reply.headers["content-type"], type);
  }
  for (const url of [
    "/missing.js",
    "/missing.css?v=1",
    "/missing.map?x=.js",
    "/missing%2Ejs",
    "/thread/missing.js",
    "/__backend/missing",
    "/api/unknown",
    "/unknown",
    "/@fs/nonexistent-codex-test-file?x=1",
  ]) {
    const reply = await app.inject(url);
    assert.equal(reply.statusCode, 404, url);
    assert.doesNotMatch(reply.headers["content-type"], /html/);
  }
  for (const url of [
    "/",
    "/?file=missing.js",
    "/thread/id",
    "/thread/id?refresh=1",
    "/thread/another-id",
    "/share/receive?text=private",
  ]) {
    const reply = await app.inject(url);
    assert.equal(reply.statusCode, 200, url);
    assert.match(reply.headers["content-type"], /html/);
    assert.equal(reply.body, "<html>SPA</html>");
  }
  assert.equal(
    (await app.inject({ method: "POST", url: "/thread/id" })).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/__backend/upload" })).statusCode,
    200,
  );
  const responses = rows.filter((row) => row.event === "http.response");
  for (const asset of ["javascript", "css", "source-map"]) {
    assert.ok(
      responses.some(
        (row) => row.asset === asset && row.action === "not-found",
      ),
    );
  }
  assert.ok(
    responses.some((row) => row.action === "static-response" && row.bytes > 0),
  );
  assert.ok(responses.some((row) => row.action === "spa-fallback"));
  assert.ok(responses.every((row) => row.durationMs >= 0));
  assert.doesNotMatch(
    JSON.stringify(rows),
    /private|secret|nonexistent|static-routes-/,
  );
});
