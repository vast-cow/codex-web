const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { minifyWebview } = require("../scripts/minify-webview.cjs");
const { prepare } = require("../scripts/precompress.cjs");

test("conservative transform preserves module behavior and excludes mutable URL", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webview-minify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const name = "app-initial-012345abcdef.js";
  const file = path.join(root, "assets", name);
  await fs.writeFile(
    path.join(root, "assets", "lazy.js"),
    "export const value = 42;",
  );
  await fs.writeFile(
    file,
    `
    /*! retained license */
    export function reflectedName() { return reflectedName.name; }
    export async function lazy() { return (await import('./lazy.js')).value; }
    export const literal = ' spaces remain ';
  `,
  );
  for (const suffix of [".map", ".br", ".gz"])
    await fs.writeFile(file + suffix, "stale");
  const report = await minifyWebview(root);
  assert.ok(report.after < report.before);
  const mod = await import(pathToFileURL(file).href);
  assert.equal(mod.reflectedName(), "reflectedName");
  assert.equal(await mod.lazy(), 42);
  assert.equal(mod.literal, " spaces remain ");
  assert.match(await fs.readFile(file, "utf8"), /retained license/);
  for (const suffix of [".map", ".br", ".gz"])
    await assert.rejects(fs.access(file + suffix));
  await prepare(root);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(root, ".immutable-assets.json"), "utf8"),
    ),
    [],
  );
});

test("invalid JS fails without overwriting the input", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webview-minify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "assets"));
  const file = path.join(root, "assets", "app-initial-012345abcdef.js");
  await fs.writeFile(file, "export const = ;");
  await assert.rejects(minifyWebview(root));
  assert.equal(await fs.readFile(file, "utf8"), "export const = ;");
});
