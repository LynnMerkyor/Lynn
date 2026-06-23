/**
 * browser-manager.js — 浏览器生命周期管理
 *
 * 单例模式。运行在 server 进程中，通过可插拔的 transport 层与
 * 浏览器宿主通信（IPC for fork 模式 / WS for spawn 模式）。
 *
 * 好处：
 * - 浏览器直接嵌在 Electron 窗口里，用户可以实时看到并交互
 * - Cookies / localStorage 由 Electron session 持久化
 * - 不依赖 Playwright（不需要下载 Chromium 二进制）
 *
 * session 绑定：
 * - 每个 chat session 可以独立拥有自己的浏览器实例
 * - 切换 session 时，浏览器被挂起（不销毁），切回来直接恢复
 * - 页面状态（表单、滚动位置等）完全保留
 * - 重启后通过冷保存的 URL 自动恢复浏览器
 *
 * snapshot 实现：主进程通过 webContents.executeJavaScript() 遍历 DOM，
 * 给交互元素注入 data-hana-ref 属性。
 */
import crypto from "crypto";
import os from "os";
import path from "path";
import fs from "fs";
import { t } from "../../shared/i18n-runtime.js";
import { IpcTransport, WsTransport } from "./browser-transport.js";

type SessionPath = string | null | undefined;
type SessionResolver = () => SessionPath;
type ColdState = Record<string, string>;
type BrowserRef = string | number;

interface PendingCommandEntry {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BrowserResultMessage {
  type: "browser-result";
  id: string;
  error?: unknown;
  result?: unknown;
}

interface BrowserWebSocket {
  on(event: "message", listener: (data: unknown) => void): unknown;
  off(event: "message", listener: (data: unknown) => void): unknown;
  send(data: string): unknown;
  readonly readyState?: number;
}

interface BrowserTransport {
  readonly connected: boolean;
  send(msg: BrowserCommandMessage): void;
  onMessage(handler: (msg: unknown) => void): void;
}

interface WsBrowserTransport extends BrowserTransport {
  attach(ws: BrowserWebSocket): void;
  detach(): void;
}

type EmptyParams = Record<string, never>;

interface BrowserNavigateResult {
  url: string;
  title: string;
  snapshot: string;
}

interface BrowserSnapshotResult {
  currentUrl: string | null;
  text: string;
}

interface BrowserScreenshotResult {
  base64: string;
}

interface BrowserThumbnailResult {
  base64: string | null;
}

interface BrowserTextResult {
  currentUrl: string | null;
  text: string;
}

interface BrowserSimpleTextResult {
  text: string;
}

interface BrowserResumeResult {
  found: boolean;
  url?: string | null;
}

interface BrowserEvaluateResult {
  value: string;
}

interface BrowserWaitOptions {
  timeout?: number;
  state?: string;
  [key: string]: unknown;
}

interface BrowserTypeOptions {
  pressEnter?: boolean;
}

interface BrowserCommandParamsMap {
  launch: { sessionPath: SessionPath; headless?: boolean };
  close: EmptyParams;
  suspend: { sessionPath: SessionPath };
  resume: { sessionPath: SessionPath };
  destroyView: { sessionPath: SessionPath };
  navigate: { url: string };
  snapshot: EmptyParams;
  screenshot: EmptyParams;
  thumbnail: EmptyParams;
  click: { ref: BrowserRef };
  type: { text: string; ref?: BrowserRef; pressEnter: boolean };
  scroll: { direction: string; amount: number };
  select: { ref: BrowserRef; value: string };
  pressKey: { key: string };
  wait: BrowserWaitOptions;
  evaluate: { expression: string };
  show: EmptyParams;
}

interface BrowserCommandResultMap {
  launch: unknown;
  close: unknown;
  suspend: unknown;
  resume: BrowserResumeResult;
  destroyView: unknown;
  navigate: BrowserNavigateResult;
  snapshot: BrowserSnapshotResult;
  screenshot: BrowserScreenshotResult;
  thumbnail: BrowserThumbnailResult;
  click: BrowserTextResult;
  type: BrowserTextResult;
  scroll: BrowserSimpleTextResult;
  select: BrowserSimpleTextResult;
  pressKey: BrowserSimpleTextResult;
  wait: BrowserSimpleTextResult;
  evaluate: BrowserEvaluateResult;
  show: unknown;
}

type BrowserCommandName = keyof BrowserCommandParamsMap;

interface BrowserCommandMessage<K extends BrowserCommandName = BrowserCommandName> {
  type: "browser-cmd";
  id: string;
  cmd: K;
  params: BrowserCommandParamsMap[K];
}

function asBrowserResultMessage(msg: unknown): BrowserResultMessage | null {
  const candidate = msg as { type?: unknown; id?: unknown } | null | undefined;
  if (candidate?.type !== "browser-result" || typeof candidate.id !== "string") {
    return null;
  }
  return msg as BrowserResultMessage;
}

// ── 单例 ──
let _instance: BrowserManager | null = null;
let _sessionResolver: SessionResolver | null = null; // () => string — 返回当前 sessionPath

// 冷保存文件：重启后恢复浏览器状态
const _browserHome = process.env.LYNN_HOME
  ? path.resolve(process.env.LYNN_HOME.replace(/^~/, os.homedir()))
  : path.join(os.homedir(), ".lynn");
const COLD_STATE_PATH = path.join(_browserHome, "user", "browser-sessions.json");

export class BrowserManager {
  _running: boolean;
  _url: string | null;
  _headless: boolean;
  _pending: Map<string, PendingCommandEntry>;
  _transport: BrowserTransport;

