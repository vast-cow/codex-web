const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("memory preload publishes atomic, separate metadata for main and worker heaps", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-memory-hook-"));
  const preload = path.join(__dirname, "rpc-memory-node.cjs");
  const child = spawn(
    process.execPath,
    [
      "--require",
      preload,
      "-e",
      `
    const { Worker } = require('node:worker_threads');
    new Worker('setInterval(() => Buffer.alloc(8192), 5)', { eval: true });
    setTimeout(() => process.exit(0), 1200);
  `,
    ],
    {
      env: { ...process.env, REHEARSAL_MEMORY_DIRECTORY: directory },
      stdio: "ignore",
    },
  );
  let reads = 0;
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`exit ${code}`)),
    );
  });
  const reader = setInterval(() => {
    const file = path.join(directory, `node-${child.pid}-0.json`);
    if (!fs.existsSync(file)) return;
    const value = JSON.parse(fs.readFileSync(file));
    assert.equal(value.pid, child.pid);
    for (const key of [
      "rss",
      "heapUsed",
      "heapTotal",
      "external",
      "arrayBuffers",
    ])
      assert.ok(value.peak[key] >= value.current[key]);
    reads++;
  }, 2);
  try {
    await completed;
    assert.ok(reads > 100);
    const values = fs
      .readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file))));
    assert.equal(values.length, 2);
    assert.deepEqual(values.map((value) => value.threadId).sort(), [0, 1]);
  } finally {
    clearInterval(reader);
    child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
