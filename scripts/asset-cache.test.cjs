const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { prepareAssets } = require("./prepare-assets.cjs");
const { precompress } = require("./precompress-assets.cjs");

test("Desktop preparation reuses immutable inputs, restores live output, and invalidates safely", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = process.env.HOSTED_CODEX_APP_ZIP;
  t.after(() => {
    if (archive === undefined) delete process.env.HOSTED_CODEX_APP_ZIP;
    else process.env.HOSTED_CODEX_APP_ZIP = archive;
  });
  process.env.HOSTED_CODEX_APP_ZIP = path.join(root, "app.zip");
  for (const name of [
    "assets",
    "patches",
    "scripts/diagnostics",
    "src/browser",
    "src/server",
  ])
    await fs.mkdir(path.join(root, name), { recursive: true });
  for (const name of [
    "app.zip",
    "package.json",
    "package-lock.json",
    "assets/icon.png",
    "patches/app.patch",
    "scripts/prepare-asar-uncached",
    "scripts/prepare-assets.cjs",
    "scripts/asset-cache.cjs",
    "scripts/diagnostics/instrument-rpc.cjs",
    "scripts/diagnostics/rpc-runtime.cjs",
  ])
    await fs.writeFile(path.join(root, name), name);
  let runs = 0;
  let fail = false;
  let extra = true;
  const processAssets = async (output) => {
    runs++;
    await fs.mkdir(path.join(output, "webview/assets"), { recursive: true });
    await fs.writeFile(
      path.join(output, "webview/assets/icon.png"),
      "processed original",
    );
    if (extra) await fs.writeFile(path.join(output, "obsolete.js"), "obsolete");
    if (fail) throw new Error("injected processing failure");
  };
  const run = (force = false) => prepareAssets({ root, processAssets, force });
  const icon = path.join(root, "scratch/asar/webview/assets/icon.png");
  const metadata = path.join(root, "scratch/asset-cache/desktop.json");
  await run();
  assert.equal(await fs.readFile(icon, "utf8"), "processed original");
  await run();
  assert.equal(runs, 1);
  for (const name of [
    "src/server/main.ts",
    "src/browser/shim.ts",
    "scratch/asar/webview/assets/preload.js",
  ])
    await fs.writeFile(path.join(root, name), "wrapper change");
  await run();
  assert.equal(runs, 1);
  // Missing or overwritten live files are restored from the immutable snapshot.
  await fs.rm(icon);
  await run();
  await fs.writeFile(icon, "already transformed");
  await run();
  assert.equal(await fs.readFile(icon, "utf8"), "processed original");
  assert.equal(runs, 1);
  for (const name of [
    "assets/icon.png",
    "patches/app.patch",
    "scripts/prepare-asar-uncached",
    "scripts/diagnostics/instrument-rpc.cjs",
    "scripts/diagnostics/rpc-runtime.cjs",
    "package-lock.json",
    "app.zip",
  ]) {
    await fs.appendFile(path.join(root, name), "change");
    const before = runs;
    await run();
    assert.equal(runs, before + 1);
  }
  await fs.rm(
    path.join(root, "scratch/asset-cache/desktop/asar/webview/assets/icon.png"),
  );
  const before = runs;
  await run();
  assert.equal(runs, before + 1);
  await run(true);
  assert.equal(runs, before + 2);
  fail = true;
  await assert.rejects(run(true), /injected processing failure/);
  await assert.rejects(fs.access(metadata), { code: "ENOENT" });
  fail = false;
  const failedRuns = runs;
  await run();
  assert.equal(runs, failedRuns + 1);
  extra = false;
  await run(true);
  await assert.rejects(fs.access(path.join(root, "scratch/asar/obsolete.js")), {
    code: "ENOENT",
  });
  assert.equal(
    await fs.readFile(
      path.join(root, "scratch/asar/webview/assets/preload.js"),
      "utf8",
    ),
    "wrapper change",
  );
});

test("compression reuses content, regenerates changed/missing/corrupt outputs, and invalidates failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compression-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await fs.mkdir(assets);
  const source = path.join(assets, "app.js");
  const cacheFile = path.join(root, "cache.json");
  const run = (force = false) => precompress(assets, { cacheFile, force });
  await fs.writeFile(source, "let value = 1;".repeat(100));
  await run();
  const original = await fs.readFile(source + ".br");
  // A stable output inode demonstrates no compression/write on reuse.
  const inode = (await fs.stat(source + ".br")).ino;
  await fs.writeFile(source, await fs.readFile(source));
  await run();
  assert.equal((await fs.stat(source + ".br")).ino, inode);
  await fs.appendFile(source, "// changed");
  await run();
  assert.notDeepEqual(await fs.readFile(source + ".br"), original);
  await fs.rm(source + ".gz");
  await run();
  await fs.writeFile(source + ".br", "corrupt");
  await run();
  assert.notEqual(await fs.readFile(source + ".br", "utf8"), "corrupt");
  await run(true);
  // A directory in place of an output causes a write failure after invalidation.
  await fs.rm(source + ".gz");
  await fs.mkdir(source + ".gz");
  await assert.rejects(run(true), /gzip write failed/);
  await assert.rejects(fs.access(cacheFile), { code: "ENOENT" });
  await fs.rm(source + ".gz", { recursive: true });
  await run();
  assert.ok(await fs.readFile(cacheFile));
});
