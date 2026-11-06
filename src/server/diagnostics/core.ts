// Shared with the browser. Never accept arbitrary payloads or error text.
export type Level = "error" | "warn" | "info" | "debug" | "trace";
const levels = ["error", "warn", "info", "debug", "trace"];
const numeric = new Set([
  "durationMs",
  "elapsedMs",
  "startMs",
  "monotonicMs",
  "eventLoopDelayMs",
  "ageMs",
  "queueLength",
  "highWater",
  "pending",
  "ports",
  "listeners",
  "bytes",
  "bufferedAmount",
  "code",
  "status",
  "count",
  "windowId",
  "webContentsId",
  "sendAgeMs",
  "receiveAgeMs",
]);
const flags = new Set(["ok", "current", "wasClean", "online", "hidden"]);
const ids = new Set([
  "sessionId",
  "pageId",
  "connectionId",
  "serverId",
  "requestId",
  "rpcId",
  "portId",
]);
const enums = new Set([
  "stage",
  "kind",
  "action",
  "route",
  "version",
  "method",
  "contentType",
]);
export function identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^(?:[a-f0-9-]{36}|(?:message_port_)?ipc_bridge_\d{1,12})$/.test(value)
    ? value
    : undefined;
}
export function metadata(input: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (numeric.has(key) && typeof value === "number" && Number.isFinite(value))
      result[key] = value;
    else if (flags.has(key) && typeof value === "boolean") result[key] = value;
    else if (
      key === "rpcId" &&
      (identity(value) ||
        (typeof value === "string" && /^\d{1,16}$/.test(value)))
    )
      result[key] = value;
    else if (ids.has(key) && identity(value)) result[key] = value;
    else if (
      enums.has(key) &&
      typeof value === "string" &&
      ([
        "redacted-error",
        "bootstrap-start",
        "host-services",
        "react-request",
        "routes-mounted",
        "statsig-start",
        "statsig-end",
        "plugin/installed",
        "registered",
        "completed",
        "failed",
        "late-response",
        "started",
        "timeout",
        "timed-out",
        "response",
        "rejection",
        "cancelled",
        "reconnect",
        "home",
        "thread",
        "backend",
        "asset",
        "other",
        "html",
        "javascript",
        "POP",
        "PUSH",
        "REPLACE",
        "GET",
        "POST",
      ].includes(value) ||
        (key === "version" && /^\d+(?:\.\d+){1,3}$/.test(value)))
    )
      result[key] = value;
  }
  if (
    typeof input.type === "string" &&
    [
      "ipc-main-event",
      "ipc-renderer-send",
      "ipc-renderer-invoke",
      "ipc-renderer-post-message",
      "message-port-message",
      "message-port-close",
      "ipc-renderer-invoke-result",
      "workspace-directory-entries-result",
      "workspace-directory-entries-request",
    ].includes(input.type)
  )
    result.kind = input.type;
  return result;
}
export function errorDetails(_error: unknown) {
  return { stage: "redacted-error" };
}
export function createLogger(
  source: string,
  level: unknown,
  sink: (record: Record<string, unknown>) => void,
) {
  const threshold = typeof level === "string" ? levels.indexOf(level) : -1;
  let sequence = 0,
    suppressed = 0;
  const counts = new Map<string, number>();
  return {
    get suppressed() {
      return suppressed;
    },
    enabled: threshold >= 0,
    log(level: Level, event: string, fields: Record<string, unknown> = {}) {
      if (threshold < levels.indexOf(level)) return;
      try {
        if (level === "trace") {
          const count = (counts.get(event) ?? 0) + 1;
          counts.set(event, count);
          if (count > 20 && count % 100 !== 0) {
            suppressed++;
            return;
          }
        }
        sink({
          timestamp: new Date().toISOString(),
          monotonicMs: performance.now(),
          source,
          level,
          event,
          sequence: ++sequence,
          suppressed,
          ...metadata(fields),
        });
      } catch {
        /* Diagnostics must never affect application behavior. */
      }
    },
  };
}
export function routeCategory(path: string): string {
  return path === "/"
    ? "home"
    : /^\/(thread|local)\//.test(path)
      ? "thread"
      : path.startsWith("/__backend/")
        ? "backend"
        : /\.(js|css|map)(\?|$)/.test(path)
          ? "asset"
          : "other";
}
export function validEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case "ipc-main-event":
    case "ipc-renderer-send":
    case "ipc-renderer-invoke":
      return (
        typeof m.channel === "string" &&
        Array.isArray(m.args) &&
        (m.type !== "ipc-renderer-invoke" || typeof m.requestId === "string")
      );
    case "ipc-renderer-post-message":
      return (
        typeof m.channel === "string" &&
        Array.isArray(m.portIds) &&
        m.portIds.every((x) => typeof x === "string")
      );
    case "message-port-message":
    case "message-port-close":
      return typeof m.portId === "string";
    case "ipc-renderer-invoke-result":
    case "workspace-directory-entries-result":
      return typeof m.requestId === "string" && typeof m.ok === "boolean";
    case "workspace-directory-entries-request":
      return (
        typeof m.requestId === "string" &&
        (m.directoryPath === null || typeof m.directoryPath === "string") &&
        typeof m.directoriesOnly === "boolean"
      );
    default:
      return false;
  }
}
export class DiagnosticTail {
  records: Record<string, unknown>[] = [];
  dropped = 0;
  constructor(
    readonly maxCount = 400,
    readonly maxBytes = 110000,
  ) {}
  private bytes = 4;
  private sizes: number[] = [];
  clear() {
    this.records.length = 0;
    this.sizes.length = 0;
    this.bytes = 4;
    this.dropped = 0;
  }
  add(record: Record<string, unknown>) {
    const size = JSON.stringify(record).length * 2 + 2;
    this.records.push(record);
    this.sizes.push(size);
    this.bytes += size;
    while (this.records.length > this.maxCount || this.bytes > this.maxBytes) {
      this.records.shift();
      this.bytes -= this.sizes.shift() ?? 0;
      this.dropped++;
    }
  }
}

// Inspect only known envelope positions; never serialize payloads for diagnostics.
export function rpcMetadata(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") return {};
  const m = message as Record<string, unknown>;
  const args = Array.isArray(m.args) ? m.args : [];
  const candidates = [m, ...args.slice(0, 2), m.data, m.message];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    const request =
      c.request && typeof c.request === "object"
        ? (c.request as Record<string, unknown>)
        : c;
    const id = request.id ?? request.requestId;
    if (typeof id !== "string" && typeof id !== "number") continue;
    return metadata({
      rpcId: String(id),
      method: request.method === "plugin/installed" ? request.method : "other",
    });
  }
  return {};
}
