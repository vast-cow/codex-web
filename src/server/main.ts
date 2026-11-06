#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { diagnostic, serverId } from "./diagnostics";
import {
  identity,
  rpcMetadata,
  validEnvelope,
  routeCategory,
} from "./diagnostics/core";
import { errorMonitor } from "node:events";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { registerStaticRoutes } from "./staticRoutes";
import { installModuleAliasHook } from "./module";

type ServerOptions = {
  host: string;
  port: number;
};

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

type MessagePortListener = (...args: unknown[]) => void;

type BridgedMessagePort = {
  close: () => void;
  on: (event: string, listener: MessagePortListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};

class WebSocketMessagePort implements BridgedMessagePort {
  private closed = false;
  private queuedSince = 0;
  private receivedCount = 0;
  private sentCount = 0;
  private readonly pendingMessages: unknown[] = [];
  private readonly listeners = new Map<string, Set<MessagePortListener>>();

  constructor(
    private readonly portId: string,
    private readonly sendToRenderer: (message: MainToRendererMessage) => void,
    private readonly onClosed: () => void,
    private readonly log: typeof diagnostic,
  ) {}

  on(event: string, listener: MessagePortListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    this.log("debug", "port.listener", {
      listeners: listeners.size,
      queueLength: this.pendingMessages.length,
    });
    if (event === "message") {
      this.log("debug", "port.flush", {
        queueLength: this.pendingMessages.length,
        queueWaitMs: this.queuedSince
          ? performance.now() - this.queuedSince
          : 0,
      });
      this.queuedSince = 0;
      for (const data of this.pendingMessages.splice(0)) {
        this.receiveMessage(data);
      }
    }

    return this;
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      this.log("warn", "port.closed-use");
      return;
    }
    this.log("trace", "port.send", { count: ++this.sentCount });
    this.sendToRenderer({
      type: "message-port-message",
      portId: this.portId,
      data,
    });
  }

  start(): void {
    this.log("debug", "port.start");
  }

  close(): void {
    if (!this.markClosed()) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-close",
      portId: this.portId,
    });
  }

  receiveMessage(data: unknown): void {
    if (this.closed) {
      this.log("warn", "port.closed-use");
      return;
    }
    this.log("trace", "port.receive", { count: ++this.receivedCount });
    const listeners = this.listeners.get("message");
    if (!listeners || listeners.size === 0) {
      if (this.pendingMessages.length === 0)
        this.queuedSince = performance.now();
      this.pendingMessages.push(data);
      this.log("trace", "port.queue", {
        queueLength: this.pendingMessages.length,
      });
      return;
    }
    for (const listener of listeners) {
      try {
        listener({ data });
      } catch (error) {
        this.log("error", "port.listener-failure");
        throw error;
      }
    }
  }

  disconnect(): void {
    if (!this.markClosed()) {
      return;
    }
    this.emit("close");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private markClosed(): boolean {
    if (this.closed) {
      return false;
    }
    this.log("debug", "port.close", {
      queueLength: this.pendingMessages.length,
    });
    this.closed = true;
    this.pendingMessages.length = 0;
    this.onClosed();
    return true;
  }
}

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type RendererWindow = {
  id: number;
  webContents: { id: number };
  destroy: () => void;
};

