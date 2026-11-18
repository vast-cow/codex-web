// Load the same transport used by the shims in the Node and Chromium fixtures.
const fs = require("node:fs");
const path = require("node:path");

function source() {
  const ts = require("typescript");
  return ts.transpileModule(
    fs.readFileSync(
      path.join(__dirname, "../../src/shared/websocket-transport.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
}

function load(code = source()) {
  const exports = {};
  new Function("exports", code)(exports);
  return exports;
}
module.exports = { load, source };
