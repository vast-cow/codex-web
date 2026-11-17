#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { performance } = require("node:perf_hooks");
const { gzip, brotliCompress, constants } = require("node:zlib");
async function collectFiles(directory, files) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `[precompress] ${directory}: scan failed: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(file, files);
    else if (entry.isFile() && /\.(js|css)$/.test(file)) files.push(file);
  }
}

async function precompress(root) {
  const started = performance.now();
  console.log(`[precompress] Starting asset precompression in ${root}`);
  const files = [];
  await collectFiles(root, files);
  console.log(`[precompress] Found ${files.length} eligible JS/CSS files`);
  for (const [index, file] of files.entries()) {
    const label = `[${index + 1}/${files.length}] ${path.relative(root, file)}`;
    let stage = "read source";
    try {
      const source = await fs.readFile(file);
      console.log(`[precompress] ${label}: original ${source.length} bytes`);
      // Sequential files bound build memory; never compress source maps or user files.
      for (const [format, suffix, compress, options] of [
        ["gzip", ".gz", gzip, { level: 9 }],
        [
          "Brotli",
          ".br",
          brotliCompress,
          { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } },
        ],
      ]) {
        stage = `${format} compression`;
        console.log(`[precompress] ${label}: starting ${format}`);
        const operationStarted = performance.now();
        const encoded = await promisify(compress)(source, options);
        stage = `${format} write`;
        await fs.writeFile(file + suffix, encoded);
        stage = `${format} timestamp preservation`;
        const { atime, mtime } = await fs.stat(file);
        await fs.utimes(file + suffix, atime, mtime);
        console.log(
          `[precompress] ${label}: ${format} completed in ${(performance.now() - operationStarted).toFixed(1)} ms, ${encoded.length} bytes`,
        );
      }
    } catch (error) {
      throw new Error(
        `[precompress] ${file}: ${stage} failed: ${error.message}`,
        {
          cause: error,
        },
      );
    }
  }
  console.log(
    `[precompress] ${files.length === 0 ? "No eligible files. " : ""}Processed ${files.length} files in ${(performance.now() - started).toFixed(1)} ms`,
  );
}
module.exports = { precompress };
if (require.main === module)
  precompress(path.resolve(process.argv[2] || "scratch/asar/webview")).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
