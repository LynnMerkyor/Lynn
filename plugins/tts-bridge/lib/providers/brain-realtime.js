/**
 * Lynn Brain StepFun Realtime TTS provider.
 *
 * This plugin path is used by the GUI message speaker. It intentionally calls
 * Lynn Brain with the existing signed device identity, so users do not need to
 * paste a StepFun key into local settings.
 *
 * Protocol/UX reference: StepFun official Step-Realtime-CLI (MIT). See NOTICE.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BRAIN_ROOTS = [
  "https://api.merkyorlynn.com/api/v2",
  "http://82.156.182.240/api/v2",
];

const SIGNATURE_VERSION = "v1";

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveLynnHome() {
  const raw = process.env.LYNN_HOME || process.env.HANA_HOME || "";
  return raw ? path.resolve(raw.replace(/^~/, os.homedir())) : path.join(os.homedir(), ".lynn");
}

function readPreferences() {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveLynnHome(), "user", "preferences.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

function clientVersion() {
  try {
    const pkgPath = new URL("../../../../package.json", import.meta.url);
    return String(JSON.parse(fs.readFileSync(pkgPath, "utf8"))?.version || "unknown");
  } catch {
    return "unknown";
  }
}

function clientPlatform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return process.platform || "unknown";
}

function signedHeaders(pathname) {
  const prefs = readPreferences();
  const agentKey = stringValue(prefs.client_agent_key);
  const secret = stringValue(prefs.client_agent_secret);
  if (!agentKey) return {};
  const headers = {
    "X-Agent-Key": agentKey,
    "X-Lynn-Client-Version": clientVersion(),
    "X-Lynn-Client-Platform": clientPlatform(),
  };
  if (secret && process.env.LYNN_DISABLE_DEVICE_SIGNATURE !== "1") {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(12).toString("hex");
    const payload = [SIGNATURE_VERSION, "POST", pathname, timestamp, nonce, agentKey].join("\n");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    headers["X-Lynn-Timestamp"] = timestamp;
    headers["X-Lynn-Nonce"] = nonce;
    headers["X-Lynn-Signature"] = `${SIGNATURE_VERSION}:${signature}`;
  }
  return headers;
}

function brainRoots(config = {}) {
  const configured = stringValue(config.base_url) || stringValue(config.baseUrl) || stringValue(process.env.BRAIN_API_ROOT_URL);
  const roots = configured ? [configured] : DEFAULT_BRAIN_ROOTS;
  return [...new Set(roots.map((root) => String(root || "").replace(/\/+$/, "")).filter(Boolean))];
}

async function postBrainTts(config, { text, voice, speed }) {
  const pathname = "/v1/voice/tts";
  const body = {
    text,
    voice: voice || config.default_voice || config.voice || "jingdiannvsheng",
    speed: speed || 1,
  };
  let lastError = null;
  for (const root of brainRoots(config)) {
    try {
      const res = await fetch(`${root}${pathname}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...signedHeaders(pathname),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(config.timeout_ms || config.timeoutMs || 45_000)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      const audioBase64 = stringValue(data.audio_base64) || stringValue(data.audio) || stringValue(data.data?.audio_base64);
      if (!audioBase64) throw new Error("Brain realtime TTS returned no audio");
      return {
        audio: Buffer.from(audioBase64, "base64"),
        mimeType: stringValue(data.mime_type) || stringValue(data.mimeType) || "audio/wav",
        provider: stringValue(data.provider) || "brain-stepfun-realtime",
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Brain realtime TTS failed");
}

export function createBrainRealtimeTTSProvider(config = {}) {
  return {
    name: "brain-realtime",
    label: "Lynn Brain StepFun Realtime TTS",
    supportsStreaming: true,

    async synthesize({ text, voice, speed, outPath }) {
      if (!text || !String(text).trim()) throw new Error("brain-realtime: empty text");
      const result = await postBrainTts(config, { text, voice, speed });
      if (outPath) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, result.audio);
      }
      return {
        ok: true,
        provider: result.provider,
        path: outPath,
        mimeType: result.mimeType,
      };
    },

    async synthesizeStream({ text, voice, speed } = {}) {
      if (!text || !String(text).trim()) throw new Error("brain-realtime: empty text");
      const result = await postBrainTts(config, { text, voice, speed });
      return {
        ok: true,
        provider: result.provider,
        stream: new Response(result.audio).body,
        mimeType: result.mimeType,
      };
    },
  };
}
