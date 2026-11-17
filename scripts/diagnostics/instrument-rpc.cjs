// Version-specific, fail-closed edits. Never pass a production artifact directory.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createRpcDiagnostics } = require("./rpc-runtime.cjs");
const marker = "/* codex-rpc-flow-diagnostics-v1 */";
function instrument(source, side) {
  if (source.includes(marker)) return source;
  const ast = ts.createSourceFile(
    "bundle.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits = [],
    counts = {};
  const add = (name, start, end, text) => {
    counts[name] = (counts[name] || 0) + 1;
    edits.push({ start, end, text });
  };
  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (n) => walk(n, visit));
  };
  const text = (n) => n.getText(ast);
  walk(ast, (node) => {
    if (ts.isMethodDeclaration(node) && node.body) {
      const name = text(node.name);
      if (name === "onSend" || name === "onAck") {
        // These methods belong to the adaptive window, not unrelated classes.
        if (!text(node).includes("this.bytesInFlight")) return;
        const token = name === "onSend" ? "t" : "e";
        const returns = node.body.statements.filter(ts.isReturnStatement);
        if (returns.length !== 1) throw Error("Unexpected window return");
        add(
          name,
          returns[0].getStart(ast),
          returns[0].getStart(ast),
          `__codexRpcDiag?.window('${name === "onSend" ? "send" : "ack"}',this,${token});`,
        );
      }
      if (name === "deliverStreamWrite") {
        add(
          "writer-token",
          node.body.getStart(ast) + 1,
          node.body.getStart(ast) + 1,
          "const __codexWrite=__codexRpcDiag?.writerToken(t);",
        );
        walk(node.body, (child) => {
          if (
            ts.isAwaitExpression(child) &&
            text(child.expression).replace(/\s/g, "") === "t.write(r)"
          ) {
            add(
              "writer-await",
              child.getStart(ast),
              child.end,
              "(__codexRpcDiag?.writeStart(__codexWrite,r),await t.write(r),__codexRpcDiag?.writeEnd(__codexWrite))",
            );
          }
          if (ts.isCatchClause(child))
            add(
              "writer-error",
              child.block.getStart(ast) + 1,
              child.block.getStart(ast) + 1,
              "__codexRpcDiag?.writeEnd(__codexWrite,true);",
            );
        });
      }
      if (name === "sendStream") {
        add(
          "stream-send",
          node.body.getStart(ast) + 1,
          node.body.getStart(ast) + 1,
          "__codexRpcDiag?.sent(this,this.imports.length,e);",
        );
      }
      if (name === "ensureResolvingExport") {
        walk(node.body, (child) => {
          if (
            ts.isCallExpression(child) &&
            text(child.expression) === "this.send" &&
            child.arguments[0] &&
            ts.isArrayLiteralExpression(child.arguments[0]) &&
            text(child.arguments[0].elements[0]) === "`resolve`"
          ) {
            add(
              "ack-send",
              child.getStart(ast),
              child.end,
              `(__codexRpcDiag?.emit('ack-send',{sessionId:__codexRpcDiag.id(this),operationId:e}),${text(child)})`,
            );
          }
        });
      }
    }
    if (ts.isCaseClause(node) && text(node.expression) === "`stream`") {
      walk(node, (child) => {
        if (
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          child.expression.name.text === "evaluate"
        ) {
          add(
            "operation",
            child.getStart(ast),
            child.end,
            `(__codexRpcDiag?__codexRpcDiag.operation(this,this.exports.length,n[1]?.[1],()=>${text(child)}):${text(child)})`,
          );
        }
      });
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === (side === "host" ? "ct" : "_Ft")
    ) {
      walk(node.body, (child) => {
        if (ts.isNewExpression(child) && text(child.expression) === "Promise") {
          const executor = child.arguments[0];
          if (!ts.isArrowFunction(executor) || !ts.isBlock(executor.body))
            throw Error("Unexpected credit executor");
          add(
            "credit",
            executor.body.getStart(ast),
            executor.body.end,
            `{if(__codexRpcDiag){const end=__codexRpcDiag.credit(r);i=()=>{end('released');e()};a=reason=>{end('rejected');t(reason)}}else{i=e;a=t}}`,
          );
        }
      });
    }
  });
  const expected = {
    onSend: 1,
    onAck: 1,
    "writer-token": 1,
    "writer-await": 2,
    "writer-error": 1,
    "stream-send": 1,
    "ack-send": 1,
    operation: 1,
    credit: 1,
  };
  for (const [name, count] of Object.entries(expected)) {
    if (counts[name] !== count)
      throw Error(
        `${side}: ${name}: expected ${count}, got ${counts[name] || 0}`,
      );
  }
  edits.sort((a, b) => b.start - a.start);
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (i && edit.end > edits[i - 1].start)
      throw Error("Overlapping diagnostic edits");
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  const enabled =
    side === "host"
      ? 'process.env.CODEX_RPC_DIAGNOSTICS === "1"'
      : '(()=>{try{return globalThis.localStorage?.getItem("codex:rpc-diagnostics")==="1"}catch{return false}})()';
  return (
    `${marker}\nconst __codexRpcDiag=(${createRpcDiagnostics.toString()})('${side}',${enabled});\n` +
    source
  );
}
function apply(asar) {
  const live = path.resolve(__dirname, "../../scratch/asar");
  if (fs.existsSync(live) && fs.realpathSync(asar) === fs.realpathSync(live))
    throw Error(
      "Refusing to modify deployed scratch/asar; use an isolated copy",
    );
  const targets = [
    [".vite/build/startup-requirements-C6B1x9gL.js", "host"],
    ["webview/assets/app-shared-8bd9d0399038.js", "browser"],
  ];
  // Validate both before writing either. The caller must use private, copied files.
  const outputs = targets.map(([file, side]) => {
    const target = path.join(asar, file);
    if (!fs.realpathSync(target).startsWith(fs.realpathSync(asar) + path.sep))
      throw Error("Artifact escapes isolated directory: " + target);
    if (
      fs.lstatSync(target).isSymbolicLink() ||
      fs.statSync(target).nlink !== 1
    )
      throw Error("Refusing symlink or hard-linked artifact: " + target);
    return [target, instrument(fs.readFileSync(target, "utf8"), side)];
  });
  for (const [file, output] of outputs) fs.writeFileSync(file, output);
}
module.exports = { instrument, apply };
if (require.main === module) {
  if (!process.argv[2])
    throw Error(
      "Usage: node scripts/diagnostics/instrument-rpc.cjs ISOLATED_ASAR_DIRECTORY",
    );
  apply(path.resolve(process.argv[2]));
}