type IpcMainBridgeState = {
  setRendererWindowFactory?: (factory: () => Promise<RendererWindow>) => void;
  sendToRenderer?: (
    webContentsId: number,
    message: MainToRendererMessage,
  ) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    windowId: number,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => void;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  process.env.BUILD_FLAVOR = "prod";

  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    getSystemVersion?: () => string;
    resourcesPath?: string;
    type?: string;
  };
  const systemVersion =
    process.platform === "darwin"
      ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
        }).trim()
      : os.release();
  processWithElectronFields.getSystemVersion ??= () => systemVersion;
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  diagnostic("info", "server.start", { serverId });
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({ noServer: true });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Infinity,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  await registerStaticRoutes(
    app,
    path.resolve(__dirname, "../../scratch/asar/webview"),
    diagnostic,
  );

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  const rendererSockets = new Map<number, WebSocket>();
  const rendererWindowFactory = new Promise<() => Promise<RendererWindow>>(
    (resolve) => {
      bridgeState.setRendererWindowFactory = resolve;
    },
  );
  const socketContexts = new WeakMap<WebSocket, Record<string, unknown>>();
  function send(socket: WebSocket | undefined, message: MainToRendererMessage) {
    const context = socket ? socketContexts.get(socket) : {};
    if (socket?.readyState !== WebSocket.OPEN) {
      diagnostic("warn", "reply.skipped", { ...context, ...message });
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch (error) {
      diagnostic("error", "transport.serialize-failure", context);
      throw error;
    }
    const sendStarted = performance.now();
    try {
      socket.send(encoded, (error) => {
        diagnostic(error ? "error" : "debug", "transport.dispatch-complete", {
          ...context,
          ...message,
          ...rpcMetadata(message),
          ok: !error,
          sendCallbackMs: performance.now() - sendStarted,
        });
      });
      diagnostic("trace", "transport.send-api", {
        ...context,
        ...message,
        ...rpcMetadata(message),
        bytes: encoded.length,
        bufferedAmount: socket.bufferedAmount,
      });
    } catch (error) {
      diagnostic("error", "transport.send-failure", context);
      throw error;
    }
  }
  bridgeState.sendToRenderer = (webContentsId, message): void => {
    const socket = rendererSockets.get(webContentsId);
    diagnostic("debug", "response.route", {
      ...(socket ? socketContexts.get(socket) : {}),
      webContentsId,
      ...message,
      ...rpcMetadata(message),
    });
    if (!socket)
      diagnostic("warn", "reply.target-missing", { webContentsId, ...message });
    send(socket, message);
  };

  websocketServer.on("connection", (socket, request) => {
    const params = new URL(request.url ?? "/", "http://localhost").searchParams;
    const context = {
      connectionId: identity(params.get("diagConnection")),
      sessionId: identity(params.get("diagSession")),
      pageId: identity(params.get("diagPage")),
    };
    socketContexts.set(socket, context);
    const began = performance.now();
    const log: typeof diagnostic = (level, event, fields) =>
      diagnostic(level, event, { ...context, ...fields });
    log("info", "socket.open");
    log("debug", "renderer.factory-wait");
    let rendererWindow: RendererWindow | undefined;
    // Each tab is a real registered app view, with its own IPC client and ownership.
    const rendererReady = rendererWindowFactory
      .then(async (createWindow) => {
        if (socket.readyState !== WebSocket.OPEN) {
          log("debug", "renderer.disconnected-before-create");
          return undefined;
        }
        log("debug", "renderer.create");
        const window = await createWindow();
        if (socket.readyState !== WebSocket.OPEN) {
          log("debug", "renderer.disconnected-during-create");
          window.destroy();
          return undefined;
        }
        rendererWindow = window;
        rendererSockets.set(window.webContents.id, socket);
        Object.assign(context, {
          windowId: window.id,
          webContentsId: window.webContents.id,
        });
        log("info", "renderer.ready", {
          durationMs: performance.now() - began,
        });
        return window;
      })
      .catch((error) => {
        log("error", "renderer.initialize-failure");
        socket.close(1011, "Renderer initialization failed");
        return undefined;
      });

    // Monitor errors without consuming EventEmitter error events.
    socket.on(errorMonitor, () => log("error", "socket.error"));
    const messagePorts = new Map<string, WebSocketMessagePort>();
    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
      windowId: number,
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, windowId);
        return;
      }

      log("error", "ipc.missing-handler");
      for (const port of ports) {
        port.close();
      }
    };

    socket.on("close", (code) => {
      log("warn", "socket.close", {
        code,
        ports: messagePorts.size,
        connectionAgeMs: performance.now() - began,
      });
      for (const port of messagePorts.values()) {
        port.disconnect();
      }
      messagePorts.clear();
      if (rendererWindow) {
        rendererSockets.delete(rendererWindow.webContents.id);
        log("debug", "renderer.cleanup");
        rendererWindow.destroy();
      }
    });

    socket.on("message", async (rawData) => {
      const received = performance.now();
      log("trace", "transport.receive");
      const window = await rendererReady;
      log("trace", "renderer.wait-complete", {
        durationMs: performance.now() - received,
      });
      if (!window || socket.readyState !== WebSocket.OPEN) return;
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        log("error", "transport.decode-failure");
        return;
      }

      if (!validEnvelope(message)) {
        log("warn", "transport.invalid-envelope");
        return;
      }
      log("trace", "ipc.dispatch", { ...message, ...rpcMetadata(message) });
      try {
        if (message.type === "ipc-renderer-send") {
          bridgeState.handleRendererSend?.(
            message.channel,
            message.args,
            window.id,
          );
          return;
        }

        if (message.type === "ipc-renderer-post-message") {
          if (new Set(message.portIds).size !== message.portIds.length) {
            log("warn", "port.duplicate-transfer");
            return;
          }

          const ports = message.portIds.map((portId) => {
            const existingPort = messagePorts.get(portId);
            if (existingPort) {
              log("debug", "port.replace", { portId });
              existingPort.disconnect();
            }
            const port = new WebSocketMessagePort(
              portId,
              (message) => {
                send(socket, message);
              },
              () => messagePorts.delete(portId),
              (level, event, fields) =>
                log(level, event, { ...fields, portId }),
            );
            messagePorts.set(portId, port);
            log("debug", "port.register", { portId, ports: messagePorts.size });
            return port;
          });

          dispatchPostMessage(
            message.channel,
            message.message,
            ports,
            window.id,
          );
          return;
        }

        if (message.type === "message-port-message") {
          log(
            messagePorts.has(message.portId) ? "trace" : "warn",
            "port.forward",
            { portId: message.portId, ok: messagePorts.has(message.portId) },
          );
          messagePorts.get(message.portId)?.receiveMessage(message.data);
          return;
        }

        if (message.type === "message-port-close") {
          log(
            messagePorts.has(message.portId) ? "debug" : "warn",
            "port.disconnect",
            { portId: message.portId },
          );
          messagePorts.get(message.portId)?.disconnect();
          return;
        }

        if (message.type === "workspace-directory-entries-request") {
          const { requestId } = message;
          const handlerStarted = performance.now();
          log("debug", "handler.start", { requestId, ...rpcMetadata(message) });
          getWorkspaceDirectoryEntries(message)
            .then((result) => {
              const payload: MainToRendererMessage = {
                type: "workspace-directory-entries-result",
                requestId,
                ok: true,
                result,
              };
              log("debug", "handler.complete", {
                requestId,
                ok: payload.ok,
                durationMs: performance.now() - received,
                handlerExecutionMs: performance.now() - handlerStarted,
                ...rpcMetadata(message),
              });
              send(socket, payload);
            })
            .catch((error) => {
              const payload: MainToRendererMessage = {
                type: "workspace-directory-entries-result",
                requestId,
                ok: false,
                errorMessage: errorMessage(error),
              };
              log("debug", "handler.complete", {
                requestId,
                ok: payload.ok,
                durationMs: performance.now() - received,
                handlerExecutionMs: performance.now() - handlerStarted,
                ...rpcMetadata(message),
              });
              send(socket, payload);
            });
          return;
        }

        if (message.type === "ipc-renderer-invoke") {
          const { channel, requestId, args } = message;
          const handlerStarted = performance.now();
          log("debug", "handler.start", { requestId, ...rpcMetadata(message) });
          Promise.resolve(
            bridgeState.handleRendererInvoke?.(channel, args, window.id) ??
              Promise.reject(
                new Error(
                  `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
                ),
              ),
          )
            .then((result) => {
              const payload: MainToRendererMessage = {
                type: "ipc-renderer-invoke-result",
                requestId,
                ok: true,
                result,
              };
              log("debug", "handler.complete", {
                requestId,
                ok: payload.ok,
                durationMs: performance.now() - received,
                handlerExecutionMs: performance.now() - handlerStarted,
                ...rpcMetadata(message),
              });
              send(socket, payload);
            })
            .catch((error) => {
              const payload: MainToRendererMessage = {
                type: "ipc-renderer-invoke-result",
                requestId,
                ok: false,
                errorMessage: errorMessage(error),
              };
              log("debug", "handler.complete", {
                requestId,
                ok: payload.ok,
                durationMs: performance.now() - received,
                handlerExecutionMs: performance.now() - handlerStarted,
                ...rpcMetadata(message),
              });
              send(socket, payload);
            });
        }
      } catch (error) {
        log("error", "ipc.dispatch-failure", {
          ...message,
          ...rpcMetadata(message),
        });
        throw error;
      }
    });
  });

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../scratch/asar/package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
  };

  // The upstream entrypoint initializes network policy and starts the app once.
  require(path.resolve(__dirname, "../../scratch/asar", packageJson.main));
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));
