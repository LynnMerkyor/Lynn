#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "output");

const SCENARIOS = [
  { id: "home", expect: ["Lynn"] },
  { id: "short", expect: ["UI_SMOKE_SHORT_OK"] },
  { id: "tools", expect: ["UI_SMOKE_TOOL_CARD", "reports/summary.md"] },
  { id: "image-tool-empty", expect: ["UI_SMOKE_IMAGE_TOOL", "image_analyze", "编辑重发"] },
  { id: "long-code", expect: ["UI_SMOKE_LONG_CODE", "calculateTotal"] },
  { id: "automation", expect: ["自动任务", "定时工作小结", "文件自动归纳"] },
];

const AUTOMATION_VISUAL_CASES = [
  { theme: "warm-paper", width: 1440, height: 900 },
  { theme: "warm-paper", width: 1024, height: 768 },
  { theme: "warm-paper", width: 720, height: 900 },
  { theme: "midnight", width: 1440, height: 900 },
  { theme: "midnight", width: 1024, height: 768 },
  { theme: "midnight", width: 720, height: 900 },
];

interface DebugPage {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

type PendingCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason?: unknown) => void;
};

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
  exceptionDetails?: { text?: string };
}

interface RuntimeEvaluateResult extends Record<string, unknown> {
  exceptionDetails?: { text?: string };
  result?: { value?: unknown };
}

interface Snapshot {
  scenario?: string;
  visibleText?: string;
  overflowX: number;
  hasRoot: boolean;
  hasSidebar: boolean;
  hasTitlebar: boolean;
}

interface ScenarioResult {
  id: string;
  ok: boolean;
  failures: string[];
  screenshot: string;
}

interface VisualSnapshot {
  visibleText?: string;
  rootOverflowX: number;
  dialogOverflowX: number;
  dialogInsideViewport: boolean;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcess(child: ChildProcess | null, timeoutMs = 3000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  const timedOut = Symbol("timedOut");
  const result = await Promise.race([
    exited,
    wait(timeoutMs).then(() => timedOut),
  ]);

  if (result !== timedOut || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Process already exited between the state check and signal delivery.
  }
}

async function fetchJson<T = unknown>(url: string, timeoutMs = 1000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDebugPage(port: number, timeoutMs = 20000): Promise<DebugPage> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson<DebugPage[]>(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find((item) => String(item.url || "").includes("index.html"))
        || pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
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
  ws: WebSocket;
  nextId: number;
  pending: Map<number, PendingCall>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      let msg: CdpResponse;
      try {
        msg = JSON.parse(raw.toString()) as CdpResponse;
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
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.on("open", () => resolve());
      this.ws.on("error", (error) => reject(error));
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000).unref();
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as RuntimeEvaluateResult;
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // The debugger socket may already be closed during Electron teardown.
    }
  }
}

async function waitForExpression(cdp: CdpClient, expression: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression).catch(() => false);
    if (value) return true;
    await wait(200);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

function assertScenario(id: string, snapshot: Snapshot, expectedTexts: string[]): string[] {
  const failures: string[] = [];
  const text = String(snapshot.visibleText || "");
  if (snapshot.scenario !== id) failures.push(`scenario did not apply: expected ${id}, got ${snapshot.scenario || "(none)"}`);
  if (snapshot.overflowX > 2) failures.push(`horizontal overflow: ${snapshot.overflowX}px`);
  for (const expected of expectedTexts) {
    if (!text.includes(expected)) failures.push(`missing visible text: ${expected}`);
  }
  if (!snapshot.hasRoot) failures.push("react root missing");
  if (!snapshot.hasSidebar) failures.push("sidebar missing");
  if (!snapshot.hasTitlebar) failures.push("titlebar missing");
  return failures;
}

