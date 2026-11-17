import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

export const bootstrapDiagnostics =
  process.env.CODEX_BOOTSTRAP_DIAGNOSTICS === "1";
const context = new AsyncLocalStorage<string>();
const traceHeader = "x-codex-bootstrap-trace";
const upstreamFetch = globalThis.fetch.bind(globalThis);
export function installBootstrapFetchDiagnostics(): void {
  if (bootstrapDiagnostics) globalThis.fetch = diagnosticFetch;
}
export function diagnostic(event: string, fields: object = {}): void {
  if (bootstrapDiagnostics)
    console.error(
      JSON.stringify({
        diagnostic: "bootstrap",
        event,
        hostMs: performance.now(),
        epochMs: Date.now(),
        ...fields,
      }),
    );
}

export function withBootstrapRequest<T>(message: any, run: () => T): T {
  const data = message?.data;
  const args = data?.[1]?.[3];
  if (
    bootstrapDiagnostics &&
    data?.[0] === "push" &&
    data[1]?.[2]?.[0] === "fetch" &&
    args?.[1]?.url?.split("?")[0].endsWith("/statsig/bootstrap")
  ) {
    diagnostic("bridge-request", { requestId: args[0] });
    return context.run(args[0], run);
  }
  return run();
}

export async function diagnosticFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (!bootstrapDiagnostics) return upstreamFetch(input, init);
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (!url.pathname.endsWith("/statsig/bootstrap"))
    return upstreamFetch(input, init);
  const requestId = context.getStore() ?? randomUUID();
  diagnostic("upstream-start", { requestId, correlated: !!context.getStore() });
  const response = await upstreamFetch(input, init);
  const headers = new Headers(response.headers);
  // Allowlist only: never log cookies, auth, bodies, or arbitrary upstream headers.
  diagnostic("upstream-headers", {
    requestId,
    status: response.status,
    headers: Object.fromEntries(
      [
        "content-type",
        "content-length",
        "content-encoding",
        "x-oai-request-id",
      ].map((key) => [key, headers.get(key)]),
    ),
  });
  headers.set(traceHeader, requestId);
  if (!response.body) return response;
  const reader = response.body.getReader();
  let sequence = 0,
    totalBytes = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        diagnostic("upstream-read-start", { requestId, sequence });
        try {
          const result = await reader.read();
          if (result.done) {
            diagnostic("upstream-end", { requestId, sequence, totalBytes });
            controller.close();
          } else {
            totalBytes += result.value.byteLength;
            diagnostic("upstream-read", {
              requestId,
              sequence: sequence++,
              bytes: result.value.byteLength,
              totalBytes,
            });
            controller.enqueue(result.value);
          }
        } catch (error) {
          diagnostic("upstream-error", { requestId, sequence, totalBytes });
          controller.error(error);
        }
      },
      cancel(reason) {
        diagnostic("upstream-cancel", { requestId, totalBytes });
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  for (const key of ["url", "redirected", "type"] as const)
    Object.defineProperty(wrapped, key, { value: response[key] });
  return wrapped;
}

// Per-connection state avoids stream-ID collisions between tabs/reconnects.
export function createBootstrapSender(socket: WebSocket) {
  const connectionId = randomUUID();
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  if (bootstrapDiagnostics) {
    const probes = new Map<string, number>();
    const probe = () => {
      probes.clear();
      const probeId = randomUUID(),
        hostMs = performance.now();
      probes.set(probeId, hostMs);
      socket.send(JSON.stringify({ type: "bootstrap-clock", probeId }));
    };
    socket.on("message", (raw) => {
      const size = Array.isArray(raw)
        ? raw.reduce((n, buffer) => n + buffer.length, 0)
        : raw instanceof ArrayBuffer
          ? raw.byteLength
          : raw.length;
      if (size > 512) return;
      try {
        const reply = JSON.parse(String(raw));
        const sentHostMs = probes.get(reply.probeId);
        if (
          reply.type === "bootstrap-clock-reply" &&
          sentHostMs !== undefined
        ) {
          diagnostic("clock-sample", {
            connectionId,
            sentHostMs,
            browserMs: reply.browserMs,
            timeOrigin: reply.timeOrigin,
          });
          probes.delete(reply.probeId);
        }
      } catch {
        /* Other IPC is handled by the bridge. */
      }
    });
    probe();
    clockTimer = setInterval(probe, 5000).unref();
  }
  let pendingWrites = 0;
  let sampler: ReturnType<typeof setInterval> | undefined;
  socket.once("close", () => {
    clearInterval(sampler);
    clearInterval(clockTimer);
    streams.clear();
  });
  const streams = new Map<
    string,
    { requestId: string; sequence: number; totalBytes: number }
  >();
  return (message: any) => {
    if (!bootstrapDiagnostics) {
      socket.send(JSON.stringify(message));
      return;
    }
    const data = message?.data;
    const response =
      data?.[0] === "resolve" ? data.at(-1)?.response : undefined;
    if (response) {
      const requestId = response[2]?.headers?.find(
        (h: string[]) => h[0]?.toLowerCase() === traceHeader,
      )?.[1];
      if (requestId)
        streams.set(`${message.portId}:${response[1]?.[1]}`, {
          requestId,
          sequence: 0,
          totalBytes: 0,
        });
    }
    const stream =
      data?.[0] === "stream"
        ? streams.get(`${message.portId}:${data[1]?.[1]}`)
        : undefined;
    const headerId = response?.[2]?.headers?.find(
      (h: string[]) => h[0]?.toLowerCase() === traceHeader,
    )?.[1];
    if (!stream && !headerId) {
      socket.send(JSON.stringify(message));
      return;
    }
    const bytes =
      stream && data[1][2]?.[0] === "write"
        ? (data[1][3] ?? []).reduce(
            (n: number, value: any) =>
              n +
              (value?.[0] === "bytes"
                ? Buffer.from(value[1], "base64url").length
                : 0),
            0,
          )
        : 0;
    if (stream) stream.totalBytes += bytes;
    const trace = {
      connectionId,
      requestId: stream?.requestId ?? headerId,
      streamId: stream ? data[1][1] : response[1][1],
      sequence: stream ? stream.sequence++ : -1,
      operation: stream ? data[1][2]?.[0] : "headers",
      bytes,
      totalBytes: stream?.totalBytes ?? 0,
    };
    diagnostic("serialize-start", trace);
    const serialized = JSON.stringify({ ...message, bootstrapTrace: trace });
    diagnostic("send-queue-insert", {
      ...trace,
      envelopeBytes: Buffer.byteLength(serialized),
      bufferedAmount: socket.bufferedAmount,
    });
    pendingWrites++;
    sampler ??= setInterval(
      () =>
        diagnostic("queue-progress", {
          connectionId,
          pendingWrites,
          bufferedAmount: socket.bufferedAmount,
        }),
      250,
    ).unref();
    socket.send(serialized, (error) => {
      diagnostic("local-write-complete", {
        ...trace,
        failed: !!error,
        bufferedAmount: socket.bufferedAmount,
      });
      if (--pendingWrites === 0) {
        clearInterval(sampler);
        sampler = undefined;
      }
    });
    diagnostic("send-queued", {
      ...trace,
      bufferedAmount: socket.bufferedAmount,
    });
    if (stream && ["close", "error", "abort"].includes(trace.operation))
      streams.delete(`${message.portId}:${data[1][1]}`);
  };
}
