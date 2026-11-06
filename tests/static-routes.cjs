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

test("precompressed representations, validators, ranges and mutable rebuilds", async (t) => {
  const { precompress } = require("../scripts/precompress.cjs");
  const { brotliDecompressSync, gunzipSync } = require("node:zlib");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compressed-static-"));
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "assets"));
  const body = Buffer.from(
    'const example = "repeatable asset";\n'.repeat(2000),
  );
  const url = "/assets/example-012345abcdef.js";
  await fs.writeFile(path.join(root, url), body);
  await fs.writeFile(path.join(root, "index.html"), "<html>SPA</html>");
  await fs.writeFile(path.join(root, "preload.js"), body);
  await precompress(root);
  await fs.writeFile(
    path.join(root, ".immutable-assets.json"),
    JSON.stringify([url.slice(1)]),
  );
  await registerStaticRoutes(app, root, () => {});
  const tags = new Set();
  for (const [encoding, decode] of [
    ["identity", (x) => x],
    ["br", brotliDecompressSync],
    ["gzip", gunzipSync],
  ]) {
    const headers = { "accept-encoding": encoding };
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(decode(response.rawPayload), body);
    assert.equal(
      response.headers["content-encoding"],
      encoding === "identity" ? undefined : encoding,
    );
    assert.equal(
      Number(response.headers["content-length"]),
      response.rawPayload.length,
    );
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.match(
      response.headers["cache-control"],
      /max-age=31536000, immutable/,
    );
    tags.add(response.headers.etag);
    const cached = await app.inject({
      url,
      headers: { ...headers, "if-none-match": response.headers.etag },
    });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.rawPayload.length, 0);
    assert.equal(cached.headers.vary, "Accept-Encoding");
    const head = await app.inject({ method: "HEAD", url, headers });
    assert.equal(
      head.headers["content-length"],
      response.headers["content-length"],
    );
    assert.equal(head.rawPayload.length, 0);
    const partial = await app.inject({
      url,
      headers: { ...headers, range: "bytes=2-9" },
    });
    assert.equal(partial.statusCode, 206);
    assert.deepEqual(partial.rawPayload, response.rawPayload.subarray(2, 10));
    assert.equal(
      partial.headers["content-range"],
      `bytes 2-9/${response.rawPayload.length}`,
    );
    assert.equal(partial.headers["content-length"], "8");
    assert.equal(
      (
        await app.inject({
          url,
          headers: { ...headers, range: "bytes=99999999-" },
        })
      ).statusCode,
      416,
    );
    assert.equal(
      (
        await app.inject({
          url,
          headers: { ...headers, range: "bytes=2-9", "if-range": '"obsolete"' },
        })
      ).statusCode,
      200,
    );
  }
  assert.equal(tags.size, 3);
  const negotiated = await app.inject({
    url,
    headers: { "accept-encoding": "br, gzip" },
  });
  assert.equal(negotiated.headers["content-encoding"], "br");
  assert.equal(
    (await app.inject({ url, headers: { "accept-encoding": "br;q=0, gzip" } }))
      .headers["content-encoding"],
    "gzip",
  );
  for (const mutable of ["/", "/thread/test", "/preload.js"]) {
    assert.equal(
      (await app.inject(mutable)).headers["cache-control"],
      "no-cache",
    );
  }
  await fs.writeFile(path.join(root, "preload.js"), "updated");
  await precompress(root);
  const updated = await app.inject({
    url: "/preload.js",
    headers: { "accept-encoding": "br, gzip" },
  });
  assert.equal(updated.body, "updated");
  assert.equal(updated.headers["content-encoding"], undefined);
});

test("build metadata excludes patched upstream hashes", async (t) => {
  const { prepare } = require("../scripts/precompress.cjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asset-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "assets"));
  for (const name of [
    "example-012345abcdef.js",
    "app-shared-8bd9d0399038.js",
    "preload.js",
  ]) {
    await fs.writeFile(path.join(root, "assets", name), "example");
  }
  await prepare(root);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(root, ".immutable-assets.json"), "utf8"),
    ),
    ["assets/example-012345abcdef.js"],
  );
});
