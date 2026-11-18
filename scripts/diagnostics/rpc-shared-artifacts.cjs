// Offline, version-pinned patch for a disposable Desktop release.
const fs = require("node:fs");
const path = require("node:path");
const { patch, target } = require("./rpc-window-candidate.cjs");
const { instrument } = require("./instrument-rpc.cjs");
const { patchTransportWriter } = require("./rpc-transport-capacity.cjs");
const { createHash } = require("node:crypto");
const digest = (text) => createHash("sha256").update(text).digest("hex");

const [release, mode] = process.argv.slice(2);
const root = release && fs.realpathSync(release);
if (
  !root?.startsWith("/tmp/rpc-shared.") ||
  !["baseline", "512k"].includes(mode)
)
  throw Error(
    "Expected a disposable /tmp/rpc-shared.* release and window mode",
  );
const asar = path.join(root, "scratch/asar");
const host = path.join(asar, target);
const adapter = path.join(asar, ".vite/build/main-CqEoQDOU.js");
const browser = path.join(asar, "webview/assets/app-shared-8bd9d0399038.js");
const before = fs.readFileSync(adapter, "utf8");
const browserBefore = fs.readFileSync(browser, "utf8");
if (
  digest(before) !==
  "1899b199e7e5cd34fbb26eac41d7482d926901bced8f97c0932e04c07b63de93"
)
  throw Error("Unexpected Desktop host MessagePort adapter");
const anchor = "var wXe = class {\n    encodingLevel = `jsonCompatible`;";
const replacement =
  anchor +
  "\n    get beforeStreamWrite() { return this.#e.beforeStreamWrite; }" +
  "\n    get splitStreamWrite() { return this.#e.splitStreamWrite; }";
if (before.split(anchor).length !== 2)
  throw Error("Missing Desktop adapter anchor");
const connect = "function Uli(e) {";
if (
  digest(browserBefore) !==
    "471238df871737e2118a16705b18b7b20418bcb879e28a5a25a5062d50641cf9" ||
  browserBefore.split(connect).length !== 2
)
  throw Error("Unexpected Desktop browser MessagePort adapter");
const patched = [
  [adapter, before.replace(anchor, replacement)],
  [
    host,
    patchTransportWriter(
      instrument(patch(fs.readFileSync(host, "utf8"), mode), "host"),
    ),
  ],
  [
    browser,
    browserBefore.replace(
      connect,
      connect +
        `
  const transport = globalThis.__codexWebConnectAppHost?.();
  if (transport) return new BFt(transport, e).getRemoteMain();`,
    ),
  ],
];
for (const [file] of patched) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file)
    throw Error("Expected a private, regular artifact: " + file);
  if (
    file !== browser &&
    [".br", ".gz"].some((ext) => fs.existsSync(file + ext))
  )
    throw Error("Unexpected compressed host artifact sibling");
}
for (const ext of [".br", ".gz"]) {
  const sibling = browser + ext;
  if (!fs.existsSync(sibling)) continue;
  const stat = fs.lstatSync(sibling);
  if (!stat.isFile() || stat.nlink !== 1)
    throw Error("Expected a private browser asset variant: " + sibling);
}
for (const [file, text] of patched) fs.writeFileSync(file, text);
// The staged browser build recreates these variants from the patched bytes.
for (const ext of [".br", ".gz"])
  if (fs.existsSync(browser + ext)) fs.unlinkSync(browser + ext);
console.log(
  JSON.stringify(
    patched.map(([file, text]) => ({
      file: path.relative(root, file),
      sha256: digest(text),
    })),
  ),
);
