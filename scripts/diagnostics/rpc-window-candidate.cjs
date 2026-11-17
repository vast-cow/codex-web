// Offline only: normal builds and the production launcher never invoke this tool.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const zlib = require("node:zlib");
const ts = require("typescript");
const { load } = require("./rpc-core.cjs");
const target = ".vite/build/startup-requirements-C6B1x9gL.js";
const hash = (s) => createHash("sha256").update(s).digest("hex");
function patch(source, mode = "baseline") {
  if (!["baseline", "512k"].includes(mode)) throw Error("Unknown mode");
  const ast = ts.createSourceFile(
    "bundle.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found = {};
  function walk(n) {
    if (
      ts.isVariableDeclaration(n) &&
      ["et", "tt", "nt", "st"].includes(n.name.getText(ast))
    ) {
      const name = n.name.getText(ast);
      if (found[name]) throw Error("Duplicate declaration: " + name);
      found[name] = n;
    }
    ts.forEachChild(n, walk);
  }
  walk(ast);
  for (const [name, value] of Object.entries({
    et: "262144",
    tt: "1073741824",
    nt: "65536",
  })) {
    if (found[name]?.initializer?.getText(ast) !== value)
      throw Error("Unexpected constant: " + name);
  }
  // Pin the entire controller, allowing only the existing diagnostic hooks.
  const controller = found.st?.initializer
    ?.getText(ast)
    .replaceAll("__codexRpcDiag?.window('send',this,t);", "")
    .replaceAll("__codexRpcDiag?.window('ack',this,e);", "");
  if (
    !controller ||
    hash(controller) !==
      "90a925c393ce840ccd5daa2d8cd20f830fd6bad0f5cc7e6b5ad8bdefcf4af2f4"
  )
    throw Error(
      "Unknown adaptive controller (initial/minimum/clamp invariant)",
    );
  const n = found.nt.initializer;
  return (
    source.slice(0, n.getStart(ast)) +
    (mode === "512k" ? "524288" : "65536") +
    source.slice(n.end)
  );
}
function verify(source) {
  const api = load(source, "host");
  let clock = 100;
  const w = new api.Window(() => clock);
  const initial = w.window;
  const a = w.onSend(262404);
  clock += 180;
  w.onAck(a.token);
  const afterFirstAck = w.window;
  const b = w.onSend(262404);
  clock += 180;
  w.onAck(b.token);
  return {
    initial,
    minimum: api.minimum,
    maximum: api.maximum,
    afterFirstAck,
    afterSecondAck: w.window,
  };
}
function build(sourceDir, destination, mode = "baseline") {
  sourceDir = fs.realpathSync(sourceDir);
  destination = path.resolve(destination);
  if (fs.existsSync(destination)) throw Error("Destination must not exist");
  const parent = fs.realpathSync(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  const live = path.resolve(__dirname, "../../scratch/asar");
  if (
    destination === live ||
    destination.startsWith(live + path.sep) ||
    destination.startsWith(sourceDir + path.sep)
  )
    throw Error("Destination must be outside source and deployed artifacts");
  if (
    JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json")))
      .version !== "26.1007.30912"
  )
    throw Error("Unknown Desktop version");
  // Refuse shared inputs too; do not follow links anywhere in the artifact tree.
  function check(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
        throw Error("Symlink or hard-linked input: " + file);
      if (stat.isDirectory()) check(file);
    }
  }
  check(sourceDir);
  const before = fs.readFileSync(path.join(sourceDir, target), "utf8");
  const after = patch(before, mode),
    runtime = verify(after);
  if (
    runtime.initial !== 262144 ||
    runtime.afterFirstAck !== 262144 ||
    runtime.maximum !== 1073741824 ||
    runtime.minimum !== (mode === "512k" ? 524288 : 65536) ||
    runtime.afterSecondAck < runtime.minimum
  )
    throw Error("Runtime window verification failed");
  fs.cpSync(sourceDir, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const output = path.join(destination, target);
  fs.writeFileSync(output, after);
  // Host JS normally has no compressed siblings. Refresh any that do exist.
  for (const [ext, compress] of [
    [".gz", zlib.gzipSync],
    [".br", zlib.brotliCompressSync],
  ])
    if (fs.existsSync(output + ext))
      fs.writeFileSync(output + ext, compress(Buffer.from(after)));
  const manifest = {
    mode,
    target,
    before: hash(before),
    after: hash(after),
    runtime,
    browser: hash(
      fs.readFileSync(
        path.join(destination, "webview/assets/app-shared-8bd9d0399038.js"),
      ),
    ),
  };
  fs.writeFileSync(
    path.join(destination, "rpc-window-experiment.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
module.exports = { patch, verify, build, target };
if (require.main === module) {
  const [source, destination, mode] = process.argv.slice(2);
  if (!source || !destination || process.argv.length > 5)
    throw Error(
      "Usage: node rpc-window-candidate.cjs SOURCE_ASAR NEW_DESTINATION [baseline|512k]",
    );
  console.log(JSON.stringify(build(source, destination, mode), null, 2));
}
