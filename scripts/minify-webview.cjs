const fs = require("node:fs/promises");
const path = require("node:path");
const { transform } = require("esbuild");

// Transform only the formatted, patched entry. Never bundle or rename symbols:
// other upstream chunks import its existing exports, including through cycles.
async function minifyWebview(root) {
  const assets = path.join(root, "assets");
  const names = (await fs.readdir(assets)).filter((name) =>
    /^app-initial-[a-f0-9]{12}\.js$/.test(name),
  );
  if (names.length !== 1)
    throw new Error("Expected exactly one app-initial JS asset");
  const name = names[0];
  const file = path.join(assets, name);
  const source = await fs.readFile(file, "utf8");
  const result = await transform(source, {
    loader: "js",
    target: "esnext",
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: false,
    treeShaking: false,
    legalComments: "inline",
    sourcemap: false,
  });
  if (result.warnings.length) throw new Error(JSON.stringify(result.warnings));
  // Write the exclusion first: interruption must never leave transformed bytes
  // eligible for immutable caching. precompress regenerates representations later.
  await fs.writeFile(
    path.join(root, ".minified-assets.json"),
    JSON.stringify([`assets/${name}`]),
  );
  await fs.writeFile(`${file}.tmp`, result.code);
  await fs.rename(`${file}.tmp`, file);
  for (const suffix of [".map", ".br", ".gz"])
    await fs.rm(`${file}${suffix}`, { force: true });
  const measurement = {
    asset: name,
    before: Buffer.byteLength(source),
    after: Buffer.byteLength(result.code),
  };
  console.log(JSON.stringify(measurement));
  return measurement;
}
module.exports = { minifyWebview };
if (require.main === module)
  minifyWebview(path.resolve(__dirname, "../scratch/asar/webview")).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