function comparePng(actual: Buffer, baseline: Buffer): { changedRatio: number; diff: Buffer } {
  const { PNG } = require("pngjs") as typeof import("pngjs");
  const actualPng = PNG.sync.read(actual);
  const baselinePng = PNG.sync.read(baseline);
  if (actualPng.width !== baselinePng.width || actualPng.height !== baselinePng.height) {
    throw new Error(`image dimensions differ: actual ${actualPng.width}x${actualPng.height}, baseline ${baselinePng.width}x${baselinePng.height}`);
  }
  const diffPng = new PNG({ width: actualPng.width, height: actualPng.height });
  let changed = 0;
  const pixelCount = actualPng.width * actualPng.height;
  for (let offset = 0; offset < actualPng.data.length; offset += 4) {
    const delta = Math.max(
      Math.abs(actualPng.data[offset] - baselinePng.data[offset]),
      Math.abs(actualPng.data[offset + 1] - baselinePng.data[offset + 1]),
      Math.abs(actualPng.data[offset + 2] - baselinePng.data[offset + 2]),
      Math.abs(actualPng.data[offset + 3] - baselinePng.data[offset + 3]),
    );
    if (delta > 24) changed += 1;
    if (delta > 24) {
      diffPng.data[offset] = 255;
      diffPng.data[offset + 1] = 42;
      diffPng.data[offset + 2] = 72;
      diffPng.data[offset + 3] = 255;
    } else {
      const gray = Math.round((baselinePng.data[offset] + baselinePng.data[offset + 1] + baselinePng.data[offset + 2]) / 3);
      diffPng.data[offset] = gray;
      diffPng.data[offset + 1] = gray;
      diffPng.data[offset + 2] = gray;
      diffPng.data[offset + 3] = 96;
    }
  }
  return { changedRatio: changed / pixelCount, diff: PNG.sync.write(diffPng) };
}

