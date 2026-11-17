const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { gzipSync, brotliCompressSync, constants } = require("node:zlib");

const script = path.join(__dirname, "precompress-assets.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "precompress-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function run(root, { tty = false, columns = 100, failure, slow = false } = {}) {
  // Exercise the exported API in an isolated process; instrument timers so an
  // unref'ed but uncleared interval cannot pass the cleanup checks unnoticed.
  const code = `
    const active = new Set();
    const originalSet = global.setInterval;
    const originalClear = global.clearInterval;
    global.setInterval = (...args) => {
      const timer = originalSet(...args);
      active.add(timer);
      return timer;
    };
    global.clearInterval = timer => {
      active.delete(timer);
      originalClear(timer);
    };
    Object.defineProperties(process.stdout, {
      isTTY: { value: ${tty} }, columns: { value: ${columns} }
    });
    const zlib = require('node:zlib');
    const gzip = zlib.gzip;
    zlib.gzip = (source, options, callback) => {
      const finish = () => ${failure === "gzip" ? "callback(new Error('injected compression failure'))" : "gzip(source, options, callback)"};
      ${slow ? "setTimeout(finish, 350)" : "finish()"};
    };
    const fs = require('node:fs/promises');
    ${["readFile", "writeFile", "stat", "utimes"].includes(failure) ? `fs.${failure} = async () => { throw new Error('injected ${failure} failure'); };` : ""}
    require(${JSON.stringify(script)}).precompress(${JSON.stringify(root)})
      .catch(error => { console.error(error.message); process.exitCode = 1; })
      .finally(() => { console.error('active timers: ' + active.size); });
  `;
  const result = spawnSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.match(result.stderr, /active timers: 0/);
  return result;
}

function frames(stdout) {
  return [...stdout.matchAll(/\x1b\[1G\x1b\[2K([^\x1b\n]*)/g)].map(
    (match) => match[1],
  );
}

test("redirected output is concise and compression bytes and timestamps are preserved", async (t) => {
  const root = await fixture(t);
  const source = Buffer.from("const asset = 'example';\n".repeat(1000));
  const timestamp = new Date("2020-01-02T03:04:05Z");
  for (const file of ["example.js", "style.css"]) {
    await fs.writeFile(path.join(root, file), source);
    await fs.utimes(path.join(root, file), timestamp, timestamp);
  }
  await fs.writeFile(path.join(root, "ignored.js.map"), source);
  const result = run(root);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim().split("\n").length, 2);
  assert.doesNotMatch(result.stdout, /\x1b|starting gzip|original|completed/);
  for (const file of ["example.js", "style.css"]) {
    for (const [suffix, expected] of [
      [".gz", gzipSync(source, { level: 9 })],
      [
        ".br",
        brotliCompressSync(source, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
        }),
      ],
    ]) {
      const output = path.join(root, file + suffix);
      assert.deepEqual(await fs.readFile(output), expected);
      assert.equal((await fs.stat(output)).mtimeMs, timestamp.getTime());
      // Reading the artifact updates atime, so compare source/output after a rerun below.
    }
  }
  assert.equal(run(root).status, 0);
  for (const file of ["example.js", "style.css"]) {
    const sourceStat = await fs.stat(path.join(root, file));
    for (const suffix of [".gz", ".br"]) {
      assert.ok(
        Math.abs(
          (await fs.stat(path.join(root, file + suffix))).atimeMs -
            sourceStat.atimeMs,
        ) <= 1,
      );
    }
  }
  assert.deepEqual((await fs.readdir(root)).sort(), [
    "example.js",
    "example.js.br",
    "example.js.gz",
    "ignored.js.map",
    "style.css",
    "style.css.br",
    "style.css.gz",
  ]);
});

test("TTY redraws one cleared line, refreshes elapsed time, and fits long paths", async (t) => {
  const root = await fixture(t);
  const directory = "界".repeat(40);
  await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, directory, "long-asset.js"), "let x = 1;");
  await fs.writeFile(path.join(root, "z.js"), "let y = 2;");
  const result = run(root, { tty: true, columns: 80, slow: true });
  assert.equal(result.status, 0);
  const updates = frames(result.stdout);
  assert.ok(updates.length >= 8);
  assert.ok(updates.some((line) => /1\/2.*gzip.*elapsed 0\.0s/.test(line)));
  assert.ok(updates.some((line) => /1\/2.*gzip.*elapsed 0\.[123]s/.test(line)));
  assert.ok(updates.some((line) => /brotli/.test(line)));
  assert.ok(updates.some((line) => /z\.js/.test(line)));
  assert.ok(updates.some((line) => /\.\.\./.test(line)));
  for (const line of updates) {
    assert.ok(
      [...line].reduce(
        (width, char) => width + (char.codePointAt(0) > 0x7e ? 2 : 1),
        0,
      ) <= 79,
    );
  }
  assert.match(
    result.stdout,
    /elapsed [\d.]+s\n\[precompress\] Processed 2 files/,
  );
  const narrow = run(root, { tty: true, columns: 20 });
  assert.ok(frames(narrow.stdout).every((line) => line.length <= 19));
});

test("empty directories and scan failures have no live display", async (t) => {
  const root = await fixture(t);
  for (const tty of [true, false]) {
    const empty = run(root, { tty });
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /No eligible files/);
    assert.doesNotMatch(empty.stdout, /\x1b/);
    const missing = run(path.join(root, "missing"), { tty });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing: scan failed/);
    assert.doesNotMatch(missing.stdout, /\x1b/);
  }
});

test("failures retain path and stage, clear timers, and finish the live line", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "example.js"), "let x = 1;");
  for (const tty of [true, false]) {
    for (const [failure, stage] of [
      ["readFile", "read source"],
      ["gzip", "gzip compression"],
      ["writeFile", "gzip write"],
      ["stat", "gzip timestamp preservation"],
      ["utimes", "gzip timestamp preservation"],
    ]) {
      const result = run(root, { tty, failure, slow: true });
      assert.equal(result.status, 1);
      assert.ok(
        result.stderr.includes(
          `${path.join(root, "example.js")}: ${stage} failed:`,
        ),
      );
      assert.doesNotMatch(result.stdout, /Processed/);
      if (tty && failure !== "readFile")
        assert.match(result.stdout, /elapsed [\d.]+s\n$/);
      else assert.doesNotMatch(result.stdout, /\x1b/);
    }
  }
});

test("CLI accepts a target directory and retains success/failure exit codes", async (t) => {
  const root = await fixture(t);
  for (const [target, status] of [
    [root, 0],
    [path.join(root, "missing"), 1],
  ]) {
    const result = spawnSync(process.execPath, [script, target], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, status);
    assert.doesNotMatch(result.stdout + result.stderr, /\x1b/);
  }
});
