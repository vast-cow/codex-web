// Content hashes deliberately ignore mtimes: source compilation may rewrite identical bytes.
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function readMetadata(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
async function writeMetadata(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, file);
}
async function digest(file) {
  try {
    const result = createHash("sha256");
    for await (const chunk of createReadStream(file)) result.update(chunk);
    return result.digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function tree(directory) {
  const result = {};
  async function visit(relative) {
    for (const entry of (
      await fs.readdir(path.join(directory, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      const file = path.join(directory, name);
      if (entry.isDirectory()) {
        result[name] = {
          directory: true,
          mode: (await fs.stat(file)).mode & 0o777,
        };
        await visit(name);
      } else if (entry.isSymbolicLink())
        result[name] = { link: await fs.readlink(file) };
      else
        result[name] = {
          hash: await digest(file),
          mode: (await fs.stat(file)).mode & 0o777,
        };
    }
  }
  await visit("");
  return result;
}
module.exports = { hash, digest, tree, readMetadata, writeMetadata };
