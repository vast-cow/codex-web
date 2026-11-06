const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { brotliCompress, gzip, constants } = require("node:zlib");

// Run after the browser build, never in the request path. Regenerate sidecars
// even for mutable files so a rebuild cannot retain an old representation.
async function precompress(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await precompress(file);
    if (!entry.isFile() || !/\.(?:js|css|html|json|svg|txt|wasm)$/.test(file))
      continue;
    const source = await fs.readFile(file);
    for (const [suffix, compress, options] of [
      [
        "br",
        promisify(brotliCompress),
        { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } },
      ],
      ["gz", promisify(gzip), { level: 9 }],
    ]) {
      const target = `${file}.${suffix}`;
      const compressed =
        source.length >= 1024 ? await compress(source, options) : source;
      if (compressed.length < source.length) {
        await fs.writeFile(`${target}.tmp`, compressed);
        await fs.rename(`${target}.tmp`, target);
      } else {
        await fs.rm(target, { force: true });
      }
    }
  }
}
module.exports = { precompress, prepare };
if (require.main === module) {
  prepare().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function prepare(
  root = path.resolve(__dirname, "../scratch/asar/webview"),
) {
  const patched = new Set();
  const patches = path.resolve(__dirname, "../patches");
  for (const name of await fs.readdir(patches)) {
    if (!name.endsWith(".patch")) continue;
    const text = await fs.readFile(path.join(patches, name), "utf8");
    for (const match of text.matchAll(/^\+\+\+ b\/webview\/(\S+)/gm))
      patched.add(match[1]);
  }
  // Fail closed on malformed metadata; never cache transformed bytes under an
  // upstream filename that no longer hashes their content.
  let minified = [];
  try {
    minified = JSON.parse(
      await fs.readFile(path.join(root, ".minified-assets.json"), "utf8"),
    );
    if (
      !Array.isArray(minified) ||
      minified.some((name) => typeof name !== "string")
    )
      throw new Error("Invalid minified asset metadata");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of minified) patched.add(name);
  const immutable = (await fs.readdir(path.join(root, "assets")))
    .map((name) => `assets/${name}`)
    .filter(
      (name) =>
        /^assets\/[^/]+-[a-f0-9]{12}\.(?:js|css|woff2?|png|svg)$/.test(name) &&
        !patched.has(name),
    );
  await precompress(root);
  await fs.writeFile(
    path.join(root, ".immutable-assets.json"),
    JSON.stringify(immutable),
  );
}
