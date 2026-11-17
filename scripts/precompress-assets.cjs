#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { gzip, brotliCompress, constants } = require("node:zlib");
async function precompress(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await precompress(file);
    else if (entry.isFile() && /\.(js|css)$/.test(file)) {
      const source = await fs.readFile(file);
      // Sequential files bound build memory; never compress source maps or user files.
      for (const [suffix, compress, options] of [
        [".gz", gzip, { level: 9 }],
        [
          ".br",
          brotliCompress,
          { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } },
        ],
      ]) {
        const encoded = await promisify(compress)(source, options);
        await fs.writeFile(file + suffix, encoded);
        const { atime, mtime } = await fs.stat(file);
        await fs.utimes(file + suffix, atime, mtime);
      }
    }
  }
}
module.exports = { precompress };
if (require.main === module)
  precompress(path.resolve(process.argv[2] || "scratch/asar/webview")).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
