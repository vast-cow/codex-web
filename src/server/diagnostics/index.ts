import { randomUUID } from "node:crypto";
import { createLogger } from "./core";
export const serverId = randomUUID();
const logger = createLogger(
  "server",
  process.env.CODEX_WEB_LOG_LEVEL,
  (record) => {
    process.stderr.write(JSON.stringify({ ...record, serverId }) + "\n");
  },
);
export const diagnostic = logger.log;

process.on("uncaughtExceptionMonitor", () =>
  diagnostic("error", "process.uncaught-exception"),
);
