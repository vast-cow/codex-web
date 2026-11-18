// Optional metadata-only preload for disposable, isolated rehearsal processes.
const fs = require("node:fs");
const path = require("node:path");
const { threadId } = require("node:worker_threads");
const directory = process.env.REHEARSAL_MEMORY_DIRECTORY;
if (directory) {
  const output = path.join(directory, `node-${process.pid}-${threadId}.json`);
  const peak = {};
  function sample() {
    const current = process.memoryUsage();
    for (const [key, value] of Object.entries(current))
      peak[key] = Math.max(peak[key] || 0, value);
    fs.writeFileSync(
      output + ".next",
      JSON.stringify({
        pid: process.pid,
        threadId,
        time: Date.now(),
        current,
        peak,
      }),
      { mode: 0o600 },
    );
    fs.renameSync(output + ".next", output);
  }
  sample();
  setInterval(sample, 100).unref();
  process.on("exit", sample);
}
