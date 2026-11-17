#!/usr/bin/env node
// Run build:server first. Supply a directory containing the real JS/CSS assets.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gunzipSync, brotliDecompressSync } = require("node:zlib");
const Fastify = require("fastify");
const staticPlugin = require("@fastify/static");
const { staticAssetDelivery } = require("../../src/server/static-assets.js");
const root = path.resolve(process.argv[2]);
(async () => {
  const app = Fastify();
  await app.register(staticPlugin, { ...staticAssetDelivery, root });
  const results = [];
  try {
    for (const file of fs
      .readdirSync(root)
      .filter((f) => /\.(js|css)$/.test(f))) {
      const original = fs.readFileSync(path.join(root, file));
      const representations = {};
      for (const [accept, encoding] of [
        ["br, gzip", "br"],
        ["gzip", "gzip"],
        ["identity", undefined],
        ["br;q=0, gzip;q=1", "gzip"],
        ["br;q=0,gzip;q=0", undefined],
      ]) {
        const response = await app.inject({
          url: "/" + file,
          headers: { "accept-encoding": accept },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["content-encoding"], encoding);
        assert.match(response.headers["vary"], /Accept-Encoding/i);
        assert.match(
          response.headers["content-type"],
          file.endsWith(".css") ? /text\/css/ : /javascript/,
        );
        const raw = response.rawPayload;
        assert.equal(Number(response.headers["content-length"]), raw.length);
        const decoded =
          encoding === "br"
            ? brotliDecompressSync(raw)
            : encoding === "gzip"
              ? gunzipSync(raw)
              : raw;
        assert.deepEqual(decoded, original);
        const cached = await app.inject({
          url: "/" + file,
          headers: {
            "accept-encoding": accept,
            "if-none-match": response.headers.etag,
          },
        });
        assert.equal(cached.statusCode, 304);
        assert.equal(cached.rawPayload.length, 0);
        assert.match(cached.headers.vary, /Accept-Encoding/i);
        assert.equal(cached.headers.etag, response.headers.etag);
        const modified = await app.inject({
          url: "/" + file,
          headers: {
            "accept-encoding": accept,
            "if-modified-since": response.headers["last-modified"],
          },
        });
        assert.equal(modified.statusCode, 304);
        representations[encoding || "identity"] = {
          bytes: raw.length,
          etag: response.headers.etag,
          lastModified: response.headers["last-modified"],
        };
      }
      for (const encoding of ["br", "gzip"]) {
        assert.notEqual(
          representations[encoding].etag,
          representations.identity.etag,
        );
        const cross = await app.inject({
          url: "/" + file,
          headers: {
            "accept-encoding": "identity",
            "if-none-match": representations[encoding].etag,
          },
        });
        assert.equal(cross.statusCode, 200);
      }
      results.push({
        file,
        sha256: createHash("sha256").update(original).digest("hex"),
        representations,
      });
    }
    assert(
      results.some(
        (r) =>
          r.file.startsWith("app-shared-") &&
          r.representations.identity.bytes === 12152991,
      ),
      "Supply the recorded large shared asset",
    );
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