  constructor() {
    this._running = false;
    this._url = null;
    this._headless = false; // 后台模式：浏览器运行但不弹窗
    this._pending = new Map(); // id → { resolve, reject, timer }

    // 根据环境选择 transport：fork 模式用 IPC，spawn 模式用 WS
    this._transport = (process.send ? new IpcTransport() : new WsTransport()) as BrowserTransport;

    // 注册消息处理器（IPC 立即生效，WS 在 attach 时生效）
    this._transport.onMessage((msg) => {
      const resultMsg = asBrowserResultMessage(msg);
      if (!resultMsg || !this._pending.has(resultMsg.id)) return;
      const entry = this._pending.get(resultMsg.id);
      if (!entry) return;
      this._pending.delete(resultMsg.id);
      clearTimeout(entry.timer);
      if (resultMsg.error) entry.reject(new Error(resultMsg.error as string));
      else entry.resolve(resultMsg.result);
    });
  }

  /** 获取单例 */
  static instance(): BrowserManager {
    if (!_instance) _instance = new BrowserManager();
    return _instance;
  }

  /**
   * 注入 session 路径解析器（避免循环依赖）
   * @param {() => string} fn - 返回当前 engine.currentSessionPath
   */
  static setSessionResolver(fn: SessionResolver | null | undefined): void {
    _sessionResolver = fn || null;
  }

  /** 浏览器是否正在运行 */
  get isRunning(): boolean {
    return this._running;
  }

  /** 是否后台模式 */
  get isHeadless(): boolean {
    return this._headless;
  }

  /** 设置后台模式（后台任务调用前设 true，结束后设 false） */
  setHeadless(val: unknown): void {
    this._headless = !!val;
  }

  /** 当前页面 URL */
  get currentUrl(): string | null {
    return this._url;
  }

  /** 获取当前 session 路径 */
  _getCurrentSession(): SessionPath {
    return _sessionResolver ? _sessionResolver() : null;
  }

  // ════════════════════════════
  //  冷保存（磁盘持久化）
  // ════════════════════════════

  _loadColdState(): ColdState {
    try {
      return JSON.parse(fs.readFileSync(COLD_STATE_PATH, "utf-8")) as ColdState;
    } catch {
      return {};
    }
  }

