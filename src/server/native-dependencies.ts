import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Exercise the binding in the same resolution context as the prepared app. */
export function validateNativeDependencies(): void {
  const applicationRequire = createRequire(
    path.resolve(__dirname, "../../scratch/asar/package.json"),
  );
  let sqlitePath = "";
  try {
    sqlitePath = applicationRequire.resolve("better-sqlite3");
    const Database = applicationRequire("better-sqlite3");
    const database = new Database(":memory:");
    try {
      const row = database.prepare("SELECT 1 AS value").get();
      if (row?.value !== 1) {
        throw new Error("SQLite SELECT 1 returned an unexpected result");
      }
    } finally {
      database.close();
    }
  } catch (error) {
    const pnpm =
      sqlitePath.split(path.sep).includes(".pnpm") ||
      existsSync(path.resolve(__dirname, "../../node_modules/.modules.yaml"));
    const original =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw new Error(
      `SQLite native dependency validation failed (Node ${process.version}).\n` +
        `${original}\n` +
        `From the project directory, run: ${pnpm ? "pnpm" : "npm"} rebuild better-sqlite3\n` +
        "Use the same package manager and Node version as the server; do not share node_modules across package managers.",
      { cause: error },
    );
  }
}
