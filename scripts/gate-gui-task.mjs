#!/usr/bin/env node
// Real GUI task-completion gate. This launches the desktop app, sends a user
// message through the real composer, and requires a visible assistant answer.

import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROMPT = "请只回复四个字：桐门已亮。不要解释，不要调用工具。";
const PROMPT = process.env.LYNN_GUI_GATE_PROMPT || DEFAULT_PROMPT;
const EXPECT = process.env.LYNN_GUI_GATE_EXPECT || "桐门已亮";
const TIMEOUT_MS = Number(process.env.LYNN_GUI_GATE_TIMEOUT_MS || "180000");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDebugPage(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find((item) => String(item.url || "").includes("index.html") && item.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Electron debug page not available${suffix}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result || {});
    });
    this.ws.on("close", () => this.rejectAll(new Error("CDP socket closed")));
    this.ws.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  rejectAll(error) {
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.on("open", () => resolve());
      this.ws.on("error", (error) => reject(error));
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000).unref();
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitForExpression(cdp, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression);
    } catch (error) {
      last = { error: String(error?.message || error) };
      await wait(300);
      continue;
    }
    if (last) return last;
    await wait(300);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(last)}`);
}

async function terminateProcess(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timeout = Symbol("timeout");
  const result = await Promise.race([exited, wait(timeoutMs).then(() => timeout)]);
  if (result === timeout && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

async function seedProfile(lynnHome) {
  await fs.mkdir(path.join(lynnHome, "user"), { recursive: true });
  const realPrefs = await fs.readFile(path.join(os.homedir(), ".lynn", "user", "preferences.json"), "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => ({}));
  await fs.writeFile(
    path.join(lynnHome, "user", "preferences.json"),
    JSON.stringify({
      setupComplete: true,
      locale: "zh-CN",
      update_channel: "stable",
      ...(realPrefs.client_agent_key && realPrefs.client_agent_secret ? {
        client_agent_key: realPrefs.client_agent_key,
        client_agent_secret: realPrefs.client_agent_secret,
      } : {}),
    }, null, 2) + "\n",
    "utf8",
  );
}

async function assertDevServerNativeAbi() {
  const probe = spawn(process.execPath, ["-e", `
    const path = require('node:path');
    const p = path.join(${JSON.stringify(ROOT)}, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    const m = { exports: {} };
    process.dlopen(m, p);
  `], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  probe.stderr.on("data", (chunk) => { err += String(chunk); });
  const code = await new Promise((resolve) => probe.on("close", resolve));
  if (code !== 0) {
    throw new Error(
      "better-sqlite3 native module cannot be loaded by this gate's Node. "
      + "Run `npm rebuild better-sqlite3` before launching the GUI live gate.\n"
      + err.trim(),
    );
  }
}

async function main() {
  const rendererEntry = path.join(ROOT, "desktop", "dist-renderer", "index.html");
  await fs.access(rendererEntry).catch(() => {
    throw new Error("desktop/dist-renderer/index.html missing. Run npm run build:renderer before GUI live gate.");
  });
  await assertDevServerNativeAbi();

  const electronBin = require("electron");
  const debugPort = await getFreePort();
  const lynnHome = path.join(os.tmpdir(), `lynn-gui-live-${process.pid}-${Date.now()}`);
  await seedProfile(lynnHome);

  const child = spawn(electronBin, [
    `--remote-debugging-port=${debugPort}`,
    ROOT,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      LYNN_HOME: lynnHome,
      // Dev/main.cjs launches dist-server-bundle from the repo. Force that child
      // server to use the same Node that loaded node_modules/better-sqlite3
      // above; otherwise Electron's embedded Node can disagree with native ABI
      // and recreate the issue-#72 launch crash during the gate itself.
      LYNN_SERVER_NODE_BIN: process.execPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  let childExit = null;
  child.stdout?.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => logs.push(`[stderr] ${chunk.toString()}`));
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  let cdp = null;
  let completed = false;
  const assertRunning = () => {
    if (childExit) throw new Error(`Electron exited early: code=${childExit.code} signal=${childExit.signal}`);
  };
  try {
    const page = await waitForDebugPage(debugPort);
    assertRunning();
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    await cdp.call("Page.bringToFront");

    console.log("[gate-gui-task] 等待真实桌面主窗口输入框就绪...");
    assertRunning();
    await waitForExpression(cdp, `
      !!document.querySelector('textarea[class*="input-box"]')
      && !!document.querySelector('button[class*="send-btn"]')
      && !document.body.innerText.includes('No model')
      && !document.body.innerText.includes('reconnecting')
    `, 90000);

    console.log("[gate-gui-task] 发送真实用户消息...");
    assertRunning();
    await cdp.evaluate(`(() => {
      const prompt = ${JSON.stringify(PROMPT)};
      const el = document.querySelector('textarea[class*="input-box"]');
      if (!el) throw new Error('composer textarea not found');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, prompt);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return true;
    })()`);

    assertRunning();
    await waitForExpression(cdp, `
      (() => {
        const btn = document.querySelector('button[class*="send-btn"]:not(:disabled)');
        return !!btn;
      })()
    `, 30000);

    assertRunning();
    await cdp.evaluate(`(() => {
      const btn = document.querySelector('button[class*="send-btn"]:not(:disabled)');
      if (!btn) throw new Error('send button disabled');
      btn.click();
      return true;
    })()`);

    console.log("[gate-gui-task] 等待真实 assistant 消息渲染...");
    assertRunning();
    const answer = await waitForExpression(cdp, `
      (() => {
        const assistantTexts = Array.from(document.querySelectorAll('[class*="messageAssistant"]'))
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        const joined = assistantTexts.join('\\n');
        const hasExpected = joined.includes(${JSON.stringify(EXPECT)});
        return hasExpected ? joined : '';
      })()
    `, TIMEOUT_MS);

    const allText = await cdp.evaluate(`document.body.innerText || ''`).catch(() => "");
    if (!String(answer || "").includes(EXPECT)) {
      throw new Error(`assistant visible answer did not include ${EXPECT}; body=${String(allText).slice(0, 1200)}`);
    }
    const hasRefusal = /(?:无法|不能|没有|缺少|未能|无法确认).{0,28}(?:本地|文件|文件系统|目录|工具|权限|访问|读取)/.test(String(answer))
      || /(?:抱歉).{0,28}(?:无法|不能|没有|缺少|未能|无法确认)/.test(String(answer));
    if (hasRefusal) {
      throw new Error(`assistant visible answer included a local-file refusal; answer=${String(answer).replace(/\s+/g, " ").slice(0, 1200)}`);
    }

    console.log("[gate-gui-task] PASS — 真实 GUI 对话链路完成");
    console.log(`[gate-gui-task] assistant excerpt: ${String(answer).replace(/\\s+/g, " ").slice(0, 240)}`);
    completed = true;
  } finally {
    cdp?.close();
    await fs.mkdir(path.join(ROOT, "output"), { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(ROOT, "output", "gate-gui-task.log"), logs.join("")).catch(() => {});
    await terminateProcess(child);
  }
  if (!completed) throw new Error("GUI live gate ended before completing the real task");
}

main().catch((error) => {
  console.error(`[gate-gui-task] ${error?.stack || error}`);
  process.exit(1);
});
