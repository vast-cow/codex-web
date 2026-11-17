#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const {
  hash,
  digest,
  tree,
  readMetadata,
  writeMetadata,
} = require("./asset-cache.cjs");

async function prepareAssets({
  root = process.cwd(),
  force = process.env.FORCE_ASSETS === "1" || process.argv.includes("--force"),
  processAssets,
} = {}) {
  const cache = path.join(root, "scratch/asset-cache");
  const prepared = path.join(cache, "desktop/asar");
  const metadataFile = path.join(cache, "desktop.json");
  const installedFile = path.join(cache, "installed.json");
  const installed = (await readMetadata(installedFile)) || [];
  const archive = process.env.HOSTED_CODEX_APP_ZIP;
  if (!archive)
    throw new Error("HOSTED_CODEX_APP_ZIP must point to the Desktop zip");
  // Hash the archive, local assets/patches, options/scripts, and installed tool versions.
  // The lockfile covers dependency changes; actual versions cover local installs too.
  const inputs = {};
  for (const directory of ["assets", "patches"])
    inputs[directory] = await tree(path.join(root, directory));
  for (const file of [
    archive,
    "package.json",
    "package-lock.json",
    "scripts/prepare-asar-uncached",
    "scripts/prepare-assets.cjs",
    "scripts/asset-cache.cjs",
    "scripts/diagnostics/instrument-rpc.cjs",
    "scripts/diagnostics/rpc-runtime.cjs",
  ].map((file) => path.resolve(root, file)))
    inputs[
      file === path.resolve(root, archive)
        ? "archive"
        : path.relative(root, file)
    ] = await digest(file);
  for (const name of (await fs.readdir(root)).filter((name) =>
    /^(\.prettier|prettier\.config\.|\.editorconfig$)/.test(name),
  ))
    inputs[name] = await digest(path.join(root, name));
  inputs.dev = !!process.env.DEV;
  inputs.node = process.versions;
  if (!processAssets) {
    const sharpRequire = createRequire(require.resolve("sharp-cli/package.json"));
    inputs.tools = { sharp: sharpRequire("sharp").versions };
    for (const command of ["asar", "sharp", "prettier", "patch"])
      inputs.tools[command] = execFileSync(command, ["--version"], {
        encoding: "utf8",
      });
  }
  const key = hash(JSON.stringify(inputs));
  const previous = await readMetadata(metadataFile);
  let outputs;
  try {
    outputs = await tree(prepared);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    force ||
    previous?.key !== key ||
    JSON.stringify(outputs) !== JSON.stringify(previous?.outputs)
  ) {
    console.log(
      "[assets] Preparing Desktop: extract, copy, icon, format, patch",
    );
    // Invalidate before work. A failed run can never certify partially written output.
    await fs.rm(metadataFile, { force: true });
    await fs.rm(path.join(cache, "desktop"), { recursive: true, force: true });
    await fs.mkdir(path.join(cache, "desktop"), { recursive: true });
    if (processAssets) await processAssets(prepared);
    else
      execFileSync("bash", ["scripts/prepare-asar-uncached"], {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, ASAR_SCRATCH: path.join(cache, "desktop") },
      });
    outputs = await tree(prepared);
  } else
    console.log(
      "[assets] Skipped Desktop preparation (unchanged inputs and outputs)",
    );

  // Restore only prepared files. Never delete or overwrite unrelated Vite/compression
  // output on a cache hit; verify bytes so missing or overwritten files are repaired.
  const destination = path.join(root, "scratch/asar");
  let live = {};
  try {
    live = await tree(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of installed.slice().reverse()) {
    if (!outputs[name])
      await fs.rm(path.join(destination, name), {
        force: true,
        recursive: true,
      });
  }
  let restored = 0;
  for (const [name, value] of Object.entries(outputs)) {
    if (JSON.stringify(live[name]) === JSON.stringify(value)) continue;
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (value.directory) {
      if (live[name] && !live[name].directory)
        await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(target, { recursive: true });
      await fs.chmod(target, value.mode);
      continue;
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(path.join(prepared, name), target, {
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    restored++;
  }
  await writeMetadata(installedFile, Object.keys(outputs));
  await writeMetadata(metadataFile, { key, outputs });
  console.log(`[assets] Restored ${restored} prepared files`);
}
module.exports = { prepareAssets };
if (require.main === module)
  prepareAssets().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
