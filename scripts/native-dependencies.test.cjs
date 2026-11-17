// Run after npm run build:server.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const root = path.resolve(__dirname, "..");

function fixture(t, source, pnpm = false) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-dependencies-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "src/server"), { recursive: true });
  for (const file of [
    "main.js",
    "native-dependencies.js",
    "module.js",
    "static-assets.js",
  ]) {
    fs.copyFileSync(
      path.join(root, "src/server", file),
      path.join(directory, "src/server", file),
    );
  }
  fs.cpSync(
    path.join(root, "src/server/diagnostics"),
    path.join(directory, "src/server/diagnostics"),
    { recursive: true },
  );
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(directory, "node_modules"),
  );
  const app = path.join(directory, "scratch/asar");
  fs.mkdirSync(path.join(app, "node_modules/better-sqlite3"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  const sqlite = path.join(app, "node_modules/better-sqlite3");
  if (pnpm) {
    const target = path.join(
      app,
      "node_modules/.pnpm/better-sqlite3/node_modules/better-sqlite3",
    );
    fs.mkdirSync(target, { recursive: true });
    fs.rmdirSync(sqlite);
    fs.symlinkSync(target, sqlite);
  }
  fs.writeFileSync(path.join(sqlite, "index.js"), source);
  const marker = path.join(directory, "listen-attempt");
  const guard = path.join(directory, "guard.cjs");
  fs.writeFileSync(
    guard,
    `require('node:net').Server.prototype.listen = function () { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'attempt'); throw Error('HTTP listen attempted'); };`,
  );
  return { directory, app, sqlite, marker, guard };
}

function run(f, args = [], validateOnly = false) {
  return spawnSync(
    process.execPath,
    [
      "--require",
      f.guard,
      ...(validateOnly
        ? [
            "-e",
            `require(${JSON.stringify(path.join(f.directory, "src/server/native-dependencies.js"))}).validateNativeDependencies()`,
          ]
        : [path.join(f.directory, "src/server/main.js"), ...args]),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, npm_config_user_agent: "pnpm/10.34.9" },
    },
  );
}

// The fixture app has its own SQLite, proving resolution uses the app context.
for (const fail of [false, true]) {
  test(`closes database after ${fail ? "query failure" : "successful SELECT 1"}`, (t) => {
    const f = fixture(
      t,
      `module.exports = class {
      constructor(name) { require('node:assert/strict').equal(name, ':memory:'); }
      prepare(sql) { require('node:assert/strict').match(sql, /^SELECT 1/); return { get() { ${fail ? "throw Error('query failed')" : "return {value: 1}"}; } }; }
      close() { require('node:fs').writeFileSync(require('node:path').join(__dirname, 'closed'), 'yes'); }
    };`,
    );
    const result = run(f, [], true);
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.sqlite, "closed"), "utf8"), "yes");
    if (fail) assert.match(result.stderr, /query failed/);
  });
}

for (const kind of ["missing", "incompatible"]) {
  test(`${kind} real native binding exits before HTTP listen`, (t) => {
    const f = fixture(t, "", true);
    // Copy just the JS library, without its native build, into the app context.
    const library = path.dirname(
      require.resolve("better-sqlite3/package.json"),
    );
    fs.cpSync(path.join(library, "lib"), path.join(f.sqlite, "lib"), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(library, "package.json"),
      path.join(f.sqlite, "package.json"),
    );
    for (const dependency of ["bindings", "file-uri-to-path"]) {
      const resolved = require.resolve(dependency, { paths: [library] });
      fs.symlinkSync(
        path.dirname(
          require.resolve(`${dependency}/package.json`, {
            paths: [path.dirname(resolved)],
          }),
        ),
        path.join(f.app, "node_modules", dependency),
      );
    }
    if (kind === "incompatible") {
      fs.mkdirSync(path.join(f.sqlite, "build/Release"), { recursive: true });
      fs.writeFileSync(
        path.join(f.sqlite, "build/Release/better_sqlite3.node"),
        "not a native binary",
      );
    }
    const result = run(f);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      kind === "missing"
        ? /Could not locate the bindings file/
        : /file too short|invalid ELF|not a valid|dlopen/i,
    );
    assert.match(
      result.stderr,
      new RegExp(process.version.replaceAll(".", "\\.")),
    );
    assert.match(result.stderr, /pnpm rebuild better-sqlite3/);
    assert.equal(
      (result.stderr.match(/SQLite native dependency validation failed/g) || [])
        .length,
      1,
    );
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(f.marker), false);
    const help = run(f, ["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    assert.equal(help.stderr, "");
  });
}

test("npm installation reports npm repair even when launched by pnpm", (t) => {
  const f = fixture(t, "throw Error('module missing')");
  // Give this fixture an npm layout independent of the checkout's pnpm metadata.
  fs.unlinkSync(path.join(f.directory, "node_modules"));
  fs.mkdirSync(path.join(f.directory, "node_modules"));
  const result = run(f, [], true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm rebuild better-sqlite3/);
  assert.doesNotMatch(result.stderr, /pnpm rebuild/);
});

test("installed native binding executes SELECT 1", () => {
  require("../src/server/native-dependencies.js").validateNativeDependencies();
});