  _saveColdState(state: ColdState): void {
    try {
      fs.writeFileSync(COLD_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    } catch (e) { console.warn("[browser-manager]", (e as { message?: unknown }).message || e); }
  }

  _saveColdUrl(sessionPath: SessionPath, url: string | null): void {
    if (!sessionPath || !url) return;
    const state = this._loadColdState();
    state[sessionPath] = url;
    this._saveColdState(state);
  }

  _removeColdUrl(sessionPath: SessionPath): void {
    if (!sessionPath) return;
    const state = this._loadColdState();
    delete state[sessionPath];
    this._saveColdState(state);
  }

  /**
   * 获取所有有浏览器的 session（活跃 + 冷保存）
   * @returns {{ [sessionPath: string]: string }} sessionPath → url
   */
  getBrowserSessions(): ColdState {
    const state = this._loadColdState();
    // 合入当前活跃的
    const session = this._getCurrentSession();
    if (this._running && session && this._url) {
      state[session] = this._url;
    }
    return state;
  }

  // ════════════════════════════
  //  Transport
  // ════════════════════════════

  /**
   * 注入 WS transport（server 启动时调用）
   * @param {import("ws").WebSocket|null} ws
   */
  setWsTransport(ws: BrowserWebSocket | null): void {
    const transport = this._transport;
    if (transport instanceof WsTransport) {
      const wsTransport = transport as WsBrowserTransport;
      if (ws) {
        wsTransport.attach(ws);
        // handler 已在构造函数中通过 onMessage 注册，attach 会自动绑定
      } else {
        wsTransport.detach();
      }
    }
  }

  /**
   * 向浏览器宿主发送命令并等待结果
   * @param {string} cmd - 命令名
   * @param {object} params - 参数
   * @param {number} timeoutMs - 超时（默认 30s）
   * @returns {Promise<any>}
   */
  _sendCmd<K extends BrowserCommandName>(
    cmd: K,
    params = {} as BrowserCommandParamsMap[K],
    timeoutMs = 30000,
  ): Promise<BrowserCommandResultMap[K]> {
    if (!this._transport.connected) {
      throw new Error(t("error.browserDesktopOnly"));
    }
    return new Promise<BrowserCommandResultMap[K]>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(t("error.browserCmdTimeout", { cmd })));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this._transport.send({ type: "browser-cmd", id, cmd, params });
    });
  }

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  async launch(): Promise<void> {
    if (this._running) return;
    const sessionPath = this._getCurrentSession();
    await this._sendCmd("launch", { sessionPath, headless: this._headless });
    this._running = true;
    console.log("[browser] 浏览器已启动", this._headless ? "(headless)" : "");
  }

  async close(): Promise<void> {
    if (!this._running) return;
    const session = this._getCurrentSession();
    try { await this._sendCmd("close"); } catch {}
    this._running = false;
    this._url = null;
    // 从冷保存中移除
    this._removeColdUrl(session);
    console.log("[browser] 浏览器已关闭");
  }

  /**
   * 挂起浏览器：从窗口上摘下来，但不销毁（页面状态完全保留）
   * 同时写入冷保存，确保重启后也能恢复
   * @param {string} sessionPath - 当前 session 路径
   */
  async suspendForSession(sessionPath: SessionPath): Promise<void> {
    if (!this._running) return;
    // 冷保存 URL
    this._saveColdUrl(sessionPath, this._url);
    console.log("[browser] 挂起浏览器");
    try { await this._sendCmd("suspend", { sessionPath }); } catch {}
    this._running = false;
    this._url = null;
  }

  /**
   * 恢复浏览器：先尝试热恢复（view 还活着），失败则冷恢复（launch + navigate）
   * @param {string} sessionPath - 目标 session 路径
   */
  async resumeForSession(sessionPath: SessionPath): Promise<void> {
    if (!sessionPath) return;

    // 没有浏览器运行时，先检查冷状态；无冷状态则跳过（避免无意义的 WS 命令超时）
    if (!this._running) {
      const coldState = this._loadColdState();
      if (!coldState[sessionPath]) return;
    }

    // 1. 热恢复：view 还在内存中
    const result = await this._sendCmd("resume", { sessionPath });
    if (result.found) {
      this._running = true;
      this._url = result.url || null;
      console.log("[browser] 热恢复成功");
      return;
    }

    // 2. 冷恢复：从磁盘读 URL，重新 launch + navigate
    const coldState = this._loadColdState();
    const savedUrl = coldState[sessionPath];
    if (!savedUrl) return; // 该 session 没有浏览器状态，跳过

    console.log("[browser] 冷恢复");
    await this._sendCmd("launch", { sessionPath });
    this._running = true;
    try {
      const nav = await this._sendCmd("navigate", { url: savedUrl });
      this._url = nav.url;
    } catch {
      this._url = savedUrl;
    }
  }

  /**
   * 关闭指定 session 的浏览器（从卡片上的关闭按钮调用）
   * @param {string} sessionPath - 目标 session 路径
   */
  async closeBrowserForSession(sessionPath: SessionPath): Promise<void> {
    const currentSession = this._getCurrentSession();
    // 如果是当前活跃的浏览器
    if (this._running && currentSession === sessionPath) {
      await this.close();
      return;
    }
    // 销毁挂起的 view
    try { await this._sendCmd("destroyView", { sessionPath }); } catch {}
    // 从冷保存中移除
    this._removeColdUrl(sessionPath);
    console.log("[browser] 已关闭 session 浏览器");
  }

  // ════════════════════════════
  //  导航
  // ════════════════════════════

  /**
   * @param {string} url
   * @returns {Promise<{ url: string, title: string, snapshot: string }>}
   */
  async navigate(url: string): Promise<BrowserNavigateResult> {
    const result = await this._sendCmd("navigate", { url });
    this._url = result.url;
    // 更新冷保存
    const session = this._getCurrentSession();
    this._saveColdUrl(session, this._url);
    return result; // { url, title, snapshot }
  }

  // ════════════════════════════
  //  感知
  // ════════════════════════════

  /** @returns {Promise<string>} 文本格式的页面树 */
  async snapshot(): Promise<string> {
    const result = await this._sendCmd("snapshot");
    this._url = result.currentUrl;
    return result.text;
  }

  /** @returns {Promise<{ base64: string, mimeType: string }>} */
  async screenshot(): Promise<{ base64: string; mimeType: string }> {
    const result = await this._sendCmd("screenshot");
    return { base64: result.base64, mimeType: "image/jpeg" };
  }

  /** @returns {Promise<string|null>} 缩略图 base64 */
  async thumbnail(): Promise<string | null> {
    try {
      const result = await this._sendCmd("thumbnail");
      return result.base64;
    } catch {
      return null;
    }
  }

  // ════════════════════════════
  //  交互（每个操作后自动 snapshot）
  // ════════════════════════════

  /** @returns {Promise<string>} 新的 snapshot */
  async click(ref: BrowserRef): Promise<string> {
    const result = await this._sendCmd("click", { ref });
    this._url = result.currentUrl;
    return result.text;
  }

  /** @returns {Promise<string>} 新的 snapshot */
  async type(text: string, ref?: BrowserRef, { pressEnter = false }: BrowserTypeOptions = {}): Promise<string> {
    const result = await this._sendCmd("type", { text, ref, pressEnter });
    this._url = result.currentUrl;
    return result.text;
  }

  /** @returns {Promise<string>} 新的 snapshot */
  async scroll(direction: string, amount = 3): Promise<string> {
    const result = await this._sendCmd("scroll", { direction, amount });
    return result.text;
  }

  /** @returns {Promise<string>} 新的 snapshot */
  async select(ref: BrowserRef, value: string): Promise<string> {
    const result = await this._sendCmd("select", { ref, value });
    return result.text;
  }

  /** @returns {Promise<string>} 新的 snapshot */
  async pressKey(key: string): Promise<string> {
    const result = await this._sendCmd("pressKey", { key });
    return result.text;
  }

  // ════════════════════════════
  //  辅助
  // ════════════════════════════

  /** @returns {Promise<string>} 新的 snapshot */
  async wait(opts: BrowserWaitOptions = {}): Promise<string> {
    const result = await this._sendCmd("wait", opts);
    return result.text;
  }

  /** @returns {Promise<string>} 序列化的执行结果 */
  async evaluate(expression: string): Promise<string> {
    const result = await this._sendCmd("evaluate", { expression });
    return result.value;
  }

  /** 将浏览器 viewer 窗口置前 */
  async show(): Promise<void> {
    await this._sendCmd("show");
  }
}
