import crypto from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const CLIENT_AGENT_KEY_PREF_KEY = "client_agent_key";
export const CLIENT_AGENT_SECRET_PREF_KEY = "client_agent_secret";
export const CLIENT_AGENT_KEY_HEADER = "X-Agent-Key";
export const CLIENT_AGENT_TIMESTAMP_HEADER = "X-Lynn-Timestamp";
export const CLIENT_AGENT_NONCE_HEADER = "X-Lynn-Nonce";
export const CLIENT_AGENT_SIGNATURE_HEADER = "X-Lynn-Signature";
export const CLIENT_AGENT_VERSION_HEADER = "X-Lynn-Client-Version";
export const CLIENT_AGENT_PLATFORM_HEADER = "X-Lynn-Client-Platform";
export const CLIENT_AGENT_SIGNATURE_VERSION = "v1";

export type ClientAgentHeaders = Record<string, string>;
export type ClientAgentMetadata = { user_id: string };
export type LynnClientPlatform = "macos" | "windows" | "linux" | string;

export interface ReadClientIdentityOptions {
  lynnHome?: string;
}

export interface ClientSignaturePayloadOptions {
  method?: string;
  pathname?: string;
  timestamp?: unknown;
  nonce?: unknown;
  agentKey?: unknown;
}

export interface SignClientAgentRequestOptions extends ClientSignaturePayloadOptions {
  secret?: unknown;
  clientVersion?: string | number;
  clientPlatform?: string;
}

export interface ReadSignedClientAgentHeadersOptions extends ReadClientIdentityOptions {
  method?: string;
  pathname?: string;
  clientVersion?: string;
  clientPlatform?: string;
}

export interface RegisterClientIdentityOptions {
  baseUrl: string;
  agentKey: unknown;
  secret: unknown;
  registrationToken?: string;
  clientVersion?: string;
  clientPlatform?: string;
  timeoutMs?: number;
}

export type BrainDeviceRegisterResponse = Record<string, unknown>;

type PreferencesFile = Record<string, unknown>;

