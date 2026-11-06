import {
  diagnostic,
  diagnosticsEnabled,
  flushDiagnostics,
  sessionId,
  pageId,
} from "./diagnostics";
import {
  rpcMetadata,
  validEnvelope,
  routeCategory,
} from "../server/diagnostics/core";
import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
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
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
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

const RECONNECT_DELAY_MS = 1_000;

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let needsReload = false;
let reconnectTimeoutId: number | null = null;
let connectionId = "";
let highWater = 0;
let lastSend = performance.now(),
  lastReceive = lastSend;
const queuedAt = new WeakMap<object, number>();
const started = new Map<string, number>();
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  diagnostic("trace", "ipc.dispatch", { listeners: listeners?.size ?? 0 });
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    try {
      listener(event, ...args);
    } catch (error) {
      diagnostic("error", "ipc.listener-failure");
      throw error;
    }
  }
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      diagnostic("warn", "request.unknown", {
        requestId: message.requestId,
        connectionId,
      });
      return;
    }
    settle(message.requestId, message.ok);
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    diagnostic(
      messagePorts.has(message.portId) ? "trace" : "warn",
      "port.forward",
      {
        portId: message.portId,
        connectionId,
        ok: messagePorts.has(message.portId),
      },
    );
    try {
      messagePorts.get(message.portId)?.postMessage(message.data);
    } catch (error) {
      diagnostic("error", "port.forward-failure", { portId: message.portId });
      throw error;
    }
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    diagnostic(port ? "debug" : "warn", "port.close", {
      portId: message.portId,
    });
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      diagnostic("warn", "request.unknown", {
        requestId: message.requestId,
        connectionId,
      });
      return;
    }
    settle(message.requestId, message.ok);
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  diagnostic("trace", "queue.flush", {
    connectionId,
    queueLength: outboundQueue.length,
  });
  for (const message of outboundQueue.splice(0)) {
    const fields = {
      connectionId,
      ...message,
      ...rpcMetadata(message),
      ageMs: performance.now() - (queuedAt.get(message) ?? performance.now()),
    };
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch (error) {
      diagnostic("error", "transport.serialize-failure", fields);
      throw error;
    }
    try {
      socket.send(encoded);
      lastSend = performance.now();
      diagnostic("trace", "transport.send-api", {
        ...fields,
        bytes: encoded.length,
        bufferedAmount: socket.bufferedAmount,
      });
    } catch (error) {
      diagnostic("error", "transport.send-failure", fields);
      throw error;
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    diagnostic("debug", "reconnect.skipped");
    return;
  }
  diagnostic("info", "reconnect.scheduled");
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    diagnostic("info", "reconnect.attempt");
    ensureSocket();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  connectionId = crypto.randomUUID();
  const attemptId = connectionId;
  const began = performance.now();
  diagnostic("info", "socket.attempt", { connectionId, sessionId, pageId });
  socket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc?diagConnection=${connectionId}&diagSession=${sessionId}&diagPage=${pageId}`,
  );
  const originatingSocket = socket;
  const context = () => ({
    connectionId: attemptId,
    current: socket === originatingSocket,
    durationMs: performance.now() - began,
  });
  socket.addEventListener("open", () => {
    diagnostic("info", "socket.open", context());
    // App-host RPC transfers MessagePorts once at startup. A new connection needs
    // a fresh app view; replaying requests against the closed ports cannot recover it.
    if (needsReload) {
      diagnostic("info", "page.reload", { ...context(), stage: "reconnect" });
      flushDiagnostics();
      window.location.reload();
      return;
    }
    flushOutboundQueue();
  });
  socket.addEventListener("message", (event) => {
    lastReceive = performance.now();
    let message: MainToRendererMessage;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      diagnostic("error", "transport.decode-failure", context());
      return;
    }
    if (!validEnvelope(message)) {
      diagnostic("warn", "transport.invalid-envelope", context());
      return;
    }
    diagnostic("trace", "transport.receive", {
      ...context(),
      ...message,
      ...rpcMetadata(message),
    });
    try {
      handleIncomingMessage(message);
    } catch {
      diagnostic("error", "ipc.dispatch-failure", {
        ...context(),
        ...message,
        ...rpcMetadata(message),
      });
    }
  });
  socket.addEventListener("close", (event) => {
    diagnostic("warn", "socket.close", {
      ...context(),
      code: event.code,
      wasClean: event.wasClean,
      queueLength: outboundQueue.length,
      pending: pendingInvokes.size + pendingDirectoryEntries.size,
      ports: messagePorts.size,
      online: navigator.onLine,
      hidden: document.hidden,
      sendAgeMs: performance.now() - lastSend,
      receiveAgeMs: performance.now() - lastReceive,
    });
    for (const requestId of started.keys())
      diagnostic("warn", "request.disconnect", { ...context(), requestId });
    started.clear();
    needsReload = true;
    const error = new Error("Connection to Codex was lost");
    for (const pending of pendingInvokes.values()) pending.reject(error);
    pendingInvokes.clear();
    for (const pending of pendingDirectoryEntries.values())
      pending.reject(error);
    pendingDirectoryEntries.clear();
    outboundQueue.length = 0;
    for (const [portId, port] of messagePorts) {
      diagnostic("debug", "port.disconnect", { ...context(), portId });
      port.close();
    }
    messagePorts.clear();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    diagnostic("error", "socket.error", context());
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  queuedAt.set(message, performance.now());
  outboundQueue.push(message);
  highWater = Math.max(highWater, outboundQueue.length);
  diagnostic("trace", "queue.enqueue", {
    ...message,
    ...rpcMetadata(message),
    connectionId,
    queueLength: outboundQueue.length,
    highWater,
  });
  ensureSocket();
  flushOutboundQueue();
}

function startRequest(requestId: string) {
  started.set(requestId, performance.now());
  diagnostic("debug", "request.start", {
    requestId,
    connectionId,
    pending: started.size,
  });
}
function settle(requestId: string, ok: boolean) {
  diagnostic(ok ? "debug" : "warn", "request.settle", {
    requestId,
    connectionId,
    ok,
    durationMs:
      performance.now() - (started.get(requestId) ?? performance.now()),
  });
  started.delete(requestId);
}
if (diagnosticsEnabled)
  window.setInterval(() => {
    let oldest = Infinity;
    for (const time of started.values()) oldest = Math.min(oldest, time);
    if (performance.now() - oldest > 10000)
      diagnostic("warn", "request.slow", {
        connectionId,
        pending: started.size,
        ageMs: performance.now() - oldest,
      });
  }, 10000);

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    startRequest(requestId);
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
  diagnostic("debug", "ipc.listener-register", { listeners: listeners.size });
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    startRequest(requestId);
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
    },
  },
});

electronShim.overrideAdapter = {
  getGateOverride(evaluation) {
    if (evaluation.name === "2911712394") {
      return {
        ...evaluation,
        value: true,
      };
    }

    if (evaluation.name === "1042620455") {
      // Remote control (Slingshot).
      return {
        ...evaluation,
        value: true,
      };
    }

    return null;
  },
};

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;
diagnostic("info", "route.initial", {
  route: routeCategory(window.location.pathname),
  version: __CODEX_APP_VERSION__,
});

if (initialRoute.browserPath) {
  diagnostic("debug", "history.push");
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  diagnostic("debug", "route.memory", {
    action: navigation.action,
    route: routeCategory(path),
  });
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    diagnostic("debug", "history.replace");
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  diagnostic("debug", "history.push");
  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        diagnostic("debug", "port.register", {
          portId,
          connectionId,
          ports: messagePorts.size,
        });
        transferable.addEventListener("message", (event) => {
          diagnostic("trace", "port.receive", { portId, connectionId });
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          diagnostic("warn", "port.messageerror", { portId, connectionId });
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        diagnostic("debug", "port.start", { portId, connectionId });
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return null;
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return unimplemented("webUtils.getPathForFile");
  },
};
