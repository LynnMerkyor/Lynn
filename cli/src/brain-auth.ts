import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBrainRegistrationToken } from "../../shared/brain-provider.js";
import { readVersionInfo } from "./version.js";
import { brainEndpointUrl } from "./brain-url.js";

const CLIENT_AGENT_KEY_PREF_KEY = "client_agent_key";
const CLIENT_AGENT_SECRET_PREF_KEY = "client_agent_secret";
const SIGNATURE_VERSION = "v1";

export interface CliBrainIdentity {
  key: string;
  secret: string;
}

export interface SignedBrainHeadersOptions {
  lynnHome?: string;
  method?: string;
  pathname?: string;
}

function resolveLynnHome(lynnHome?: string): string {
  const raw = lynnHome || process.env.LYNN_HOME || process.env.HANA_HOME || "";
  if (raw) return path.resolve(raw.replace(/^~/, os.homedir()));
  return path.join(os.homedir(), ".lynn");
}

function preferencesPath(lynnHome: string): string {
  return path.join(lynnHome, "user", "preferences.json");
}

function devicesDir(lynnHome: string): string {
  return path.join(lynnHome, "brain-devices");
}

function readJsonFile(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function ensureCliBrainIdentity(options: { lynnHome?: string } = {}): CliBrainIdentity {
  const home = resolveLynnHome(options.lynnHome);
  const prefsFile = preferencesPath(home);
  const prefs = readJsonFile(prefsFile);
  let key = normalizeString(prefs[CLIENT_AGENT_KEY_PREF_KEY]);
  let secret = normalizeString(prefs[CLIENT_AGENT_SECRET_PREF_KEY]);

  if (!key) key = `ak_${crypto.randomUUID().replace(/-/g, "")}`;
  if (!secret) secret = crypto.randomBytes(32).toString("hex");

  if (prefs[CLIENT_AGENT_KEY_PREF_KEY] !== key || prefs[CLIENT_AGENT_SECRET_PREF_KEY] !== secret) {
    writeJsonFile(prefsFile, {
      ...prefs,
      [CLIENT_AGENT_KEY_PREF_KEY]: key,
      [CLIENT_AGENT_SECRET_PREF_KEY]: secret,
    });
  }

  registerLocalBrainDevice({ lynnHome: home, key, secret });
  return { key, secret };
}

export function registerLocalBrainDevice({ lynnHome, key, secret }: { lynnHome?: string; key: string; secret: string }): string {
  const home = resolveLynnHome(lynnHome);
  const file = path.join(devicesDir(home), `${key}.json`);
  const existing = readJsonFile(file);
  const version = readVersionInfo().version;
  writeJsonFile(file, {
    ...existing,
    key,
    secret,
    clientVersion: version,
    clientPlatform: process.platform,
    updatedAt: new Date().toISOString(),
  });
  return file;
}

export function buildBrainSignaturePayload({
  method = "POST",
  pathname = "/v1/chat/completions",
  timestamp,
  nonce,
  agentKey,
}: {
  method?: string;
  pathname?: string;
  timestamp: number | string;
  nonce: string;
  agentKey: string;
}): string {
  return [
    SIGNATURE_VERSION,
    String(method || "POST").toUpperCase(),
    String(pathname || "/v1/chat/completions").trim() || "/v1/chat/completions",
    String(timestamp),
    String(nonce),
    String(agentKey),
  ].join("\n");
}

export function signedBrainHeaders(options: SignedBrainHeadersOptions = {}): Record<string, string> {
  if (process.env.LYNN_CLI_DISABLE_BRAIN_AUTH === "1") return {};
  const identity = ensureCliBrainIdentity({ lynnHome: options.lynnHome });
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = buildBrainSignaturePayload({
    method: options.method || "POST",
    pathname: options.pathname || "/v1/chat/completions",
    timestamp,
    nonce,
    agentKey: identity.key,
  });
  const signature = crypto.createHmac("sha256", identity.secret).update(payload).digest("hex");
  const version = readVersionInfo().version;
  return {
    "x-agent-key": identity.key,
    "x-lynn-timestamp": String(timestamp),
    "x-lynn-nonce": nonce,
    "x-lynn-signature": `${SIGNATURE_VERSION}:${signature}`,
    "x-lynn-client-version": version,
    "x-lynn-client-platform": process.platform,
  };
}

export async function registerRemoteBrainDevice(brainUrl: string, options: { lynnHome?: string } = {}): Promise<boolean> {
  if (process.env.LYNN_CLI_DISABLE_BRAIN_AUTH === "1") return false;
  const identity = ensureCliBrainIdentity({ lynnHome: options.lynnHome });
  const version = readVersionInfo().version;
  const response = await fetch(brainEndpointUrl(brainUrl, "/v1/devices/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: identity.key,
      secret: identity.secret,
      clientVersion: version,
      clientPlatform: process.platform,
      registrationToken: getBrainRegistrationToken(),
    }),
  });
  if (response.ok) return true;
  if (response.status === 404 || response.status === 405) return false;
  const detail = await response.text().catch(() => "");
  throw new Error(`Brain device registration failed: ${response.status} ${response.statusText}${detail ? ` · ${detail.slice(0, 160)}` : ""}`.trim());
}
