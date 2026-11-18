// Only use inside the rehearsal's private PID namespace and memory cgroup.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

function observe(directory, cgroup) {
  assert.notEqual(
    fs.readlinkSync("/proc/self/ns/pid"),
    process.env.REHEARSAL_PARENT_PIDNS,
  );
  assert.ok(process.env.REHEARSAL_PARENT_PIDNS);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const groupText = fs.readFileSync("/proc/self/cgroup", "utf8");
  const read = (file) =>
    fs.readFileSync(path.join(cgroup, file), "utf8").trim();
  assert.equal(read("memory.max"), "2147483648");
  assert.equal(read("memory.swap.max"), "0");
  let phase = "setup";
  let tick = 0;
  function sample(detailed = false) {
    const row = {
      time: Date.now(),
      phase,
      current: Number(read("memory.current")),
      peak: Number(read("memory.peak")),
      stat: Object.fromEntries(
        read("memory.stat")
          .split("\n")
          .map((line) => {
            const [key, value] = line.split(" ");
            return [key, Number(value)];
          })
          .filter(([key]) =>
            [
              "anon",
              "file",
              "kernel",
              "sock",
              "shmem",
              "file_mapped",
              "inactive_file",
              "active_file",
            ].includes(key),
          ),
      ),
    };
    if (detailed)
      row.processes = fs
        .readdirSync("/proc")
        .filter((pid) => /^\d+$/.test(pid))
        .flatMap((pid) => {
          try {
            assert.equal(
              fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"),
              groupText,
              "escaped managed process",
            );
            const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
            const name = status.match(/^Name:\s+(.+)$/m)[1];
            const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
            let component = name;
            if (name.startsWith("node"))
              component = argv.includes("/src/server/main.js")
                ? "desktop"
                : argv.includes("launcher.cjs")
                  ? "launcher"
                  : "controller";
            if (name === "chrome")
              component =
                "chromium:" +
                (argv.match(/--type=([^\0 ]+)/)?.[1] || "browser");
            if (name.startsWith("chrome_crashpad"))
              component = "chromium:crashpad";
            if (name === "codex") component = "app-server";
            const smaps = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
            const kb = (key) =>
              Number(
                smaps.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] || 0,
              ) * 1024;
            const nodeThreads = fs
              .readdirSync(directory)
              .filter(
                (file) =>
                  file.startsWith(`node-${pid}-`) && file.endsWith(".json"),
              )
              .map((file) =>
                JSON.parse(fs.readFileSync(path.join(directory, file))),
              );
            return [
              {
                pid: Number(pid),
                component,
                rss: kb("Rss"),
                pss: kb("Pss"),
                private: kb("Private_Clean") + kb("Private_Dirty"),
                shared: kb("Shared_Clean") + kb("Shared_Dirty"),
                ...(nodeThreads.length && { nodeThreads }),
              },
            ];
          } catch (error) {
            if (["ENOENT", "ESRCH"].includes(error.code)) return [];
            // Some kernel threads/zombies have no readable mappings.
            if (error.code === "EINVAL") return [];
            throw error;
          }
        });
    fs.appendFileSync(
      path.join(directory, "samples.jsonl"),
      JSON.stringify(row) + "\n",
      { mode: 0o600 },
    );
  }
  const timer = setInterval(() => sample(++tick % 5 === 0), 100).unref();
  return {
    phase(value) {
      phase = value;
      sample(true);
    },
    close() {
      clearInterval(timer);
      sample(true);
    },
  };
}
module.exports = { observe };
