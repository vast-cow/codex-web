// Execute only the packaged RPC core; never execute Desktop startup.
function load(source, side, diagnostic) {
  // Execute the actual bundle's self-contained RPC implementation, excluding app startup.
  let core;
  if (side === "host") {
    core =
      "var " +
      source.slice(
        source.indexOf("ce=Symbol(`workers-module`)"),
        source.indexOf("var ut=D"),
      );
    core +=
      ";return { Session:qe, Target:b, Window:st, initial:et, minimum:nt, maximum:tt, writable:ct };";
  } else {
    core = source.slice(
      source.indexOf("function JP(e)"),
      source.indexOf("\nvar X;\nfunction bF()"),
    );
    core += ";yF();yF();return { Session:BFt, Target:QP, Window:QFt };";
  }
  return new Function("__codexRpcDiag", "t", core)(diagnostic, (fn) => {
    let initialized = false;
    return () => {
      if (!initialized) {
        initialized = true;
        fn();
      }
    };
  });
}
module.exports = { load };