export function sanitizeClientAgentKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function sanitizeClientAgentSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function generateClientAgentKey(): string {
  return `ak_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function generateClientAgentSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function resolveLynnClientPlatform(): LynnClientPlatform {
  const platform = process.platform;
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return platform || "unknown";
}

export function buildClientAgentHeaders(agentKey: unknown): ClientAgentHeaders {
  const normalized = sanitizeClientAgentKey(agentKey);
  return normalized ? { [CLIENT_AGENT_KEY_HEADER]: normalized } : {};
}

export function buildClientAgentMetadata(agentKey: unknown): ClientAgentMetadata | undefined {
  const normalized = sanitizeClientAgentKey(agentKey);
  return normalized ? { user_id: normalized } : undefined;
}

export function resolveLynnHome(): string {
  const raw = process.env.LYNN_HOME || process.env.HANA_HOME || "";
  if (raw) {
    return path.resolve(raw.replace(/^~/, os.homedir()));
  }
  return path.join(os.homedir(), ".lynn");
}

function readPreferencesFile(opts: ReadClientIdentityOptions = {}): PreferencesFile {
  const lynnHome = opts.lynnHome || resolveLynnHome();
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  try {
    return (JSON.parse(fs.readFileSync(prefsPath, "utf-8")) || {}) as PreferencesFile;
  } catch {
    return {};
  }
}

export function readClientAgentKeyFromPreferencesFile(opts: ReadClientIdentityOptions = {}): string | null {
  const prefs = readPreferencesFile(opts);
  return sanitizeClientAgentKey(prefs?.[CLIENT_AGENT_KEY_PREF_KEY]);
}

export function readClientAgentSecretFromPreferencesFile(opts: ReadClientIdentityOptions = {}): string | null {
  const prefs = readPreferencesFile(opts);
  return sanitizeClientAgentSecret(prefs?.[CLIENT_AGENT_SECRET_PREF_KEY]);
}

export function buildClientSignaturePayload({
  method = "POST",
  pathname = "/v1/chat/completions",
  timestamp,
  nonce,
  agentKey,
}: ClientSignaturePayloadOptions): string {
  const normalizedMethod = String(method || "POST").toUpperCase();
  const normalizedPath = normalizeClientSignaturePath(pathname);
  return [
    CLIENT_AGENT_SIGNATURE_VERSION,
    normalizedMethod,
    normalizedPath,
    String(timestamp || ""),
    String(nonce || ""),
    String(agentKey || ""),
  ].join("\n");
}

export function normalizeClientSignaturePath(pathname: unknown): string {
  const raw = String(pathname || "/v1/chat/completions").trim() || "/v1/chat/completions";
  // The GUI stack historically signs OpenAI-compatible calls as
  // "/chat/completions" because provider base URLs usually end in "/v1".
  // Public Brain v2 is mounted behind /api/v2 and receives the request as
  // "/v1/chat/completions", which is also what the CLI signs. Normalize this
  // one common shape so GUI and CLI share the exact same strict-auth contract.
  if (raw === "/chat/completions") return "/v1/chat/completions";
  return raw;
}

export function signClientAgentRequest({
  agentKey,
  secret,
  method,
  pathname,
  timestamp = Date.now().toString(),
  nonce = crypto.randomBytes(12).toString("hex"),
  clientVersion = "unknown",
  clientPlatform = resolveLynnClientPlatform(),
}: SignClientAgentRequestOptions): ClientAgentHeaders {
  const normalizedKey = sanitizeClientAgentKey(agentKey);
  const normalizedSecret = sanitizeClientAgentSecret(secret);
  if (!normalizedKey) return {};

  // 基础头：始终包含
  const headers: ClientAgentHeaders = {
    [CLIENT_AGENT_KEY_HEADER]: normalizedKey,
    [CLIENT_AGENT_VERSION_HEADER]: String(clientVersion || "unknown"),
    [CLIENT_AGENT_PLATFORM_HEADER]: String(clientPlatform || resolveLynnClientPlatform()),
  };

  // 签名头：默认开启。CLI 与 GUI 共用 client_agent_key/secret，
  // Brain v2 strict 模式依赖这组 HMAC 头阻止匿名调用。
  if (normalizedSecret && process.env.LYNN_DISABLE_DEVICE_SIGNATURE !== "1") {
    const payload = buildClientSignaturePayload({
      method,
      pathname,
      timestamp,
      nonce,
      agentKey: normalizedKey,
    });
    const signature = crypto
      .createHmac("sha256", normalizedSecret)
      .update(payload)
      .digest("hex");

    headers[CLIENT_AGENT_TIMESTAMP_HEADER] = String(timestamp);
    headers[CLIENT_AGENT_NONCE_HEADER] = String(nonce);
    headers[CLIENT_AGENT_SIGNATURE_HEADER] = `${CLIENT_AGENT_SIGNATURE_VERSION}:${signature}`;
  }

  return headers;
}

export function buildSignedClientAgentHeaders({
  method,
  pathname,
  agentKey,
  secret,
  clientVersion,
  clientPlatform,
}: SignClientAgentRequestOptions): ClientAgentHeaders {
  return signClientAgentRequest({
    agentKey,
    secret,
    method,
    pathname,
    clientVersion,
    clientPlatform,
  });
}

// [2026-04-18 v0.76.2] Auto-fill clientVersion from package.json so brain
// receives a real X-Lynn-Client-Version (was always "unknown" before, which
// broke brain's >= 0.76.2 version gate for tool_progress markers).
//
// Note: Vite inlines package.json as a base64 data URL when bundled, and
// fs.readFileSync() can't read data URLs. So we import the JSON statically
// (Vite turns this into a plain object literal at build time, so version
// is baked into the bundle directly).
import pkg from "../package.json" with { type: "json" };
const LYNN_VERSION = String(pkg?.version || "");
function _getLynnPackageVersion(): string {
  return LYNN_VERSION;
}

export function readSignedClientAgentHeaders(opts: ReadSignedClientAgentHeadersOptions = {}): ClientAgentHeaders {
  const prefs = readPreferencesFile(opts);
  const agentKey = sanitizeClientAgentKey(prefs?.[CLIENT_AGENT_KEY_PREF_KEY]);
  const secret = sanitizeClientAgentSecret(prefs?.[CLIENT_AGENT_SECRET_PREF_KEY]);
  return buildSignedClientAgentHeaders({
    method: opts.method,
    pathname: opts.pathname,
    agentKey,
    secret,
    clientVersion: opts.clientVersion || _getLynnPackageVersion(),
    clientPlatform: opts.clientPlatform,
  });
}

export async function registerClientIdentityWithBrainApi({
  baseUrl,
  agentKey,
  secret,
  registrationToken = "",
  clientVersion = "unknown",
  clientPlatform = resolveLynnClientPlatform(),
  timeoutMs = 10_000,
}: RegisterClientIdentityOptions): Promise<BrainDeviceRegisterResponse> {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedKey = sanitizeClientAgentKey(agentKey);
  const normalizedSecret = sanitizeClientAgentSecret(secret);
  if (!normalizedBaseUrl || !normalizedKey || !normalizedSecret) {
    throw new Error("missing client identity registration params");
  }

  const res = await fetch(`${normalizedBaseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: normalizedKey,
      secret: normalizedSecret,
      clientVersion,
      clientPlatform,
      ...(registrationToken ? { registrationToken } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as BrainDeviceRegisterResponse;
  if (!res.ok || data?.ok === false) {
    throw new Error(String(data?.error || `device register failed (${res.status})`));
  }
  return data;
}
