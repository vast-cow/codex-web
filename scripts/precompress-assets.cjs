#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  hash,
  digest,
  readMetadata,
  writeMetadata,
} = require("./asset-cache.cjs");
const { promisify } = require("node:util");
const { performance } = require("node:perf_hooks");
const { clearLine, cursorTo } = require("node:readline");
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

// Conservatively count non-ASCII characters as two cells to avoid wrapping wide
// characters. Strip terminal controls from filenames before displaying them.
function fitStatus(text, columns) {
  let result = "";
  let width = 0;
  for (const character of text) {
    const cells = character.codePointAt(0) > 0x7e ? 2 : 1;
    if (width + cells > columns) break;
    result += character;
    width += cells;
  }
  return result;
}

function createProgress(started) {
  const output = process.stdout;
  let current;
  let timer;
  let visible = false;
  function draw() {
    if (!current) return;
    const { index, total, file, stage } = current;
    const prefix = `[precompress] ${index}/${total} | `;
    const suffix = ` | ${stage} | elapsed ${((performance.now() - started) / 1000).toFixed(1)}s`;
    // Leave the last column free to avoid terminal auto-wrap.
    const width = Math.max(0, (output.columns || 80) - 1);
    const available = Math.max(0, width - prefix.length - suffix.length);
    const cleanPath = file.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
    const shortPath = fitStatus(cleanPath, available);
    const label =
      shortPath === cleanPath
        ? cleanPath
        : available >= 3
          ? `${fitStatus(cleanPath, available - 3)}...`
          : shortPath;
    cursorTo(output, 0);
    clearLine(output, 0);
    output.write(fitStatus(prefix + label + suffix, width));
    visible = true;
  }
  return {
    update(index, total, file, stage) {
      if (!output.isTTY) return;
      current = { index, total, file, stage };
      draw();
      if (!timer) {
        timer = setInterval(draw, 100);
        timer.unref();
      }
    },
    finish() {
      clearInterval(timer);
      if (visible) output.write("\n");
    },
  };
}

async function precompress(
  root,
  {
    force = process.env.FORCE_ASSETS === "1",
    cacheFile = path.resolve(
      "scratch/asset-cache",
      `compression-${hash(path.resolve(root))}.json`,
    ),
  } = {},
) {
  const key = hash(
    JSON.stringify({
      script: await digest(__filename),
      helper: await digest(require.resolve("./asset-cache.cjs")),
      versions: process.versions,
    }),
  );
  const previous = await readMetadata(cacheFile);
  await fs.rm(cacheFile, { force: true });
  const records = {};
  let processed = 0;
  let skipped = 0;
  const started = performance.now();
  console.log(`[precompress] Starting asset precompression in ${root}`);
  const files = [];
  const progress = createProgress(started);
  try {
    await collectFiles(root, files);
    for (const [index, file] of files.entries()) {
      let stage = "read source";
      try {
        const source = await fs.readFile(file);
        const name = path.relative(root, file);
        const sourceHash = hash(source);
        const cached = previous?.key === key && previous.files[name];
        const reusable =
          !force &&
          cached?.source === sourceHash &&
          cached.gzip === (await digest(file + ".gz")) &&
          cached.brotli === (await digest(file + ".br"));
        if (reusable) {
          // Match sidecar timestamps even when Vite rewrites identical source bytes.
          const { atime, mtime } = await fs.stat(file);
          for (const suffix of [".gz", ".br"])
            await fs.utimes(file + suffix, atime, mtime);
          records[name] = cached;
          skipped++;
          continue;
        }
        // Sequential files bound build memory; never compress source maps or user files.
        for (const [format, suffix, compress, options] of [
          ["gzip", ".gz", gzip, { level: 9 }],
          [
            "brotli",
            ".br",
            brotliCompress,
            { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } },
          ],
        ]) {
          stage = `${format} compression`;
          progress.update(
            index + 1,
            files.length,
            path.relative(root, file),
            format,
          );
          const encoded = await promisify(compress)(source, options);
          stage = `${format} write`;
          await fs.writeFile(file + suffix, encoded);
          stage = `${format} timestamp preservation`;
          const { atime, mtime } = await fs.stat(file);
          await fs.utimes(file + suffix, atime, mtime);
        }
        records[name] = {
          source: sourceHash,
          gzip: await digest(file + ".gz"),
          brotli: await digest(file + ".br"),
        };
        processed++;
      } catch (error) {
        throw new Error(
          `[precompress] ${file}: ${stage} failed: ${error.message}`,
          {
            cause: error,
          },
        );
      }
    }
  } finally {
    progress.finish();
  }
  await writeMetadata(cacheFile, { key, files: records });
  console.log(
    `[precompress] ${files.length === 0 ? "No eligible files. " : ""}Processed ${processed} files; skipped ${skipped} unchanged files in ${(performance.now() - started).toFixed(1)} ms`,
  );
}
module.exports = { precompress };
if (require.main === module)
  precompress(
    path.resolve(
      process.argv.slice(2).find((arg) => arg !== "--force") ||
        "scratch/asar/webview",
    ),
    {
      force:
        process.env.FORCE_ASSETS === "1" || process.argv.includes("--force"),
    },
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
