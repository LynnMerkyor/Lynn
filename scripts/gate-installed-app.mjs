#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import YAML from "js-yaml";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APP = "/Applications/Lynn.app";
const appArgIndex = process.argv.indexOf("--app");
const APP_PATH = path.resolve(appArgIndex >= 0 ? process.argv[appArgIndex + 1] : DEFAULT_APP);
let serverInfoPath = path.join(os.homedir(), ".lynn", "server-info.json");
const REVIEW_TIMEOUT_MS = Number(process.env.LYNN_INSTALLED_GATE_REVIEW_TIMEOUT_MS || "240000");
const ONLY_LIVE_VISION = process.argv.includes("--only-live-vision");
const REQUIRE_LIVE_VISION = process.env.LYNN_INSTALLED_GATE_REQUIRE_VISION === "1" || ONLY_LIVE_VISION;
const VISION_MODEL_ID = String(process.env.LYNN_INSTALLED_GATE_VISION_MODEL || "mimo-v2.5").trim();
const VISION_PROVIDER = String(process.env.LYNN_INSTALLED_GATE_VISION_PROVIDER || "").trim().toLowerCase();
const VISION_FIXTURE_PROVIDER = VISION_PROVIDER || "mimo";
const VISION_API_KEY = String(
  process.env.LYNN_INSTALLED_GATE_VISION_KEY
  || process.env.MIMO_TOKEN_PLAN_KEY
  || process.env.MIMO_API_KEY
  || process.env.MIMO_SEARCH_KEY
  || "",
).trim();
const VISION_BASE_URL = String(
  process.env.LYNN_INSTALLED_GATE_VISION_BASE_URL
  || process.env.MIMO_TOKEN_PLAN_BASE_URL
  || process.env.MIMO_SEARCH_BASE
  || "https://token-plan-cn.xiaomimimo.com/v1",
).trim();
const MIMO_PROVIDER_HINTS = new Set(["mimo", "xiaomi", "xiaomi-mimo", "token-plan"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code=${code} signal=${signal || ""}`));
    });
  });
}

function capture(command, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function listInstalledAppPids() {
  const pattern = path.join(APP_PATH, "Contents");
  const result = await capture("pgrep", ["-f", pattern], { timeoutMs: 3000 });
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function waitForInstalledAppExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pids = [];
  while (Date.now() < deadline) {
    pids = await listInstalledAppPids();
    if (pids.length === 0) return [];
    await wait(250);
  }
  return pids;
}

async function signalInstalledAppPids(signal) {
  const pids = await listInstalledAppPids();
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
  return pids;
}

async function quitExistingLynn() {
  await new Promise((resolve) => {
    const child = spawn("osascript", ["-e", 'tell application "Lynn" to quit'], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("exit", resolve);
    child.on("error", resolve);
  });
  let pids = await waitForInstalledAppExit(4000);
  if (pids.length === 0) return;

  console.warn(`[installed-gate] Lynn still running after quit request; terminating pids=${pids.join(",")}`);
  await signalInstalledAppPids("SIGTERM");
  pids = await waitForInstalledAppExit(5000);
  if (pids.length === 0) return;

  console.warn(`[installed-gate] Lynn still running after SIGTERM; killing pids=${pids.join(",")}`);
  await signalInstalledAppPids("SIGKILL");
  pids = await waitForInstalledAppExit(3000);
  if (pids.length) {
    throw new Error(`[installed-gate] failed to stop installed Lynn pids=${pids.join(",")}`);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readServerInfo(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(serverInfoPath, "utf8");
      const info = JSON.parse(raw);
      if (Number.isFinite(Number(info.port)) && info.token) return info;
      last = raw;
    } catch (error) {
      last = error?.message || String(error);
    }
    await wait(500);
  }
  throw new Error(`[installed-gate] timed out waiting for ${serverInfoPath}; last=${String(last || "")}`);
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function writeYaml(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, YAML.dump(data, { lineWidth: -1, noRefs: true }), "utf8");
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve();
    }, 8000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill("SIGTERM"); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function tail(text, lines = 60) {
  return String(text || "").split(/\n/).filter(Boolean).slice(-lines).join("\n");
}

function buildMimoFixtureModels() {
  const models = new Map();
  const add = (id, meta = {}) => {
    const normalized = String(id || "").trim();
    if (!normalized) return;
    models.set(normalized, {
      id: normalized,
      name: normalized === "mimo-v2.5-pro" ? "MiMo V2.5 Pro" : normalized === "mimo-v2.5" ? "MiMo V2.5" : normalized,
      context: 262144,
      maxOutput: normalized === "mimo-v2.5-pro" ? 64000 : 32000,
      reasoning: true,
      ...meta,
    });
  };
  add("mimo-v2.5-pro", { vision: false });
  add("mimo-v2.5", { vision: true });
  add(VISION_MODEL_ID, { vision: VISION_MODEL_ID === "mimo-v2.5" || VISION_MODEL_ID === "mimo-v2-omni" });
  return [...models.values()];
}

async function prepareGateHome() {
  if (!VISION_API_KEY) return null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-installed-gate-"));
  const lynnHome = path.join(tmp, ".lynn");
  await writeJson(path.join(lynnHome, "user", "preferences.json"), {
    setupComplete: true,
    locale: "zh-CN",
  });
  await writeYaml(path.join(lynnHome, "added-models.yaml"), {
    _migrated: true,
    providers: {
      [VISION_FIXTURE_PROVIDER]: {
        api_key: VISION_API_KEY,
        base_url: VISION_BASE_URL,
        api: "openai-completions",
        models: buildMimoFixtureModels(),
      },
    },
  });
  return { tmp, lynnHome };
}

async function launchAppDirect(appBin, env) {
  const logs = { value: "" };
  const child = spawn(appBin, [], {
    cwd: path.dirname(appBin),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs.value += String(chunk); });
  child.stderr.on("data", (chunk) => { logs.value += String(chunk); });
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.warn(`[installed-gate] app exited code=${code} signal=${signal || ""}\n${tail(logs.value)}`);
    }
  });
  return { child, logs };
}

async function httpJson(baseUrl, token, pathname, { method = "GET", body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new Error(`[installed-gate] ${method} ${pathname} -> ${res.status}: ${text}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpJson(baseUrl, token, pathname, {
  method = "GET",
  body,
  timeoutMs = 45000,
  requestTimeoutMs = 8000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await httpJson(baseUrl, token, pathname, {
        method,
        body,
        timeoutMs: requestTimeoutMs,
      });
    } catch (error) {
      lastError = error;
      await wait(500);
    }
  }
  throw new Error(`[installed-gate] timed out waiting for ${method} ${pathname}: ${lastError?.message || lastError || "unknown error"}`);
}

function openWs(wsUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, [`token.${token}`]);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      reject(new Error("[installed-gate] WebSocket open timeout"));
    }, 12000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makeSolidColorPngBase64({ width = 64, height = 64, rgba = [231, 41, 41, 255] } = {}) {
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const offset = rowStart + 1 + x * 4;
      raw[offset] = rgba[0];
      raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2];
      raw[offset + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND"),
  ]).toString("base64");
}

