// Sequential fresh-process runs avoid overlapping A/B memory measurements.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
if (!process.env.PLAYWRIGHT_MODULE || !process.env.CHROMIUM_PATH)
  throw Error(
    "Set PLAYWRIGHT_MODULE and CHROMIUM_PATH; Chromium must not be skipped",
  );
const output = process.argv[2];
if (!output || fs.existsSync(output))
  throw Error("Provide a new results directory");
fs.mkdirSync(output, { recursive: true });
const summary = [];
for (const [ack, consumer] of [
  [0, 0],
  [40, 3],
  [100, 30],
]) {
  for (const mode of ["baseline", "512k"]) {
    const name = `${mode}-${ack}-${consumer}`;
    const run = spawnSync(
      process.execPath,
      ["--expose-gc", "--test", path.join(__dirname, "rpc-flow.test.cjs")],
      {
        env: {
          ...process.env,
          RPC_WINDOW_MODE: mode,
          RPC_TEST_ACK_MS: String(ack),
          RPC_TEST_CONSUMER_MS: String(consumer),
        },
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(output, name + ".tap"),
      run.stdout + (run.stderr || ""),
    );
    const records = (run.stdout || "")
      .split("\n")
      .filter((l) => l.startsWith("# {"))
      .map((l) => JSON.parse(l.slice(2)));
    summary.push({
      name,
      status: run.status,
      error: run.error?.message,
      records,
    });
    fs.writeFileSync(
      path.join(output, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    console.log(name, run.status === 0 ? "PASS" : "FAIL");
    if (run.status !== 0) process.exit(1);
  }
}
