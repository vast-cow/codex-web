import {
  createLogger,
  DiagnosticTail,
  identity,
  metadata,
} from "../server/diagnostics/core";
const key = "codex-web:diagnostics";
let level: string | null = null;
let sessionId = crypto.randomUUID();
try {
  level = localStorage.getItem("codex-web:logLevel");
  const saved = sessionStorage.getItem("codex-web:sessionId");
  if (identity(saved)) sessionId = saved as typeof sessionId;
  sessionStorage.setItem("codex-web:sessionId", sessionId);
} catch {}
export { sessionId };
export const pageId = crypto.randomUUID();
const tail = new DiagnosticTail();
let priorSuppressed = 0;
let clearedSuppressed = 0;
const events = new Set([
  "browser.error",
  "browser.unhandled-rejection",
  "history.pop",
  "history.push",
  "history.replace",
  "ipc.dispatch",
  "ipc.dispatch-failure",
  "ipc.listener-failure",
  "ipc.listener-register",
  "page.reload",
  "page.state",
  "picker.complete",
  "picker.failure",
  "port.close",
  "port.disconnect",
  "port.forward",
  "port.forward-failure",
  "port.messageerror",
  "port.receive",
  "port.register",
  "port.start",
  "queue.enqueue",
  "queue.flush",
  "reconnect.attempt",
  "reconnect.scheduled",
  "reconnect.skipped",
  "request.disconnect",
  "request.settle",
  "request.slow",
  "request.start",
  "rpc.lifecycle",
  "browser.event-loop",
  "request.unknown",
  "resource.error",
  "route.initial",
  "route.memory",
  "shim.initialize",
  "socket.attempt",
  "socket.close",
  "socket.error",
  "socket.open",
  "transport.decode-failure",
  "transport.invalid-envelope",
  "transport.receive",
  "transport.send-api",
  "transport.send-failure",
  "transport.serialize-failure",
  "upload.response",
]);
// Only restore records written by this adapter; reapply the metadata allowlist.
try {
  const saved = sessionStorage.getItem(key);
  if (saved && saved.length <= 120000) {
    const data = JSON.parse(saved);
    if (Number.isSafeInteger(data.suppressed) && data.suppressed > 0)
      priorSuppressed = data.suppressed;
    if (Array.isArray(data.records))
      for (const record of data.records.slice(-400)) {
        if (record && typeof record === "object")
          tail.add({
            ...metadata(record),
            event: events.has(record.event) ? record.event : "previous-page",
            source: "browser",
            level: ["error", "warn", "info", "debug", "trace"].includes(
              record.level,
            )
              ? record.level
              : "info",
            sequence: Number.isSafeInteger(record.sequence)
              ? record.sequence
              : 0,
            timestamp: /^\d{4}-[\dT:.Z-]+$/.test(record.timestamp)
              ? record.timestamp
              : undefined,
          });
      }
    if (Number.isSafeInteger(data.dropped) && data.dropped > 0)
      tail.dropped += data.dropped;
  }
} catch {}
let persistTimer: number | undefined;
export function flushDiagnostics() {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        records: tail.records,
        dropped: tail.dropped,
        suppressed: priorSuppressed + logger.suppressed - clearedSuppressed,
      }),
    );
  } catch {}
}
const logger = createLogger("browser", level, (record) => {
  tail.add({ ...record, sessionId, pageId });
  try {
    console.debug(JSON.stringify(tail.records.at(-1)));
  } catch {}
  if (persistTimer === undefined)
    persistTimer = window.setTimeout(() => {
      persistTimer = undefined;
      flushDiagnostics();
    }, 2000);
});
export const diagnostic = logger.log;
export const diagnosticsEnabled = logger.enabled;
Object.assign(window, {
  codexWebDiagnostics: {
    export() {
      try {
        return JSON.stringify({
          records: tail.records,
          dropped: tail.dropped,
          suppressed: priorSuppressed + logger.suppressed - clearedSuppressed,
        });
      } catch {
        return "{}";
      }
    },
    clear() {
      tail.clear();
      priorSuppressed = 0;
      clearedSuppressed = logger.suppressed;
      try {
        sessionStorage.removeItem(key);
      } catch {}
    },
  },
});
window.addEventListener(
  "error",
  (event) =>
    diagnostic(
      "error",
      event.target === window ? "browser.error" : "resource.error",
      { stage: "redacted-error" },
    ),
  true,
);
window.addEventListener("unhandledrejection", () =>
  diagnostic("error", "browser.unhandled-rejection"),
);
for (const event of ["online", "offline", "visibilitychange", "pagehide"]) {
  (event === "visibilitychange" ? document : window).addEventListener(
    event,
    () => {
      diagnostic("info", "page.state", {
        online: navigator.onLine,
        hidden: document.hidden,
      });
      if (event === "pagehide") flushDiagnostics();
    },
  );
}
diagnostic("info", "shim.initialize");

// Optional upstream hook: absent in desktop Electron; diagnostics never throw.
Object.assign(globalThis, {
  __codexWebRequestDiagnostic(event: Record<string, unknown>) {
    try {
      diagnostic("debug", "rpc.lifecycle", {
        rpcId: String(event.id),
        method: event.method === "plugin/installed" ? event.method : "other",
        stage: event.timeout
          ? "timeout"
          : event.cancelled
            ? "cancelled"
            : event.type,
      });
    } catch {}
  },
});
if (diagnosticsEnabled) {
  let expected = performance.now() + 1000;
  window.setInterval(() => {
    const now = performance.now();
    if (now - expected > 100)
      diagnostic("debug", "browser.event-loop", {
        eventLoopDelayMs: now - expected,
      });
    expected = now + 1000;
  }, 1000);
}