function modelMatchesLiveVision(model) {
  const provider = String(model?.provider || "").trim().toLowerCase();
  const id = String(model?.id || "").trim().toLowerCase();
  if (!id || !provider) return false;
  if (VISION_PROVIDER && provider !== VISION_PROVIDER) return false;
  if (VISION_MODEL_ID && id !== VISION_MODEL_ID.toLowerCase()) return false;
  return MIMO_PROVIDER_HINTS.has(provider) || /mimo/iu.test(provider) || /mimo/iu.test(id);
}

function pickLiveVisionModel(modelsPayload) {
  const models = Array.isArray(modelsPayload?.models) ? modelsPayload.models : [];
  const exact = models.find((model) => modelMatchesLiveVision(model) && model.vision === true);
  if (exact) return exact;
  return models.find((model) => modelMatchesLiveVision(model)) || null;
}

function summarizeVisionCandidates(modelsPayload) {
  const models = Array.isArray(modelsPayload?.models) ? modelsPayload.models : [];
  const candidates = models
    .filter((model) => {
      const provider = String(model?.provider || "").toLowerCase();
      const id = String(model?.id || "").toLowerCase();
      return provider.includes("mimo") || id.includes("mimo") || MIMO_PROVIDER_HINTS.has(provider);
    })
    .slice(0, 12)
    .map((model) => ({
      provider: model?.provider,
      id: model?.id,
      name: model?.name,
      vision: model?.vision,
      reasoning: model?.reasoning,
      isCurrent: model?.isCurrent,
    }));
  return {
    total: models.length,
    visionTotal: models.filter((model) => model?.vision === true).length,
    candidates,
  };
}

