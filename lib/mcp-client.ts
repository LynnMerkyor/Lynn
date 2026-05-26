/**
 * mcp-client.ts — MCP (Model Context Protocol) 客户端
 *
 * 支持：
 * - stdio 传输
 * - SSE 传输（远程 MCP）
 * - tools/list + tools/call
 * - resources/list
 * - 兼容 Cursor / Codex / Claude Desktop / VS Code 的 MCP 配置发现
 *
 * 配置文件：~/.lynn/mcp-servers.yaml
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { createModuleLogger } from "./debug-log.js";
import { Type } from "@sinclair/typebox";
import { MCP_BUILTIN_SERVERS, MCP_DISCOVERY_PATHS } from "./mcp/mcp-catalog.js";

const log = createModuleLogger("mcp");
let _msgId = 0;

type HeaderMap = Record<string, string>;
type RawObject = Record<string, unknown>;
type TimerHandle = ReturnType<typeof setTimeout>;

export type McpTransport = "stdio" | "sse" | "http";
export type McpServerTemplateKind = McpTransport;

export interface RawMcpServerConfig extends RawObject {
  disabled?: unknown;
  transport?: unknown;
  url?: unknown;
  headers?: unknown;
  messageUrl?: unknown;
  message_url?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}

interface McpServerConfigBase extends RawObject {
  disabled: boolean;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;
  args: string[];
  env: RawObject;
  cwd: string;
}

export interface McpSseServerConfig extends McpServerConfigBase {
  transport: "sse";
  url: string;
  headers: HeaderMap;
  messageUrl: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  url: string;
  headers: HeaderMap;
}

export type NormalizedMcpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;
type McpServerConfigMap = Record<string, NormalizedMcpServerConfig>;

export interface BuiltinCredentialSpec {
  key: string;
  label?: string;
  placeholder?: string;
  secret?: boolean;
}

export interface SanitizedBuiltinCredentialSpec {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  value: string;
}

interface BuiltinMcpServer {
  name: string;
  label: string;
  group?: string;
  description: string;
  docsUrl: string;
  transport: McpTransport;
  config: RawMcpServerConfig;
  credentialFields: BuiltinCredentialSpec[];
  hint?: string;
}

interface BuiltinCredentialEntry extends RawObject {
  enabled?: unknown;
  credentials?: unknown;
}

type BuiltinCredentialStore = Record<string, BuiltinCredentialEntry>;
type CredentialValues = Record<string, unknown>;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface McpResource {
  name?: string;
  title?: string;
  uri?: string;
  [key: string]: unknown;
}

interface McpListToolsResult {
  tools?: McpTool[];
}

interface McpListResourcesResult {
  resources?: McpResource[];
}

interface McpToolCallResult {
  content?: RawObject[];
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, args?: unknown): Promise<{ content: RawObject[] }>;
}

export interface McpServerState {
  name: string;
  transport: McpTransport;
  disabled: boolean;
  command: string;
  args: string[];
  cwd: string;
  url: string;
  headers: HeaderMap;
  messageUrl: string;
  source: "builtin" | "local" | "discovered";
  sourcePath: string | string[] | null;
  builtin: boolean;
  label: string;
  docsUrl: string;
  connected: boolean;
  lastError: string | null;
  toolCount: number;
  resourceCount: number;
  tools: Array<{ name: string; description: string }>;
  resources: Array<{ name: string | undefined; uri: string }>;
}

export interface McpBuiltinState {
  name: string;
  label: string;
  group: string;
  description: string;
  docsUrl: string;
  hint: string;
  transport: McpTransport;
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  lastError: string | null;
  toolCount: number;
  resourceCount: number;
  tools: McpServerState["tools"];
  resources: McpServerState["resources"];
  credentialFields: SanitizedBuiltinCredentialSpec[];
}

export interface SaveBuiltinCredentialsPayload {
  credentials?: CredentialValues;
  enabled?: boolean;
}

export interface McpTestServerResult {
  ok: true;
  toolCount: number;
  resourceCount: number;
  tools: Array<{ name: string; description: string }>;
  resources: Array<{ name: string | undefined; uri: string }>;
}

type JsonRpcId = string | number | null;

interface JsonRpcErrorPayload {
  message?: string;
  [key: string]: unknown;
}

interface JsonRpcResponsePayload {
  jsonrpc?: "2.0" | string;
  id?: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

interface JsonRpcOutboundPayload {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface PendingJsonRpcRequest {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
}

interface HttpPostOptions {
  notification?: boolean;
}

const BUILTIN_SERVERS = MCP_BUILTIN_SERVERS as unknown as Record<string, BuiltinMcpServer>;
const DISCOVERY_PATHS = MCP_DISCOVERY_PATHS as unknown as string[];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeHeaders(value: unknown): HeaderMap {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, headerValue]) => headerValue !== undefined && headerValue !== null && headerValue !== "")
      .map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

function normalizeArgs(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function cloneDeep<T>(value: T): T | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function replaceCredentialPlaceholders(value: unknown, credentials: CredentialValues): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      const credentialValue = credentials?.[String(key).trim()];
      return credentialValue === undefined || credentialValue === null ? "" : String(credentialValue);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceCredentialPlaceholders(item, credentials));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceCredentialPlaceholders(item, credentials)]),
    );
  }
  return value;
}

function normalizeServerConfig(raw: RawMcpServerConfig = {}): NormalizedMcpServerConfig {
  const base = {
    disabled: raw.disabled === true,
  };

  if (raw.transport === "http" || raw.transport === "streamable-http") {
    return {
      ...base,
      transport: "http",
      url: String(raw.url || "").trim(),
      headers: normalizeHeaders(raw.headers),
    };
  }

  if (raw.transport === "sse" || raw.url) {
    return {
      ...base,
      transport: "sse",
      url: String(raw.url || "").trim(),
      headers: normalizeHeaders(raw.headers),
      messageUrl: (raw.messageUrl || raw.message_url || "") as string,
    };
  }

  return {
    ...base,
    transport: "stdio",
    command: String(raw.command || "").trim(),
    args: normalizeArgs(raw.args),
    env: raw.env && typeof raw.env === "object" ? raw.env as RawObject : {},
    cwd: raw.cwd ? String(raw.cwd).trim() : "",
  };
}

function serializeServerConfig(config: RawMcpServerConfig = {}): RawMcpServerConfig {
  const normalized = normalizeServerConfig(config);
  if (normalized.transport === "http") {
    return {
      transport: "http",
      url: normalized.url,
      ...(Object.keys(normalized.headers || {}).length > 0 ? { headers: normalized.headers } : {}),
      ...(normalized.disabled ? { disabled: true } : {}),
    };
  }
  if (normalized.transport === "sse") {
    return {
      transport: "sse",
      url: normalized.url,
      ...(Object.keys(normalized.headers || {}).length > 0 ? { headers: normalized.headers } : {}),
      ...(normalized.messageUrl ? { messageUrl: normalized.messageUrl } : {}),
      ...(normalized.disabled ? { disabled: true } : {}),
    };
  }

  return {
    command: normalized.command,
    ...(normalized.args?.length ? { args: normalized.args } : {}),
    ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
    ...(normalized.env && Object.keys(normalized.env).length > 0 ? { env: normalized.env } : {}),
    ...(normalized.disabled ? { disabled: true } : {}),
  };
}

function resolveDiscoveryPath(lynnHome: string, relativePath: string): string {
  const homeDir = path.dirname(lynnHome);
  return path.join(homeDir, relativePath);
}

function sanitizeBuiltinCredentialFields(
  fields: BuiltinCredentialSpec[] = [],
  credentials: CredentialValues = {},
): SanitizedBuiltinCredentialSpec[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label || field.key,
    placeholder: field.placeholder || "",
    secret: field.secret !== false,
    value: credentials?.[field.key] ? String(credentials[field.key]) : "",
  }));
}

function parseCompatConfig(rawPath: string): McpServerConfigMap {
  try {
    if (!fs.existsSync(rawPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(rawPath, "utf-8")) as {
      servers?: unknown;
      mcpServers?: unknown;
      mcp_servers?: unknown;
    };
    const rawServers = parsed?.servers || parsed?.mcpServers || parsed?.mcp_servers || {};
    if (!rawServers || typeof rawServers !== "object") return {};

    const servers: McpServerConfigMap = {};
    for (const [name, rawConfig] of Object.entries(rawServers)) {
      if (!rawConfig || typeof rawConfig !== "object") continue;
      const normalized = normalizeServerConfig(rawConfig as RawMcpServerConfig);
      if (normalized.transport === "sse" && !normalized.url) continue;
      if (normalized.transport === "stdio" && !normalized.command) continue;
      servers[name] = normalized;
    }
    return servers;
  } catch (err) {
    log.log(`compat config parse failed (${rawPath}): ${errorMessage(err)}`);
    return {};
  }
}

function deriveSseMessageUrl(url: unknown): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  if (/\/sse\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/sse\/?$/i, "/messages");
  }
  return `${trimmed.replace(/\/+$/, "")}/messages`;
}

function parseSseEvent(block: unknown): { eventName: string; data: string } {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const rawLine of String(block || "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return {
    eventName,
    data: dataLines.join("\n").trim(),
  };
}

abstract class McpConnectionBase<TConfig extends NormalizedMcpServerConfig = NormalizedMcpServerConfig> {
  readonly name: string;
  readonly config: TConfig;
  protected _pending: Map<number, PendingJsonRpcRequest>;
  protected _tools: McpTool[];
  protected _resources: McpResource[];
  protected _ready: boolean;
  protected _lastError: string | null;
  protected _closed: boolean;

  constructor(name: string, config: TConfig) {
    this.name = name;
    this.config = normalizeServerConfig(config) as TConfig;
    this._pending = new Map();
    this._tools = [];
    this._resources = [];
    this._ready = false;
    this._lastError = null;
    this._closed = false;
  }

  get tools(): McpTool[] { return this._tools; }
  get resources(): McpResource[] { return this._resources; }
  get ready(): boolean { return this._ready; }
  get lastError(): string | null { return this._lastError; }

  abstract connect(): Promise<unknown>;
  abstract close(): void;
  protected abstract _sendRequest(method: string, params: unknown): Promise<unknown>;

  async listTools(): Promise<McpTool[]> {
    if (!this._ready) return [];
    try {
      const result = await this._sendRequest("tools/list", {}) as McpListToolsResult;
      this._tools = result?.tools || [];
      return this._tools;
    } catch (err) {
      this._lastError = errorMessage(err);
      log.log(`[${this.name}] tools/list failed: ${this._lastError}`);
      return [];
    }
  }

  async listResources(): Promise<McpResource[]> {
    if (!this._ready) return [];
    try {
      const result = await this._sendRequest("resources/list", {}) as McpListResourcesResult;
      this._resources = result?.resources || [];
      return this._resources;
    } catch (err) {
      // resources/list 不是所有服务器都支持，静默降级
      return [];
    }
  }

  async callTool(toolName: string, args: unknown): Promise<McpToolCallResult> {
    if (!this._ready) throw new Error(`MCP server "${this.name}" not ready`);
    return this._sendRequest("tools/call", { name: toolName, arguments: args }) as Promise<McpToolCallResult>;
  }

  protected _handleJsonRpcMessage(msg: JsonRpcResponsePayload | null | undefined): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.id && this._pending.has(msg.id as number)) {
      const pending = this._pending.get(msg.id as number);
      if (!pending) return;
      const { resolve, reject } = pending;
      this._pending.delete(msg.id as number);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  protected _rejectPending(err: Error): void {
    for (const [, { reject }] of this._pending) {
      reject(err);
    }
    this._pending.clear();
  }
}

class McpStdioConnection extends McpConnectionBase<McpStdioServerConfig> {
  private command: string;
  private args: string[];
  private env: RawObject;
  private cwd: string | undefined;
  private _process: ChildProcessWithoutNullStreams | null;
  private _buffer: string;

  constructor(name: string, config: McpStdioServerConfig) {
    super(name, config);
    this.command = this.config.command;
    this.args = this.config.args || [];
    this.env = this.config.env || {};
    this.cwd = this.config.cwd || undefined;
    this._process = null;
    this._buffer = "";
  }

  async connect(): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`MCP server "${this.name}" startup timeout`)), 15000);

      try {
        // 2026-05-24 P2 security: 不把整个 process.env 泄给 MCP 子进程 —
        // brain.env 装进 process.env 后,任何 npx/uvx spawn 的 MCP server 都能从 env 抓到
        // DEEPSEEK_KEY / ZHIPU_KEY / OPENAI_KEY 等上游凭据。
        // 白名单只透传 PATH / HOME / LANG 等无害变量 + caller 显式 this.env (catalog 配置的 token)。
        const SAFE_ENV_KEYS = new Set([
          "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
          "TMPDIR", "TMP", "TEMP", "PWD", "HOSTNAME", "OSTYPE",
          "NODE_PATH", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_PREFIX", "NPM_CONFIG_REGISTRY",
          "PYTHONPATH", "PYTHONHOME", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PROJECT_ENVIRONMENT",
          "ELECTRON_RUN_AS_NODE",
        ]);
        const filteredParentEnv: NodeJS.ProcessEnv = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (SAFE_ENV_KEYS.has(k) || k.startsWith("LYNN_MCP_")) filteredParentEnv[k] = v;
        }
        this._process = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...filteredParentEnv, ...(this.env as NodeJS.ProcessEnv) },
          stdio: ["pipe", "pipe", "pipe"],
        });

        this._process.stdout.on("data", (chunk) => this._onData(chunk));
        this._process.stderr.on("data", (chunk) => {
          log.log(`[${this.name}] stderr: ${chunk.toString().trim()}`);
        });
        this._process.on("error", (err) => {
          clearTimeout(timeout);
          this._lastError = err.message;
          reject(err);
        });
        this._process.on("exit", (code) => {
          log.log(`[${this.name}] exited with code ${code}`);
          this._ready = false;
        });

        this._sendRequest("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "lynn", version: "1.0.0" },
        }).then((result) => {
          clearTimeout(timeout);
          this._sendNotification("notifications/initialized", {});
          this._ready = true;
          this._lastError = null;
          resolve(result);
        }).catch((err) => {
          clearTimeout(timeout);
          this._lastError = errorMessage(err);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        this._lastError = errorMessage(err);
        reject(err);
      }
    });
  }

  close(): void {
    this._ready = false;
    this._closed = true;
    if (this._process) {
      try { this._process.kill(); } catch {}
      this._process = null;
    }
    this._rejectPending(new Error("Connection closed"));
  }

  protected _sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++_msgId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this._process!.stdin.write(msg);
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  private _sendNotification(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try { this._process?.stdin.write(msg); } catch {}
  }

  private _onData(chunk: Buffer): void {
    this._buffer += chunk.toString();
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this._handleJsonRpcMessage(JSON.parse(line) as JsonRpcResponsePayload);
      } catch {}
    }
  }
}

class McpSseConnection extends McpConnectionBase<McpSseServerConfig> {
  private url: string;
  private headers: HeaderMap;
  private _messageUrl: string;
  private _streamController: AbortController | null;
  private _reconnectTimer: TimerHandle | null;
  private _reconnectDelayMs: number;
  private _waitingForEndpoint: Array<{ resolve(value: string): void }>;

  constructor(name: string, config: McpSseServerConfig) {
    super(name, config);
    this.url = this.config.url;
    this.headers = normalizeHeaders(this.config.headers);
    this._messageUrl = this.config.messageUrl || "";
    this._streamController = null;
    this._reconnectTimer = null;
    this._reconnectDelayMs = 1000;
    this._waitingForEndpoint = [];
  }

  async connect(): Promise<unknown> {
    this._closed = false;
    this._ready = false;
    this._lastError = null;

    const controller = new AbortController();
    this._streamController = controller;
    const connectTimeout = setTimeout(() => controller.abort(new DOMException("MCP SSE connect timeout", "AbortError")), 15000);

    try {
      const res = await fetch(this.url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...this.headers,
        },
        signal: controller.signal,
      });
      clearTimeout(connectTimeout);

      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
      }

      void this._consumeStream(res.body);

      if (!this._messageUrl) {
        this._messageUrl = await this._awaitMessageUrl();
      }
      if (!this._messageUrl) {
        this._messageUrl = deriveSseMessageUrl(this.url);
      }

      const result = await this._sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lynn", version: "1.0.0" },
      });
      this._sendNotification("notifications/initialized", {});
      this._ready = true;
      this._reconnectDelayMs = 1000;
      return result;
    } catch (err) {
      clearTimeout(connectTimeout);
      this._lastError = errorMessage(err);
      this.close();
      throw err;
    }
  }

  close(): void {
    this._closed = true;
    this._ready = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try { this._streamController?.abort(); } catch {}
    this._streamController = null;
    this._rejectPending(new Error("Connection closed"));
  }

  private _awaitMessageUrl(): Promise<string> {
    if (this._messageUrl) return Promise.resolve(this._messageUrl);
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this._waitingForEndpoint = this._waitingForEndpoint.filter(
          (entry) => entry.resolve !== (resolve as (value: string) => void),
        );
        resolve(deriveSseMessageUrl(this.url));
      }, 1500);
      this._waitingForEndpoint.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }

  private async _consumeStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let splitIndex = buffer.indexOf("\n\n");
        while (splitIndex >= 0) {
          const rawEvent = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          this._handleSseEvent(rawEvent);
          splitIndex = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (this._closed) return;
      this._lastError = errorMessage(err);
    } finally {
      if (!this._closed) {
        this._ready = false;
        this._scheduleReconnect();
      }
    }
  }

  private _handleSseEvent(rawEvent: string): void {
    const { eventName, data } = parseSseEvent(rawEvent);
    if (!data) return;

    if (eventName === "endpoint") {
      try {
        this._messageUrl = new URL(data, this.url).toString();
      } catch {
        this._messageUrl = data;
      }
      const pending = [...this._waitingForEndpoint];
      this._waitingForEndpoint = [];
      for (const waiter of pending) waiter.resolve(this._messageUrl);
      return;
    }

    try {
      this._handleJsonRpcMessage(JSON.parse(data) as JsonRpcResponsePayload);
    } catch {
      log.log(`[${this.name}] ignored non-JSON SSE event (${eventName})`);
    }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer || this._closed) return;
    const delay = this._reconnectDelayMs;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
        await this.listTools();
        await this.listResources();
      } catch (err) {
        this._lastError = errorMessage(err);
        this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, 10_000);
        this._scheduleReconnect();
      }
    }, delay);
  }

  protected _sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++_msgId;
    const postUrl = this._messageUrl || deriveSseMessageUrl(this.url);
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      fetch(postUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body,
      }).then((res) => {
        if (res.ok || res.status === 202 || res.status === 204) return;
        this._pending.delete(id);
        reject(new Error(`SSE request failed: ${res.status} ${res.statusText}`));
      }).catch((err) => {
        this._pending.delete(id);
        reject(err);
      });
    });
  }

  private _sendNotification(method: string, params: unknown): void {
    const postUrl = this._messageUrl || deriveSseMessageUrl(this.url);
    void fetch(postUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }).catch(() => {});
  }
}

class McpHttpConnection extends McpConnectionBase<McpHttpServerConfig> {
  private url: string;
  private headers: HeaderMap;

  constructor(name: string, config: McpHttpServerConfig) {
    super(name, config);
    this.url = this.config.url;
    this.headers = normalizeHeaders(this.config.headers);
  }

  async connect(): Promise<unknown> {
    this._closed = false;
    this._ready = false;
    this._lastError = null;

    try {
      const result = await this._sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lynn", version: "1.0.0" },
      });
      await this._sendNotification("notifications/initialized", {});
      this._ready = true;
      return result;
    } catch (err) {
      this._lastError = errorMessage(err);
      this.close();
      throw err;
    }
  }

  close(): void {
    this._closed = true;
    this._ready = false;
    this._rejectPending(new Error("Connection closed"));
  }

  protected async _sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++_msgId;
    const result = await this._postJsonRpc({ jsonrpc: "2.0", id, method, params });
    if (result?.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }
    return result?.result;
  }

  private async _sendNotification(method: string, params: unknown): Promise<void> {
    try {
      await this._postJsonRpc({ jsonrpc: "2.0", method, params }, { notification: true });
    } catch {}
  }

  private async _postJsonRpc(
    payload: JsonRpcOutboundPayload,
    opts: HttpPostOptions = {},
  ): Promise<JsonRpcResponsePayload | null> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`HTTP MCP failed: ${res.status} ${res.statusText}`);
    }

    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      const rawText = await res.text();
      const blocks = rawText.replace(/\r\n/g, "\n").split("\n\n").filter(Boolean);
      for (const block of blocks) {
        const parsed = parseSseEvent(block);
        if (!parsed.data) continue;
        try {
          const msg = JSON.parse(parsed.data) as JsonRpcResponsePayload;
          if (!payload.id || msg.id === payload.id || opts.notification) {
            return msg;
          }
        } catch {}
      }
      if (opts.notification) return null;
      throw new Error("HTTP MCP returned no JSON-RPC payload");
    }

    const json = await res.json() as JsonRpcResponsePayload;
    return json;
  }
}

export class McpManager {
  private _lynnHome: string;
  private _configPath: string;
  private _credentialsPath: string;
  private _connections: Map<string, McpConnectionBase>;
  private _localServers: McpServerConfigMap;
  private _discoveredServers: McpServerConfigMap;
  private _builtinServers: McpServerConfigMap;
  private _builtinCredentials: BuiltinCredentialStore;
  private _mergedServers: McpServerConfigMap;

  constructor(lynnHome: string) {
    this._lynnHome = lynnHome;
    this._configPath = path.join(lynnHome, "mcp-servers.yaml");
    this._credentialsPath = path.join(lynnHome, "user", "mcp-credentials.json");
    this._connections = new Map();
    this._localServers = {};
    this._discoveredServers = {};
    this._builtinServers = {};
    this._builtinCredentials = {};
    this._mergedServers = {};
  }

  async init(): Promise<void> {
    this._loadConfigs();
    const tasks = Object.entries(this._mergedServers)
      .filter(([, config]) => !config.disabled)
      .map(([name, config]) => this._connectServer(name, config));
    await Promise.allSettled(tasks);
    log.log(`MCP init done: ${this.serverCount} server(s), ${this.toolCount} tool(s)`);
  }

  async dispose(): Promise<void> {
    for (const [, conn] of this._connections) {
      conn.close();
    }
    this._connections.clear();
  }

  async reload(): Promise<void> {
    await this.dispose();
    this._loadConfigs();
    await this.init();
  }

  get serverCount(): number {
    return [...this._connections.values()].filter((conn) => conn.ready).length;
  }

  get toolCount(): number {
    return this.getTools().length;
  }

  getTools(): McpToolDefinition[] {
    const tools: McpToolDefinition[] = [];
    for (const [serverName, connection] of this._connections) {
      for (const mcpTool of connection.tools || []) {
        const fullName = `mcp__${serverName}__${mcpTool.name}`;
        tools.push(this._convertTool(fullName, connection, mcpTool));
      }
    }
    return tools;
  }

  getPromptContext(): string {
    const lines: string[] = [];
    for (const [name, connection] of this._connections) {
      const resources = connection.resources || [];
      if (resources.length === 0) continue;
      lines.push(`- ${name}: ${resources.slice(0, 5).map((item) => item.name || item.title || item.uri).filter(Boolean).join(", ")}`);
    }
    if (lines.length === 0) return "";
    return ["[MCP Resources]", ...lines].join("\n");
  }

  listServerStates(): McpServerState[] {
    return Object.entries(this._mergedServers).map(([name, config]) => {
      const configView = config as {
        command?: string;
        args?: string[];
        cwd?: string;
        url?: string;
        headers?: HeaderMap;
        messageUrl?: string;
      };
      const connection = this._connections.get(name) || null;
      const source = this._builtinServers[name]
        ? "builtin"
        : this._localServers[name]
          ? "local"
          : "discovered";
      const builtin = BUILTIN_SERVERS[name] || null;
      return {
        name,
        transport: config.transport || "stdio",
        disabled: config.disabled === true,
        command: configView.command || "",
        args: configView.args || [],
        cwd: configView.cwd || "",
        url: configView.url || "",
        headers: configView.headers || {},
        messageUrl: configView.messageUrl || "",
        source,
        sourcePath: source === "builtin"
          ? this._credentialsPath
          : source === "discovered"
            ? DISCOVERY_PATHS
              .map((rel) => resolveDiscoveryPath(this._lynnHome, rel))
              .find((candidate) => parseCompatConfig(candidate)?.[name]) || null
            : this._configPath,
        builtin: !!builtin,
        label: builtin?.label || name,
        docsUrl: builtin?.docsUrl || "",
        connected: !!connection?.ready,
        lastError: connection?.lastError || null,
        toolCount: connection?.tools?.length || 0,
        resourceCount: connection?.resources?.length || 0,
        tools: (connection?.tools || []).map((tool) => ({
          name: tool.name,
          description: tool.description || "",
        })),
        resources: (connection?.resources || []).map((resource) => ({
          name: resource.name || resource.title || resource.uri,
          uri: resource.uri || "",
        })),
      };
    });
  }

  listBuiltinStates(): McpBuiltinState[] {
    const states = this.listServerStates();
    return Object.values(BUILTIN_SERVERS).map((builtin) => {
      const serverState = states.find((item) => item.name === builtin.name) || null;
      const rawEntry = this._builtinCredentials?.[builtin.name];
      const credentials = (rawEntry?.credentials && typeof rawEntry.credentials === "object"
        ? rawEntry.credentials
        : rawEntry && typeof rawEntry === "object"
          ? rawEntry
          : {}) as CredentialValues;
      const configured = builtin.credentialFields.every((field) => String(credentials?.[field.key] || "").trim());
      const enabled = rawEntry?.enabled !== false;
      return {
        name: builtin.name,
        label: builtin.label,
        group: builtin.group || "other",
        description: builtin.description,
        docsUrl: builtin.docsUrl,
        hint: builtin.hint || "",
        transport: builtin.transport,
        configured,
        enabled,
        connected: !!serverState?.connected,
        lastError: serverState?.lastError || null,
        toolCount: serverState?.toolCount || 0,
        resourceCount: serverState?.resourceCount || 0,
        tools: serverState?.tools || [],
        resources: serverState?.resources || [],
        credentialFields: sanitizeBuiltinCredentialFields(builtin.credentialFields, credentials),
      };
    });
  }

  async saveBuiltinCredentials(
    name: string,
    payload: SaveBuiltinCredentialsPayload = {},
  ): Promise<McpBuiltinState | null> {
    const builtin = BUILTIN_SERVERS[name];
    if (!builtin) throw new Error(`unknown builtin MCP server: ${name}`);

    const credentials = payload?.credentials && typeof payload.credentials === "object" ? payload.credentials : {};
    const enabled = typeof payload?.enabled === "boolean" ? payload.enabled : undefined;
    const current = this._readBuiltinCredentials();
    const prev = current[name] && typeof current[name] === "object" ? current[name] : {};
    current[name] = {
      ...prev,
      ...(enabled !== undefined ? { enabled } : {}),
      credentials: {
        ...(prev.credentials && typeof prev.credentials === "object" ? prev.credentials : {}),
        ...Object.fromEntries(
          Object.entries(credentials)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [key, String(value)]),
        ),
      },
    };
    this._writeBuiltinCredentials(current);
    await this.reload();
    return this.listBuiltinStates().find((item) => item.name === name) || null;
  }

  async testBuiltinServer(
    name: string,
    payload: SaveBuiltinCredentialsPayload = {},
  ): Promise<McpTestServerResult> {
    const builtin = BUILTIN_SERVERS[name];
    if (!builtin) throw new Error(`unknown builtin MCP server: ${name}`);
    const current = this._readBuiltinCredentials();
    const prev = current[name] && typeof current[name] === "object" ? current[name] : {};
    const overrideCredentials = payload?.credentials && typeof payload.credentials === "object" ? payload.credentials : {};
    const credentials = {
      ...(prev.credentials && typeof prev.credentials === "object" ? prev.credentials : {}),
      ...Object.fromEntries(
        Object.entries(overrideCredentials)
          .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
          .map(([key, value]) => [key, String(value)]),
      ),
    };
    const configured = builtin.credentialFields.every((field) => String(credentials?.[field.key] || "").trim());
    if (!configured) {
      throw new Error(`builtin MCP server "${name}" is missing required credentials`);
    }
    const config = this._resolveBuiltinServerConfig(name, credentials, { enabled: true });
    if (!config) throw new Error(`unknown builtin MCP server: ${name}`);
    return this.testServerConfig(name, config);
  }

  async saveServer(name: string, config: RawMcpServerConfig): Promise<McpServerState | null> {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) throw new Error("MCP server name is required");
    const normalized = normalizeServerConfig(config);
    if ((normalized.transport === "sse" || normalized.transport === "http") && !normalized.url) {
      throw new Error(`${normalized.transport.toUpperCase()} MCP server requires url`);
    }
    if (normalized.transport === "stdio" && !normalized.command) {
      throw new Error("stdio MCP server requires command");
    }
    const localConfig = this._readLocalConfig();
    localConfig.servers[trimmedName] = serializeServerConfig(normalized);
    this._writeLocalConfig(localConfig);
    await this.reload();
    return this.listServerStates().find((item) => item.name === trimmedName) || null;
  }

  async deleteServer(name: string): Promise<void> {
    if (!this._localServers[name]) {
      throw new Error(`MCP server "${name}" is not editable`);
    }
    const localConfig = this._readLocalConfig();
    delete localConfig.servers[name];
    this._writeLocalConfig(localConfig);
    await this.reload();
  }

  async testServerConfig(name: string, config: RawMcpServerConfig): Promise<McpTestServerResult> {
    const normalized = normalizeServerConfig(config);
    const connection = this._createConnection(name || "test", normalized);
    try {
      await connection.connect();
      const [tools, resources] = await Promise.all([
        connection.listTools(),
        connection.listResources(),
      ]);
      return {
        ok: true,
        toolCount: tools.length,
        resourceCount: resources.length,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description || "" })),
        resources: resources.map((resource) => ({ name: resource.name || resource.title || resource.uri, uri: resource.uri || "" })),
      };
    } finally {
      connection.close();
    }
  }

  private async _connectServer(name: string, config: NormalizedMcpServerConfig): Promise<void> {
    try {
      const connection = this._createConnection(name, config);
      await connection.connect();
      await Promise.all([connection.listTools(), connection.listResources()]);
      this._connections.set(name, connection);
      log.log(`[${name}] connected, ${connection.tools.length} tool(s), ${connection.resources.length} resource(s)`);
    } catch (err) {
      log.log(`[${name}] connect failed: ${errorMessage(err)}`);
    }
  }

  private _createConnection(name: string, config: NormalizedMcpServerConfig): McpConnectionBase {
    if (config.transport === "sse") return new McpSseConnection(name, config);
    if (config.transport === "http") return new McpHttpConnection(name, config);
    return new McpStdioConnection(name, config);
  }

  private _convertTool(fullName: string, connection: McpConnectionBase, mcpTool: McpTool): McpToolDefinition {
    const params = mcpTool.inputSchema || Type.Object({});
    return {
      name: fullName,
      label: mcpTool.name,
      description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
      parameters: params,
      execute: async (_toolCallId: string, args: unknown) => {
        try {
          const result = await connection.callTool(mcpTool.name, args || {});
          const content = result?.content || [];
          if (content.length === 0) {
            return { content: [{ type: "text", text: "(no output)" }] };
          }
          return { content };
        } catch (err) {
          return { content: [{ type: "text", text: `MCP error: ${errorMessage(err)}` }] };
        }
      },
    };
  }

  private _readLocalConfig(): { servers: Record<string, RawMcpServerConfig> } {
    try {
      if (!fs.existsSync(this._configPath)) return { servers: {} };
      const parsed = (YAML.load(fs.readFileSync(this._configPath, "utf-8")) || {}) as { servers?: unknown };
      return {
        servers: parsed.servers && typeof parsed.servers === "object"
          ? parsed.servers as Record<string, RawMcpServerConfig>
          : {},
      };
    } catch (err) {
      log.log(`config load failed: ${errorMessage(err)}`);
      return { servers: {} };
    }
  }

  private _writeLocalConfig(config: { servers: Record<string, RawMcpServerConfig> }): void {
    fs.mkdirSync(path.dirname(this._configPath), { recursive: true });
    const yaml = YAML.dump({ servers: config.servers || {} }, {
      indent: 2,
      lineWidth: -1,
      sortKeys: false,
    });
    fs.writeFileSync(this._configPath, yaml, "utf-8");
  }

  private _readBuiltinCredentials(): BuiltinCredentialStore {
    try {
      if (!fs.existsSync(this._credentialsPath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this._credentialsPath, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed as BuiltinCredentialStore : {};
    } catch (err) {
      log.log(`builtin credential load failed: ${errorMessage(err)}`);
      return {};
    }
  }

  private _writeBuiltinCredentials(raw: BuiltinCredentialStore): void {
    fs.mkdirSync(path.dirname(this._credentialsPath), { recursive: true });
    fs.writeFileSync(this._credentialsPath, JSON.stringify(raw || {}, null, 2), "utf-8");
    try { fs.chmodSync(this._credentialsPath, 0o600); } catch {}
  }

  private _resolveBuiltinServerConfig(
    name: string,
    credentials: CredentialValues = {},
    opts: { enabled?: boolean } = {},
  ): NormalizedMcpServerConfig | null {
    const builtin = BUILTIN_SERVERS[name];
    if (!builtin) return null;
    const configured = builtin.credentialFields.every((field) => String(credentials?.[field.key] || "").trim());
    const enabled = opts.enabled !== false;
    const resolved = replaceCredentialPlaceholders(cloneDeep(builtin.config), credentials) as RawMcpServerConfig;
    return normalizeServerConfig({
      ...resolved,
      disabled: !(enabled && configured),
    });
  }

  private _buildBuiltinServers(): McpServerConfigMap {
    const builtins: McpServerConfigMap = {};
    const entries = this._readBuiltinCredentials();
    for (const builtin of Object.values(BUILTIN_SERVERS)) {
      const rawEntry = entries[builtin.name];
      const credentials = (rawEntry?.credentials && typeof rawEntry.credentials === "object"
        ? rawEntry.credentials
        : rawEntry && typeof rawEntry === "object"
          ? rawEntry
          : {}) as CredentialValues;
      const enabled = rawEntry?.enabled !== false;
      const resolved = this._resolveBuiltinServerConfig(builtin.name, credentials, { enabled });
      if (resolved) builtins[builtin.name] = resolved;
    }
    this._builtinCredentials = entries;
    return builtins;
  }

  private _discoverServers(): McpServerConfigMap {
    const discovered: McpServerConfigMap = {};
    for (const relativePath of DISCOVERY_PATHS) {
      const fullPath = resolveDiscoveryPath(this._lynnHome, relativePath);
      Object.assign(discovered, parseCompatConfig(fullPath));
    }
    return discovered;
  }

  private _loadConfigs(): void {
    const localConfig = this._readLocalConfig();
    this._localServers = Object.fromEntries(
      Object.entries(localConfig.servers || {}).map(([name, config]) => [name, normalizeServerConfig(config)]),
    );
    this._builtinServers = this._buildBuiltinServers();
    this._discoveredServers = this._discoverServers();
    this._mergedServers = {
      ...this._discoveredServers,
      ...this._builtinServers,
      ...this._localServers,
    };
  }
}

export function createDefaultMcpServerTemplate(kind: McpServerTemplateKind = "stdio"): RawMcpServerConfig {
  if (kind === "http") {
    return {
      transport: "http",
      url: "",
      headers: {},
    };
  }
  if (kind === "sse") {
    return {
      transport: "sse",
      url: "",
      headers: {},
      messageUrl: "",
    };
  }
  return {
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    cwd: os.homedir(),
  };
}