async function main(): Promise<void> {
  const rendererEntry = path.join(ROOT, "desktop", "dist-renderer", "index.html");
  try {
    await fs.access(rendererEntry);
  } catch {
    throw new Error("desktop/dist-renderer/index.html missing. Run npm run build:renderer before UI smoke.");
  }

  const outputDir = path.join(DEFAULT_OUTPUT_ROOT, `ui-smoke-${nowStamp()}`);
  await fs.mkdir(outputDir, { recursive: true });
  const deviceScaleFactor = Number(process.env.LYNN_UI_DPR || 1);
  if (![1, 1.25, 1.5].includes(deviceScaleFactor)) throw new Error('Unsupported UI DPR');
  const baselineName = process.platform === 'darwin' && deviceScaleFactor === 1 ? 'automation' : `automation-${process.platform}-${deviceScaleFactor}`;
  const baselineDir = process.env.LYNN_VISUAL_BASELINE_DIR || path.join(ROOT, "desktop", "__tests__", "visual-baselines", baselineName);
  const updateBaselines = process.env.LYNN_UPDATE_VISUAL_BASELINES === "1";
  if (updateBaselines) console.log('[ui-smoke] CANDIDATE CAPTURE: interaction assertions only; screenshots require review and a separate baseline-comparison run.');
  const visualOnly = process.argv.includes("--automation-visual-only");
  if (updateBaselines) await fs.mkdir(baselineDir, { recursive: true });

  const electronBin = require("electron");
  const debugPort = await getFreePort();
  const lynnHome = path.join(os.tmpdir(), `lynn-ui-smoke-${process.pid}-${Date.now()}`);
  await fs.mkdir(lynnHome, { recursive: true });

  const child = spawn(electronBin, [
    `--remote-debugging-port=${debugPort}`,
    ROOT,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      LYNN_HOME: lynnHome,
      LYNN_UI_SMOKE: "1",
      LYNN_UI_NO_FRONT: process.env.LYNN_UI_NO_FRONT || "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: string[] = [];
  child.stdout?.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => logs.push(`[stderr] ${chunk.toString()}`));

  const results: ScenarioResult[] = [];
  let cdp: CdpClient | null = null;
  try {
    const page = await waitForDebugPage(debugPort);
    if (!page.webSocketDebuggerUrl) throw new Error("Electron debug page missing webSocketDebuggerUrl");
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.call("Emulation.setTimezoneOverride", { timezoneId: 'Asia/Shanghai' });
    if (process.env.LYNN_UI_NO_FRONT !== "1") {
      await cdp.call("Page.bringToFront");
    }
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor,
      mobile: false,
    });

    await waitForExpression(cdp, "window.__lynnUiSmokeReady === true");

    for (const scenario of visualOnly ? [] : SCENARIOS) {
      await cdp.evaluate(`window.__lynnSetUiSmokeScenario(${JSON.stringify(scenario.id)})`);
      await waitForExpression(cdp, `document.body.dataset.uiSmokeScenario === ${JSON.stringify(scenario.id)}`);
      await wait(350);
      await cdp.evaluate(`window.__lynnPrepareUiSmokeCapture?.()`);
      const snapshot = await cdp.evaluate(`(() => {
        const root = document.documentElement;
        const body = document.body;
        return {
          scenario: body.dataset.uiSmokeScenario || '',
          visibleText: body.innerText || '',
          overflowX: Math.max(root.scrollWidth, body.scrollWidth) - window.innerWidth,
          hasRoot: !!document.getElementById('react-root'),
          hasSidebar: !!document.querySelector('.sidebar'),
          hasTitlebar: !!document.querySelector('.titlebar'),
        };
      })()`) as Snapshot;
      const failures = assertScenario(scenario.id, snapshot, scenario.expect);
      if (/\b(?:sidebar|welcome|input|automation|cron)\.[A-Za-z][\w.]+/.test(snapshot.visibleText || '')) failures.push('untranslated locale key in visible UI');
      const screenshot = await cdp.call("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      }) as { data?: string };
      const screenshotPath = path.join(outputDir, `${scenario.id}.png`);
      await fs.writeFile(screenshotPath, Buffer.from(String(screenshot.data || ""), "base64"));
      results.push({
        id: scenario.id,
        ok: failures.length === 0,
        failures,
        screenshot: path.relative(ROOT, screenshotPath),
      });
      console.log(`[ui-smoke] ${scenario.id}: ${failures.length === 0 ? "PASS" : "FAIL"}`);
      for (const failure of failures) console.log(`  - ${failure}`);
    }

    const historyMetrics: unknown[] = [];
    for (const count of visualOnly ? [] : [100, 500, 2000]) {
      await cdp.evaluate(`window.__lynnSetUiSmokeScenario('home')`);
      await wait(50);
      const started = Date.now();
      await cdp.evaluate(`window.__lynnSetUiSmokeScenario('history-${count}')`);
      await waitForExpression(cdp, `document.querySelector('[role="log"][aria-hidden="false"]')?.innerText.includes('HISTORY_${count - 1}')`);
      const firstPaintMs = Date.now() - started;
      await wait(400);
      const metric = await cdp.evaluate(`(() => {
        const panel = document.querySelector('[role="log"][aria-hidden="false"]');
        const mounted = [...panel.querySelectorAll('[data-history-page]')].reduce((sum, page) => sum + page.childElementCount, 0);
        return { count: ${count}, firstPaintMs: ${firstPaintMs}, mounted, scrollHeight: panel.scrollHeight,
          atBottom: panel.scrollHeight - panel.clientHeight - panel.scrollTop < 50,
          heapBytes: performance.memory?.usedJSHeapSize || null };
      })()`) as { count: number; firstPaintMs: number; mounted: number; atBottom: boolean };
      const failures: string[] = [];
      if (metric.mounted > 160) failures.push(`unbounded rich history DOM: ${metric.mounted}`);
      if (!metric.atBottom) failures.push('initial history does not settle at latest message');
      if (firstPaintMs > 10000) failures.push(`history first paint too slow: ${firstPaintMs}ms`);
      await cdp.evaluate(`document.querySelector('[role="log"][aria-hidden="false"]').scrollTop = 0`);
      await waitForExpression(cdp, `document.querySelector('[role="log"][aria-hidden="false"]')?.innerText.includes('HISTORY_0:')`);
      await wait(400);
      const top = await cdp.evaluate(`document.querySelector('[role="log"][aria-hidden="false"]').scrollTop`) as number;
      if (top > 50) failures.push(`history top anchor drifted: ${top}px`);
      historyMetrics.push({ ...metric, topScroll: top });
      results.push({ id: `history-${count}`, ok: !failures.length, failures, screenshot: '' });
      console.log(`[ui-smoke] history-${count}: ${failures.length ? 'FAIL' : 'PASS'} (${firstPaintMs}ms, ${metric.mounted} mounted)`, failures.join('; '));
    }
    if (historyMetrics.length) await fs.writeFile(path.join(outputDir, 'history-performance.json'), JSON.stringify(historyMetrics, null, 2));

    for (const visualCase of AUTOMATION_VISUAL_CASES) {
      const id = `automation-${visualCase.theme}-${visualCase.width}x${visualCase.height}`;
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: visualCase.width,
        height: visualCase.height,
        deviceScaleFactor,
        mobile: false,
      });
      await cdp.evaluate(`window.applyTheme(${JSON.stringify(visualCase.theme)})`);
      await waitForExpression(cdp, `document.documentElement.dataset.theme === ${JSON.stringify(visualCase.theme)}`);
      await cdp.evaluate(`window.__lynnSetUiSmokeScenario("home")`);
      await wait(50);
      await cdp.evaluate(`window.__lynnSetUiSmokeScenario("automation")`);
      await waitForExpression(cdp, `document.body.dataset.uiSmokeScenario === "automation"`);
      await waitForExpression(cdp, `document.body.innerText.includes("定时工作小结") && !!document.querySelector('[class*="automationDialog"]')`);
      await wait(500);
      await cdp.evaluate(`document.fonts.ready`);
      await cdp.evaluate(`window.__lynnPrepareUiSmokeCapture?.()`);
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      await wait(250);

      const snapshot = await cdp.evaluate(`(() => {
        const root = document.documentElement;
        const body = document.body;
        const dialog = document.querySelector('[class*="automationDialog"]');
        const rect = dialog?.getBoundingClientRect();
        return {
          visibleText: body.innerText || '',
          rootOverflowX: Math.max(root.scrollWidth, body.scrollWidth) - window.innerWidth,
          dialogOverflowX: dialog ? dialog.scrollWidth - dialog.clientWidth : 999,
          dialogInsideViewport: !!rect && rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
        };
      })()`) as VisualSnapshot;
      const failures: string[] = [];
      if (snapshot.rootOverflowX > 2) failures.push(`root horizontal overflow: ${snapshot.rootOverflowX}px`);
      if (snapshot.dialogOverflowX > 2) failures.push(`dialog horizontal overflow: ${snapshot.dialogOverflowX}px`);
      if (!snapshot.dialogInsideViewport) failures.push("automation dialog escapes the viewport");
      for (const text of ["自动任务", "定时工作小结", "文件自动归纳", "新建自定义任务"]) {
        if (!String(snapshot.visibleText || "").includes(text)) failures.push(`missing visible text: ${text}`);
      }
      if (/\b(?:sidebar|welcome|input|automation|cron)\.[A-Za-z][\w.]+/.test(snapshot.visibleText || '')) failures.push('untranslated locale key in automation');

      const screenshot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }) as { data?: string };
      const actual = Buffer.from(String(screenshot.data || ""), "base64");
      const screenshotPath = path.join(outputDir, `${id}.png`);
      const baselinePath = path.join(baselineDir, `${id}.png`);
      await fs.writeFile(screenshotPath, actual);
      if (updateBaselines) {
        await fs.writeFile(baselinePath, actual);
      } else {
        try {
          const baseline = await fs.readFile(baselinePath);
          const comparison = comparePng(actual, baseline);
          if (comparison.changedRatio > 0.005) {
            failures.push(`visual difference ${(comparison.changedRatio * 100).toFixed(3)}% exceeds 0.500%`);
            await fs.writeFile(path.join(outputDir, `${id}-diff.png`), comparison.diff);
          }
        } catch (error) {
          failures.push(`visual baseline unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      results.push({ id, ok: failures.length === 0, failures, screenshot: path.relative(ROOT, screenshotPath) });
      console.log(`[ui-smoke] ${id}: ${failures.length === 0 ? "PASS" : "FAIL"}`);
      for (const failure of failures) console.log(`  - ${failure}`);

      const clickText = async (text: string) => {
        await cdp!.evaluate(`(() => {
          const button = [...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent.trim() === ${JSON.stringify(text)});
          if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
          button.click();
        })()`);
        await wait(150);
      };
      const captureState = async (state: string, expected: string[], assertion = 'true', preserveFocus = false) => {
        await wait(250);
        await cdp!.evaluate(`window.__lynnPrepareUiSmokeCapture?.(${preserveFocus})`);
        await cdp!.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
        await wait(250);
        const stateId = `${id}-${state}`;
        const errors: string[] = [];
        const result = await cdp!.evaluate(`(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const rect = dialog.getBoundingClientRect();
          return { text: dialog.innerText, valid: (${assertion}), overflow: dialog.scrollWidth - dialog.clientWidth,
            inside: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 };
        })()`) as { text: string; valid: boolean; overflow: number; inside: boolean };
        for (const text of expected) if (!result.text.includes(text)) errors.push(`missing state text: ${text}`);
        if (!result.valid) errors.push('state/request assertion failed');
        if (result.overflow > 2 || !result.inside) errors.push('state layout overflows');
        if (/\b(?:sidebar|welcome|input|automation|cron)\.[A-Za-z][\w.]+/.test(result.text)) errors.push('untranslated state');
        const shot = await cdp!.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as { data: string };
        const bytes = Buffer.from(shot.data, 'base64');
        const shotPath = path.join(outputDir, `${stateId}.png`);
        const basePath = path.join(baselineDir, `${stateId}.png`);
        await fs.writeFile(shotPath, bytes);
        if (updateBaselines) await fs.writeFile(basePath, bytes);
        else {
          try {
            const comparison = comparePng(bytes, await fs.readFile(basePath));
            if (comparison.changedRatio > 0.005) {
              errors.push(`visual difference ${(comparison.changedRatio * 100).toFixed(3)}% exceeds 0.500%`);
              await fs.writeFile(path.join(outputDir, `${stateId}-diff.png`), comparison.diff);
            }
          } catch (error) { errors.push(`visual baseline unavailable: ${String(error)}`); }
        }
        results.push({ id: stateId, ok: !errors.length, failures: errors, screenshot: path.relative(ROOT, shotPath) });
        console.log(`[ui-smoke] ${stateId}: ${errors.length ? 'FAIL' : 'PASS'}`, errors.join('; '));
      };
      await clickText('新建任务 / 模板');
      await captureState('templates', ['日报 / 周报', '文件整理', '提醒跟进']);
      await cdp.evaluate(`document.querySelector('[class*="automationTemplateCard"]').click()`);
      await waitForExpression(cdp, `document.body.innerText.includes('使用模板：')`);
      await clickText('查看模板内容');
      await captureState('editor', ['任务内容', '创建并测试']);
      await cdp.evaluate(`window.__lynnAutomationFailNextRun = true`);
      await clickText('创建并测试');
      await waitForExpression(cdp, `document.body.innerText.includes('任务已保存，但测试未启动')`);
      await captureState('saved-test-failed', ['任务已保存，但测试未启动', '保存并测试'], `window.__lynnAutomationSmokeData.jobs.length === 3 && window.__lynnAutomationRequests.filter(r => r.action === 'add').length === 1`);
      await clickText('保存并测试');
      await waitForExpression(cdp, `!document.querySelector('[class*="automationComposer"]')`);
      await captureState('retry-saved', ['已创建任务'], `window.__lynnAutomationSmokeData.jobs.length === 3 && window.__lynnAutomationRequests.filter(r => r.action === 'add').length === 1 && window.__lynnAutomationRequests.filter(r => r.action === 'update').length === 1`);

      await cdp.evaluate(`(() => {
        const job = window.__lynnAutomationSmokeData.jobs[0];
        job.type = 'cron'; job.schedule = '0 9 1 * *';
        job.model = 'brain/step-3.7-flash';
      })()`);
      await clickText('编辑');
      await waitForExpression(cdp, `document.body.innerText.includes('保留原有执行计划')`);
      await captureState('complex-schedule', ['保留原有执行计划', '0 9 1 * *', '保存修改']);
      await cdp.evaluate(`(() => {
        const label = [...document.querySelectorAll('[class*="automationComposer"] label')].find(node => node.querySelector('span')?.textContent === '模型');
        const select = label.querySelector('select');
        select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await clickText('保存修改');
      await clickText('编辑');
      await captureState('default-model', ['保留原有执行计划'], `window.__lynnAutomationSmokeData.jobs[0].schedule === '0 9 1 * *' && window.__lynnAutomationSmokeData.jobs[0].model === '' && !Object.hasOwn(window.__lynnAutomationRequests.filter(r => r.action === 'update').at(-1), 'schedule')`);

      await cdp.evaluate(`window.__lynnSetUiSmokeScenario('home')`);
      await wait(50);
      await cdp.evaluate(`window.__lynnSetUiSmokeScenario('automation-long-path')`);
      await waitForExpression(cdp, `!!document.querySelector('[class*="automationJobGrid"]')`);
      await clickText('编辑');
      await captureState('long-project', ['长期维护与自动任务验收', '保存修改'], `document.querySelector('[class*="automationComposer"] select').value.includes('very-long-project-name')`);

      await cdp.evaluate(`document.querySelector('[role="dialog"] button').focus({ preventScroll: true })`);
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await captureState('keyboard-focus', ['自动任务'], `document.activeElement.matches('button:focus-visible') && parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2 && getComputedStyle(document.activeElement).outlineStyle !== 'none'`, true);

      await cdp.evaluate(`window.__lynnSetUiSmokeScenario('home')`);
      await wait(50);
      await cdp.evaluate(`window.__lynnSetUiSmokeScenario('automation-empty')`);
      await waitForExpression(cdp, `document.body.innerText.includes('还没有自动任务')`);
      await captureState('empty', ['还没有自动任务', '新建任务 / 模板'], `window.__lynnAutomationSmokeData.jobs.length === 0`);
    }
  } finally {
    cdp?.close();
    await fs.writeFile(path.join(outputDir, "electron.log"), logs.join(""));
    await terminateProcess(child);
  }

  const failed = results.filter((item) => !item.ok);
  await fs.writeFile(path.join(outputDir, "results.json"), JSON.stringify({ mode: updateBaselines ? 'candidate' : 'regression', platform: process.platform, deviceScaleFactor, results }, null, 2) + "\n");
  console.log(`Report: ${path.relative(ROOT, outputDir)}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  console.error(`[ui-smoke] ${message}`);
  process.exit(1);
});