async function waitForPromptTurn(ws, payload, timeoutMs = 120000) {
  return await new Promise((resolve, reject) => {
    let text = "";
    const errors = [];
    const started = Date.now();
    let sawTurnEnd = false;
    let endTimer = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`[installed-gate] live vision prompt timed out after ${timeoutMs}ms; text=${text.slice(0, 200)} errors=${errors.join("; ")}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (endTimer) clearTimeout(endTimer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const finishSoon = () => {
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(() => {
        cleanup();
        resolve({ text, errors, elapsedMs: Date.now() - started });
      }, 500);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("[installed-gate] WebSocket closed during live vision prompt"));
    };
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "text_delta") {
        text += msg.delta || "";
      } else if (msg.type === "error") {
        errors.push(msg.message || JSON.stringify(msg));
      } else if (msg.type === "turn_end") {
        sawTurnEnd = true;
        finishSoon();
      } else if (sawTurnEnd && msg.type === "status" && msg.isStreaming === false) {
        finishSoon();
      }
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
    ws.send(JSON.stringify(payload));
  });
}

async function runLiveVisionGate(baseUrl, wsUrl, token) {
  const modelsPayload = await httpJson(baseUrl, token, "/api/models", { timeoutMs: 20000 });
  const selected = pickLiveVisionModel(modelsPayload);
  if (!selected) {
    const summary = summarizeVisionCandidates(modelsPayload);
    const message = `[installed-gate] live vision skipped: no configured MiMo vision model matched ${VISION_PROVIDER || "*"} / ${VISION_MODEL_ID || "*"}; models=${JSON.stringify(summary)}`;
    if (REQUIRE_LIVE_VISION) throw new Error(message);
    console.warn(message);
    return;
  }
  if (selected.vision !== true) {
    const message = `[installed-gate] live vision candidate is not marked vision-capable: ${selected.provider}/${selected.id}`;
    if (REQUIRE_LIVE_VISION) throw new Error(message);
    console.warn(`${message}; skipping.`);
    return;
  }

  const previous = Array.isArray(modelsPayload?.models)
    ? modelsPayload.models.find((model) => model?.isCurrent)
    : null;
  const sameModel = previous?.id === selected.id && previous?.provider === selected.provider;
  console.log(`[installed-gate] live vision model=${selected.provider}/${selected.id}`);

  try {
    if (!sameModel) {
      await httpJson(baseUrl, token, "/api/models/set", {
        method: "POST",
        body: { modelId: selected.id, provider: selected.provider },
        timeoutMs: 20000,
      });
      await wait(1000);
    }
    const session = await httpJson(baseUrl, token, "/api/sessions/new", {
      method: "POST",
      body: { cwd: ROOT, memoryEnabled: false },
      timeoutMs: 15000,
    }).catch(() => null);
    const sessionPath = session?.path || null;
    const ws = await openWs(wsUrl, token);
    try {
      const result = await waitForPromptTurn(ws, {
        type: "prompt",
        text: "请看这张图片，直接回答图片主体颜色。只回答颜色名，不要解释。",
        ...(sessionPath ? { sessionPath } : {}),
        clientMessageId: `installed-live-vision-${Date.now()}`,
        images: [{
          mimeType: "image/png",
          data: makeSolidColorPngBase64(),
        }],
      }, Number(process.env.LYNN_INSTALLED_GATE_VISION_TIMEOUT_MS || "120000"));

      if (result.errors.length) {
        throw new Error(`[installed-gate] live vision returned errors: ${result.errors.join("; ")}`);
      }
      const normalized = result.text.replace(/\s+/g, "");
      if (!/(红|red)/iu.test(normalized)) {
        throw new Error(`[installed-gate] live vision answer did not identify red image: ${JSON.stringify(result.text.slice(0, 500))}`);
      }
      console.log(`[installed-gate] live vision ok in ${result.elapsedMs}ms: ${result.text.replace(/\s+/g, " ").trim().slice(0, 120)}`);
    } finally {
      try {
        ws.close();
      } catch {}
    }
  } finally {
    if (!sameModel && previous?.id && previous?.provider) {
      await httpJson(baseUrl, token, "/api/models/set", {
        method: "POST",
        body: { modelId: previous.id, provider: previous.provider },
        timeoutMs: 20000,
      }).catch((error) => {
        console.warn(`[installed-gate] failed to restore previous model ${previous.provider}/${previous.id}: ${error.message}`);
      });
    }
  }
}

async function waitForReviewResults(ws, expectedIds, timeoutMs) {
  const pending = new Set(expectedIds);
  const results = new Map();
  const failures = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`[installed-gate] timed out waiting for review_result; pending=${[...pending].join(",")}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("[installed-gate] WebSocket closed before all review results"));
    };
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "review_result" || !pending.has(msg.reviewId)) return;
      const text = `${msg.content || ""} ${msg.structured?.summary || ""}`.trim();
      if (!text) {
        failures.push(`${msg.reviewId}: empty review_result`);
      }
      if (msg.errorCode && !/recovered/i.test(String(msg.errorCode))) {
        failures.push(`${msg.reviewId}: errorCode=${msg.errorCode}`);
      }
      results.set(msg.reviewId, msg);
      pending.delete(msg.reviewId);
      if (pending.size === 0) {
        cleanup();
        if (failures.length) reject(new Error(`[installed-gate] bad review results: ${failures.join("; ")}`));
        else resolve(results);
      }
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

