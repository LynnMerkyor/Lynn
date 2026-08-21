import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

type JsonObject = Record<string, unknown>;
type RpcId = string | number;

export interface CodexAppServerMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexAppServerClientOptions {
  command?: string;
  commandArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configOverrides?: string[];
  requestTimeoutMs?: number;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
}

export interface CodexAppServerNotification {
  method: string;
  params: unknown;
}

export interface CodexAppServerRequest {
  id: RpcId;
  method: string;
  params: unknown;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  turn: JsonObject;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
}

type NotificationListener = (notification: CodexAppServerNotification) => void;
type ServerRequestListener = (request: CodexAppServerRequest) => void;
type DiagnosticListener = (message: string) => void;
type ExitListener = (error: Error) => void;

function rpcError(message: CodexAppServerMessage["error"], method: string): Error {
  const detail = message?.message || `Codex app-server request failed: ${method}`;
  const error = new Error(detail);
  error.name = "CodexAppServerRpcError";
  return error;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildCodexAppServerCommandArgs(options: Pick<CodexAppServerClientOptions, "commandArgs" | "configOverrides"> = {}): string[] {
  if (options.commandArgs) return [...options.commandArgs];
  const args = ["app-server", "--stdio"];
  for (const override of options.configOverrides || []) args.push("-c", override);
  return args;
}

export class CodexAppServerClient {
  private readonly options: Required<Pick<CodexAppServerClientOptions, "command" | "requestTimeoutMs" | "clientName" | "clientTitle" | "clientVersion">> & CodexAppServerClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: ReadLineInterface | null = null;
  private stderrLines: ReadLineInterface | null = null;
  private nextRequestId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private notificationListeners = new Set<NotificationListener>();
  private serverRequestListeners = new Set<ServerRequestListener>();
  private diagnosticListeners = new Set<DiagnosticListener>();
  private exitListeners = new Set<ExitListener>();
  private startPromise: Promise<JsonObject> | null = null;
  private stopped = false;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.options = {
      ...options,
      command: options.command || "codex",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      clientName: options.clientName || "lynn",
      clientTitle: options.clientTitle || "Lynn Agent",
      clientVersion: options.clientVersion || "0.0.0",
    };
  }

  get pid(): number | null {
    return this.child?.pid || null;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.stopped;
  }

  async start(): Promise<JsonObject> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<JsonObject> {
    if (this.stopped) throw new Error("Codex app-server client has been stopped");
    const child = spawn(this.options.command, buildCodexAppServerCommandArgs(this.options), {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.stdoutLines.on("line", (line) => this.handleLine(line));
    this.stderrLines.on("line", (line) => this.emitDiagnostic(line));
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => this.handleExit(new Error(`Codex app-server exited (${signal || (code ?? "unknown")})`)));

    const initialized = asObject(await this.request("initialize", {
      clientInfo: {
        name: this.options.clientName,
        title: this.options.clientTitle,
        version: this.options.clientVersion,
      },
      capabilities: null,
    }));
    this.notify("initialized");
    return initialized;
  }

  request(method: string, params?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null || this.stopped) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let abortCleanup: (() => void) | null = null;
      const settleReject = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.abortCleanup?.();
        reject(error);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => settleReject(new Error(`Codex app-server request timed out: ${method}`)), timeoutMs);
        timer.unref?.();
      }
      if (options.signal) {
        const onAbort = () => settleReject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Codex app-server request cancelled"));
        if (options.signal.aborted) {
          reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("Codex app-server request cancelled"));
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, { method, resolve, reject, timer, abortCleanup });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, message: string, code = -32_000, data?: unknown): void {
    this.write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onDiagnostic(listener: DiagnosticListener): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async startThread(params: JsonObject): Promise<JsonObject> {
    return asObject(await this.request("thread/start", params));
  }

  async resumeThread(params: JsonObject): Promise<JsonObject> {
    return asObject(await this.request("thread/resume", params));
  }

  async startTurn(params: JsonObject): Promise<JsonObject> {
    return asObject(await this.request("turn/start", params));
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  waitForTurn(threadId: string, turnId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CodexTurnResult> {
    const timeoutMs = options.timeoutMs ?? 0;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let cleanupNotification: () => void = () => undefined;
      let cleanupExit: () => void = () => undefined;
      const cleanup = () => {
        cleanupNotification();
        cleanupExit();
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        void this.interruptTurn(threadId, turnId).catch(() => undefined);
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Codex turn cancelled"));
      };
      cleanupNotification = this.onNotification((notification) => {
        const params = asObject(notification.params);
        if (stringField(params.threadId) !== threadId) return;
        if (notification.method === "error" && stringField(params.turnId) === turnId && params.willRetry !== true) {
          const error = asObject(params.error);
          cleanup();
          reject(new Error(stringField(error.message) || "Codex turn failed"));
          return;
        }
        if (notification.method !== "turn/completed") return;
        const turn = asObject(params.turn);
        if (stringField(turn.id) !== turnId) return;
        cleanup();
        resolve({ threadId, turnId, turn });
      });
      cleanupExit = this.onExit((error) => {
        cleanup();
        reject(error);
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          void this.interruptTurn(threadId, turnId).catch(() => undefined);
          reject(new Error(`Codex turn timed out: ${turnId}`));
        }, timeoutMs);
        timer.unref?.();
      }
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    this.stdoutLines?.close();
    this.stderrLines?.close();
    this.rejectPending(new Error("Codex app-server stopped"));
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private write(message: CodexAppServerMessage): void {
    if (!this.child || !this.child.stdin.writable || this.child.exitCode !== null || this.stopped) {
      throw new Error("Codex app-server transport is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: CodexAppServerMessage;
    try {
      message = JSON.parse(trimmed) as CodexAppServerMessage;
    } catch {
      this.emitDiagnostic(`Ignored non-JSON app-server stdout: ${trimmed.slice(0, 500)}`);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.abortCleanup?.();
      if (message.error) pending.reject(rpcError(message.error, pending.method));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const request = { id: message.id, method: message.method, params: message.params };
      for (const listener of this.serverRequestListeners) listener(request);
      return;
    }
    if (message.method) {
      const notification = { method: message.method, params: message.params };
      for (const listener of this.notificationListeners) listener(notification);
    }
  }

  private handleExit(error: Error): void {
    this.rejectPending(error);
    for (const listener of [...this.exitListeners]) listener(error);
    this.emitDiagnostic(error.message);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.abortCleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitDiagnostic(message: string): void {
    const safe = String(message || "").slice(0, 2_000);
    for (const listener of this.diagnosticListeners) listener(safe);
  }
}
