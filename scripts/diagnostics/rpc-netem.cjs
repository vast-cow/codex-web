// Must run inside a NEW user/network namespace. Never modifies the parent qdisc.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const namespace = fs.readlinkSync("/proc/self/ns/net");
  if (
    !process.env.RPC_PARENT_NETNS ||
    namespace === process.env.RPC_PARENT_NETNS
  )
    throw Error("Refusing netem without a verified separate network namespace");
  if (!process.env.PLAYWRIGHT_MODULE || !process.env.CHROMIUM_PATH)
    throw Error("Chromium configuration required");
  const output = process.argv[2];
  if (!output || fs.existsSync(output))
    throw Error("Provide new output directory");
  fs.mkdirSync(output, { recursive: true });
  execFileSync("ip", ["link", "set", "lo", "up"]);
  execFileSync("ip", ["link", "set", "lo", "mtu", "1500"]);
  let offloads;
  try {
    execFileSync("ethtool", [
      "-K",
      "lo",
      "tso",
      "off",
      "gso",
      "off",
      "gro",
      "off",
    ]);
    offloads = execFileSync("ethtool", ["-k", "lo"], { encoding: "utf8" });
  } catch (error) {
    offloads = "not available: " + error.message;
  }
  const harness = path.join(__dirname, "rpc-concurrency.cjs");
  const prep = spawnSync(process.execPath, [harness, "prepare", output], {
    env: process.env,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1048576,
  });
  if (prep.status !== 0) throw Error(prep.stderr);
  const fixture = prep.stdout.trim();
  const result = {
    namespace,
    parentNamespace: process.env.RPC_PARENT_NETNS,
    parentQdisc: JSON.parse(process.env.RPC_PARENT_QDISC || "[]"),
    cases: [],
    mtu: 1500,
    offloads,
  };
  for (const profile of ["netem-bandwidth", "netem-variable"])
    for (const policy of ["observe", "stop"])
      for (let repeat = 0; repeat < 2; repeat++)
        for (const mode of repeat
          ? ["512k", "baseline"]
          : ["baseline", "512k"]) {
          const name = `${profile}-${policy}-${repeat}-${mode}`,
            marker = path.join(output, name + ".ready");
          const previousQdisc = JSON.parse(
            execFileSync("tc", ["-j", "qdisc", "show", "dev", "lo"], {
              encoding: "utf8",
            }),
          );
          if (previousQdisc.some((q) => q.kind === "netem"))
            execFileSync("tc", ["qdisc", "del", "dev", "lo", "root"]);
          execFileSync("tc", [
            "qdisc",
            "replace",
            "dev",
            "lo",
            "root",
            "netem",
            "delay",
            "25ms",
            "rate",
            profile === "netem-bandwidth" ? "8mbit" : "64mbit",
            "seed",
            String(20261118 + repeat),
          ]);
          const initialQdisc = JSON.parse(
            execFileSync("tc", ["-j", "-s", "qdisc", "show", "dev", "lo"], {
              encoding: "utf8",
            }),
          );
          assert.ok(
            initialQdisc.some((q) => q.kind === "netem"),
            "netem must be configured before starting workload",
          );
          const config = {
            name: profile,
            chunks: profile === "netem-bandwidth" ? 16 : 48,
            rate: 1e12,
            forward: 0,
            ack: 0,
            drainMs: 2000,
            kernelMarker: marker,
            progressFile: marker + ".progress",
          };
          let changed = false,
            changing = false,
            changeAfterMs;
          const started = performance.now();
          const timer = setInterval(() => {
            if (
              profile === "netem-variable" &&
              !changed &&
              !changing &&
              fs.existsSync(marker)
            ) {
              changing = true;
              setTimeout(() => {
                execFileSync("tc", [
                  "qdisc",
                  "change",
                  "dev",
                  "lo",
                  "root",
                  "netem",
                  "delay",
                  "100ms",
                  "20ms",
                  "rate",
                  "64mbit",
                  "seed",
                  String(20261118 + repeat),
                ]);
                changed = true;
                changeAfterMs = performance.now() - started;
              }, 400);
            }
          }, 10);
          const child = spawn(
            process.execPath,
            [
              "--expose-gc",
              "--max-old-space-size=256",
              harness,
              "worker",
              fixture,
              mode,
              JSON.stringify(config),
              policy,
            ],
            { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (x) => (stdout += x));
          child.stderr.on("data", (x) => (stderr += x));
          const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
          let status;
          try {
            status = await new Promise((resolve, reject) => {
              child.once("exit", resolve);
              child.once("error", reject);
            });
          } finally {
            clearTimeout(timeout);
            clearInterval(timer);
          }
          fs.writeFileSync(path.join(output, name + ".log"), stderr);
          if (status !== 0) {
            fs.writeFileSync(
              path.join(output, "failure.json"),
              JSON.stringify(
                {
                  name,
                  status,
                  stderr,
                  stdout,
                  progress: fs.existsSync(marker + ".progress")
                    ? JSON.parse(fs.readFileSync(marker + ".progress"))
                    : null,
                  qdisc: JSON.parse(
                    execFileSync(
                      "tc",
                      ["-j", "-s", "qdisc", "show", "dev", "lo"],
                      { encoding: "utf8" },
                    ),
                  ),
                },
                null,
                2,
              ),
            );
            throw Error(name + ": " + stderr + " " + stdout);
          }
          const row = JSON.parse(stdout);
          if (row.status === "complete")
            assert.equal(
              row.rejectedCredit,
              0,
              "normal EOF must finish all successful ACKs before shutdown",
            );
          if (profile === "netem-variable" && row.status === "complete")
            assert.ok(
              changed,
              "variable latency must change during the transfer",
            );
          let qdisc,
            drainMs = 0;
          const drainStart = performance.now();
          do {
            qdisc = JSON.parse(
              execFileSync("tc", ["-j", "-s", "qdisc", "show", "dev", "lo"], {
                encoding: "utf8",
              }),
            );
            if (qdisc.every((q) => (q.backlog || 0) === 0)) break;
            await wait(20);
            drainMs = performance.now() - drainStart;
          } while (drainMs < 5000);
          assert.ok(
            qdisc.every((q) => (q.backlog || 0) === 0),
            "kernel qdisc must drain",
          );
          assert.ok(qdisc.some((q) => q.kind === "netem"));
          result.cases.push({
            initialQdisc,
            mode,
            policy,
            repeat,
            profile,
            changed,
            changeAfterMs,
            drainMs,
            qdisc,
            measurement: row,
          });
          fs.writeFileSync(
            path.join(output, "results.json"),
            JSON.stringify(result, null, 2) + "\n",
          );
          console.log(name, row.status);
        }
  result.coresSha256 = createHash("sha256")
    .update(fs.readFileSync(fixture))
    .digest("hex");
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  execFileSync("tc", ["qdisc", "del", "dev", "lo", "root"]);
}
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
