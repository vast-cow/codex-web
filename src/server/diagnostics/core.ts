// Shared with the browser. Never accept arbitrary payloads or error text.
export type Level = "error" | "warn" | "info" | "debug" | "trace";
const levels = ["error", "warn", "info", "debug", "trace"];
const numeric = new Set([
  "durationMs",
  "connectionAgeMs",
  "queueWaitMs",
  "sendCallbackMs",
  "dispatchMs",
  "handlerExecutionMs",
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
  "asset",
  "stage",
  "kind",
  "action",
  "route",
  "version",
  "method",
  "contentType",
  "rpcMetadataStatus",
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
      typeof value === "string" &&
      (/^[a-f0-9-]{36}$/.test(value) || /^\d{1,16}$/.test(value))
    )
      result[key] = value;
    else if (key !== "rpcId" && ids.has(key) && identity(value))
      result[key] = value;
    else if (
      enums.has(key) &&
      typeof value === "string" &&
      ([
        "redacted-error",
        "missing",
        "invalid",
        "recognized",
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
        "css",
        "source-map",
        "spa-fallback",
        "not-found",
        "static-response",
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
        if (
          level === "trace" &&
          !criticalEvent({ event, level, ...metadata(fields) })
        ) {
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
// Independent bounded budgets: trace volume cannot evict critical lifecycle records.
export function criticalEvent(record: Record<string, unknown>): boolean {
  const event = String(record.event ?? "");
  return (
    record.level === "error" ||
    record.level === "warn" ||
    /^(startup\.phase|shim\.|route\.initial|browser\.(error|unhandled)|socket\.|reconnect\.|page\.reload|rpc\.|request\.|port\.(register|start|close|disconnect)|renderer\.)/.test(
      event,
    ) ||
    typeof record.rpcId === "string"
  );
}
export class DiagnosticTail {
  records: Record<string, unknown>[] = [];
  dropped = 0;
  private entries: { critical: boolean; size: number }[] = [];
  private counts: [number, number] = [0, 0];
  private bytes: [number, number] = [4, 4];
  constructor(
    readonly maxCount = 400,
    readonly maxBytes = 110000,
    readonly criticalCount = 1200,
    readonly criticalBytes = 660000,
  ) {}
  clear() {
    this.records.length = 0;
    this.dropped = 0;
    this.entries = [];
    this.counts = [0, 0];
    this.bytes = [4, 4];
  }
  add(record: Record<string, unknown>) {
    const critical = criticalEvent(record);
    const countLimit = critical ? this.criticalCount : this.maxCount;
    const byteLimit = critical ? this.criticalBytes : this.maxBytes;
    const size = (row: Record<string, unknown>) =>
      JSON.stringify(row).length * 2 + 2;
    if (size(record) + 4 > byteLimit) {
      this.dropped++;
      return;
    }
    const bucket = critical ? 1 : 0;
    this.records.push(record);
    this.entries.push({ critical, size: size(record) });
    this.counts[bucket]++;
    this.bytes[bucket] += size(record);
    while (this.counts[bucket] > countLimit || this.bytes[bucket] > byteLimit) {
      const index = this.entries.findIndex((row) => row.critical === critical);
      this.bytes[bucket] -= this.entries[index]!.size;
      this.entries.splice(index, 1);
      this.records.splice(index, 1);
      this.counts[bucket]--;
      this.dropped++;
    }
  }
}

// Only bridge payload positions and the app's request/response wrappers are inspected.
export function rpcMetadata(message: unknown): Record<string, unknown> {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const m = object(message);
  if (!m) return { rpcMetadataStatus: "missing" };
  // Never inspect m.requestId: that namespace belongs to the bridge.
  const payload =
    m.type === "message-port-message"
      ? object(m.data)
      : Array.isArray(m.args)
        ? object(m.args[0])
        : undefined;
  if (!payload) return { rpcMetadataStatus: "missing" };
  const rpc =
    object(payload.request) ??
    object(payload.response) ??
    (m.type === "message-port-message" && payload.jsonrpc === "2.0"
      ? payload
      : undefined);
  if (!rpc) return { rpcMetadataStatus: "missing" };
  const id = rpc.id;
  const valid =
    (typeof id === "string" &&
      (/^[a-f0-9-]{36}$/.test(id) || /^\d{1,16}$/.test(id))) ||
    (typeof id === "number" && Number.isSafeInteger(id) && id >= 0);
  return {
    ...metadata({
      rpcId: valid ? String(id) : undefined,
      method: rpc.method === "plugin/installed" ? "plugin/installed" : "other",
    }),
    rpcMetadataStatus: valid
      ? "recognized"
      : id == null
        ? "missing"
        : "invalid",
  };
}
