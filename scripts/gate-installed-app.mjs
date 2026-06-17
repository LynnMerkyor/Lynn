#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APP = "/Applications/Lynn.app";
const appArgIndex = process.argv.indexOf("--app");
const APP_PATH = path.resolve(appArgIndex >= 0 ? process.argv[appArgIndex + 1] : DEFAULT_APP);
const SERVER_INFO = path.join(os.homedir(), ".lynn", "server-info.json");
const REVIEW_TIMEOUT_MS = Number(process.env.LYNN_INSTALLED_GATE_REVIEW_TIMEOUT_MS || "240000");

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

async function quitExistingLynn() {
  await new Promise((resolve) => {
    const child = spawn("osascript", ["-e", 'tell application "Lynn" to quit'], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("exit", resolve);
    child.on("error", resolve);
  });
  await wait(2000);
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
      const raw = await fs.readFile(SERVER_INFO, "utf8");
      const info = JSON.parse(raw);
      if (Number.isFinite(Number(info.port)) && info.token) return info;
      last = raw;
    } catch (error) {
      last = error?.message || String(error);
    }
    await wait(500);
  }
  throw new Error(`[installed-gate] timed out waiting for ${SERVER_INFO}; last=${String(last || "")}`);
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
  await run(process.execPath, ["scripts/packaged-server-smoke.mjs", "--app", APP_PATH]);
  await run(process.execPath, ["scripts/packaged-cli-runtime-smoke.mjs", "--app", APP_PATH]);
  await quitExistingLynn();
  await run(process.execPath, ["scripts/packaged-settings-provider-smoke.mjs", "--app", APP_PATH]);
  await quitExistingLynn();
  await run(process.execPath, ["scripts/packaged-main-ui-smoke.mjs", "--app", APP_PATH]);

  await quitExistingLynn();
  await run("open", ["-a", APP_PATH]);
  const info = await readServerInfo();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  const wsUrl = `ws://127.0.0.1:${info.port}/ws`;
  const health = await httpJson(baseUrl, info.token, "/api/health", { timeoutMs: 12000 });
  if (health?.ok !== true && health?.status !== "ok") {
    throw new Error(`[installed-gate] health was not ok: ${JSON.stringify(health)}`);
  }
  await httpJson(baseUrl, info.token, "/api/review/config", { timeoutMs: 12000 });
  await runConcurrentReviewGate(baseUrl, wsUrl, info.token);
  console.log("[installed-gate] PASS: installed GUI/server/CLI/settings/main-ui/review concurrency gate completed.");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