async function runConcurrentReviewGate(baseUrl, wsUrl, token) {
  const ws = await openWs(wsUrl, token);
  try {
    const ids = ["installed-review-1", "installed-review-2", "installed-review-3"].map((prefix) => `${prefix}-${Date.now()}`);
    const payloads = ids.map((reviewId, index) => ({
      reviewId,
      autoReview: true,
      reviewMode: "background",
      triggerReasons: ["installed_gate_concurrency"],
      context: [
        `安装包并发复查门禁 ${index + 1}/3。`,
        "请核对这段回答是否有事实错误、空答、工具成功但无总结的问题。",
        "原回答: 尼克斯 4:1 击败马刺夺冠；请检查结论是否自洽。",
      ].join("\n"),
      sourceResponse: "尼克斯 4:1 击败马刺夺冠。",
    }));
    await Promise.all(payloads.map((body) => httpJson(baseUrl, token, "/api/review", {
      method: "POST",
      body,
      timeoutMs: 20000,
    })));
    const results = await waitForReviewResults(ws, ids, REVIEW_TIMEOUT_MS);
    const labels = [...results.values()].map((msg) => `${msg.reviewId}:${msg.reviewerModelLabel || "unknown"}`);
    console.log(`[installed-gate] concurrent review ok: ${labels.join(", ")}`);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function main() {
  const appBin = path.join(APP_PATH, "Contents", "MacOS", "Lynn");
  if (!await exists(appBin)) {
    throw new Error(`[installed-gate] missing installed app at ${APP_PATH}`);
  }

  console.log(`[installed-gate] app=${APP_PATH}`);
  await quitExistingLynn();
  if (!ONLY_LIVE_VISION) {
    await run(process.execPath, ["scripts/packaged-server-smoke.mjs", "--app", APP_PATH]);
    await run(process.execPath, ["scripts/packaged-cli-runtime-smoke.mjs", "--app", APP_PATH]);
    await quitExistingLynn();
    await run(process.execPath, ["scripts/packaged-settings-provider-smoke.mjs", "--app", APP_PATH]);
    await quitExistingLynn();
    await run(process.execPath, ["scripts/packaged-main-ui-smoke.mjs", "--app", APP_PATH]);
    await quitExistingLynn();
  }

  const liveFixture = await prepareGateHome();
  let directLaunch = null;
  try {
    if (liveFixture) {
      serverInfoPath = path.join(liveFixture.lynnHome, "server-info.json");
      await fs.rm(serverInfoPath, { force: true }).catch(() => {});
      directLaunch = await launchAppDirect(appBin, {
        ...process.env,
        LYNN_HOME: liveFixture.lynnHome,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        LYNN_LOCAL_MODEL_AUTO_START: "0",
      });
      console.log(`[installed-gate] fixture home=${liveFixture.lynnHome}`);
    } else {
      await fs.rm(serverInfoPath, { force: true }).catch(() => {});
      await run("open", ["-a", APP_PATH]);
    }

    const info = await readServerInfo();
    const baseUrl = `http://127.0.0.1:${info.port}`;
    const wsUrl = `ws://127.0.0.1:${info.port}/ws`;
    const health = await waitForHttpJson(baseUrl, info.token, "/api/health", { timeoutMs: 45000 });
    if (health?.ok !== true && health?.status !== "ok") {
      throw new Error(`[installed-gate] health was not ok: ${JSON.stringify(health)}`);
    }
    await waitForHttpJson(baseUrl, info.token, "/api/review/config", { timeoutMs: 45000 });
    await runLiveVisionGate(baseUrl, wsUrl, info.token);
    if (ONLY_LIVE_VISION) {
      console.log("[installed-gate] PASS: installed live vision gate completed.");
      return;
    }
    await runConcurrentReviewGate(baseUrl, wsUrl, info.token);
    console.log("[installed-gate] PASS: installed GUI/server/CLI/settings/main-ui/live-vision/review concurrency gate completed.");
  } finally {
    if (directLaunch?.child) {
      await terminate(directLaunch.child);
    }
    if (liveFixture?.tmp && process.env.LYNN_INSTALLED_GATE_KEEP_TMP === "1") {
      console.log(`[installed-gate] keeping fixture home=${liveFixture.lynnHome}`);
    } else if (liveFixture?.tmp) {
      await fs.rm(liveFixture.tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
