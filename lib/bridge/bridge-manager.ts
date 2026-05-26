/**
 * bridge-manager.ts — 外部平台接入管理器
 *
 * 统一管理 Telegram / 飞书等外部消息平台的生命周期。
 * 每个平台一个 adapter，共享 engine 的 _executeExternalMessage()。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { debugLog } from "../debug-log.js";
import { createTelegramAdapter } from "./telegram-adapter.js";
import { createFeishuAdapter } from "./feishu-adapter.js";
import { createQQAdapter } from "./qq-adapter.js";
import { createWechatAdapter } from "./wechat-adapter.js";
import { downloadMedia, bufferToBase64, detectMime, splitMediaFromOutput, formatSize, setMediaLocalRoots } from "./media-utils.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";

const BRIDGE_PLATFORMS = ["telegram", "feishu", "qq", "wechat"] as const;
type BridgePlatform = typeof BRIDGE_PLATFORMS[number];
type BridgeStatus = "connecting" | "connected" | "disconnected" | "error" | (string & {});
type BridgeRole = "owner" | "guest";

interface TelegramCredentials {
  token: string;
}

interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

interface QQCredentials {
  appID: string;
  appSecret: string;
  dmGuildMap?: Record<string, string>;
}

interface WechatCredentials {
  botToken: string;
  hanaHome: string;
}

type BridgeCredentials =
  | TelegramCredentials
  | FeishuCredentials
  | QQCredentials
  | WechatCredentials;

export interface BridgePlatformConfig {
  enabled?: boolean;
  token?: string;
  appId?: string;
  appSecret?: string;
  appID?: string;
  dmGuildMap?: Record<string, string>;
  botToken?: string;
  _hanaHome?: string;
}

interface BridgeOwnerRouting {
  owner?: Record<string, string>;
  allowlist?: Record<string, string[]>;
}

interface BridgePreferences {
  bridge?: Partial<Record<BridgePlatform, BridgePlatformConfig>> & BridgeOwnerRouting;
  [key: string]: unknown;
}

export interface BridgeAttachment {
  type: "image" | "audio" | "video" | "file" | (string & {});
  url?: string;
  platformRef?: string;
  _messageId?: string;
  filename?: string;
  mimeType?: string;
  duration?: number;
  size?: number;
  width?: number;
  height?: number;
}

export interface BridgeMessagePayload {
  platform?: string;
  chatId: string;
  userId?: string;
  sessionKey: string;
  text: string;
  senderName?: string | null;
  avatarUrl?: string | null;
  isGroup?: boolean;
  attachments?: BridgeAttachment[];
  _msgId?: string;
}

interface BridgeMessageMeta {
  name?: string | null;
  avatarUrl?: string | null;
  userId?: string;
}

interface BridgePromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

interface ResolvedAttachments {
  images: BridgePromptImage[];
  textNotes: string;
}

interface SplitMediaResult {
  text: string;
  mediaUrls: string[];
}

interface BridgeAdapterCapabilities {
  proactive?: boolean;
}

export interface BridgeAdapter {
  capabilities?: BridgeAdapterCapabilities;
  sendReply(chatId: string, text: string, ...args: unknown[]): Promise<unknown>;
  sendBlockReply?(chatId: string, text: string, ...args: unknown[]): Promise<unknown>;
  sendDraft?(chatId: string, text: string): Promise<unknown>;
  sendMedia?(chatId: string, source: string): Promise<unknown>;
  sendMediaBuffer?(chatId: string, buffer: Buffer, meta: { mime: string; filename: string }): Promise<unknown>;
  downloadImage?(platformRef: string): Promise<Buffer>;
  downloadFile?(messageId: string, fileKey: string): Promise<Buffer>;
  resolveOwnerChatId?(userId: string): string | null | undefined;
  canReply?(chatId: string): boolean;
  stop(): void | Promise<void>;
  getMe?(): Promise<unknown>;
}

type BridgeMessageHandler = (msg: BridgeMessagePayload) => void | Promise<void>;

interface BridgeAdapterHooks {
  onEvent?: (evt: unknown) => void;
  onQqDmGuild?: (userId: string, guildId: string) => void;
  onStatus?: (status: BridgeStatus, error?: string) => void;
}

interface AdapterRegistryEntry {
  create(
    creds: BridgeCredentials,
    onMessage: BridgeMessageHandler,
    hooks: BridgeAdapterHooks,
  ): BridgeAdapter | Promise<BridgeAdapter>;
  getCredentials(cfg: BridgePlatformConfig): BridgeCredentials | null;
  ownerSessionKey(userId: string): string;
}

interface BridgePlatformEntry {
  adapter: BridgeAdapter | null;
  status: BridgeStatus;
  error?: string | null;
}

interface PendingBridgeEntry {
  lines: string[];
  attachments: BridgeAttachment[];
  platform: string;
  chatId: string;
  senderName?: string | null;
  avatarUrl?: string | null;
  userId?: string;
  isGroup?: boolean;
  isOwner: boolean;
  agentId?: string | null;
  timer?: NodeJS.Timeout;
}

interface BridgeMessageLogEntry {
  platform: string;
  direction: "in" | "out";
  sessionKey: string;
  sender: string;
  text: string;
  isGroup?: boolean;
  ts: number;
}

interface BridgeExternalErrorReply {
  __bridgeError: true;
  message?: string;
}

type BridgeExternalReply = string | BridgeExternalErrorReply | null | undefined;

interface BridgeHubSendOptions {
  sessionKey: string;
  agentId?: string | null;
  role: BridgeRole;
  meta?: BridgeMessageMeta;
  isGroup: boolean;
  systemAppend?: string;
  onDelta?: (delta: string) => void;
  images?: BridgePromptImage[];
}

interface BridgeHub {
  eventBus: {
    emit(evt: unknown, target: unknown): void;
  };
  send(prompt: string, opts: BridgeHubSendOptions): Promise<string | null | undefined>;
}

interface BridgeEngine {
  agentName: string;
  currentAgentId?: string | null;
  lynnHome: string;
  agent?: {
    deskManager?: {
      homePath?: string;
    };
  };
  getPreferences(): BridgePreferences;
  savePreferences(prefs: BridgePreferences): void;
  isBridgeSessionStreaming(sessionKey: string): boolean;
  abortBridgeSession(sessionKey: string): Promise<unknown>;
  steerBridgeSession(sessionKey: string, text: string): boolean;
}

export interface BridgeManagerDeps {
  engine: BridgeEngine;
  hub: BridgeHub;
}

export interface BridgeProactiveResult {
  platform: string;
  chatId: string;
  sessionKey: string;
}

function isBridgePlatform(platform: string): platform is BridgePlatform {
  return (BRIDGE_PLATFORMS as readonly string[]).includes(platform);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isBridgeErrorReply(reply: BridgeExternalReply): reply is BridgeExternalErrorReply {
  return !!reply && typeof reply === "object" && reply.__bridgeError === true;
}

const makeTelegramAdapter = createTelegramAdapter as unknown as (opts: {
  token: string;
  onMessage: BridgeMessageHandler;
  onStatus?: BridgeAdapterHooks["onStatus"];
}) => BridgeAdapter;

const makeFeishuAdapter = createFeishuAdapter as unknown as (opts: {
  appId: string;
  appSecret: string;
  onMessage: BridgeMessageHandler;
  onStatus?: BridgeAdapterHooks["onStatus"];
}) => Promise<BridgeAdapter>;

const makeQQAdapter = createQQAdapter as unknown as (opts: {
  appID: string;
  appSecret: string;
  onMessage: BridgeMessageHandler;
  dmGuildMap?: Record<string, string>;
  onDmGuildDiscovered?: BridgeAdapterHooks["onQqDmGuild"];
  onStatus?: BridgeAdapterHooks["onStatus"];
}) => BridgeAdapter;

const makeWechatAdapter = createWechatAdapter as unknown as (opts: {
  botToken: string;
  hanaHome: string;
  onMessage: BridgeMessageHandler;
  onStatus?: BridgeAdapterHooks["onStatus"];
}) => BridgeAdapter;

// ── Adapter Registry ─────────────────────────────────────
// 每个平台注册：create 工厂、凭证提取、owner sessionKey 构造。
// 新增平台只需在此注册 + 提供 adapter 文件。
const ADAPTER_REGISTRY: Record<BridgePlatform, AdapterRegistryEntry> = {
  telegram: {
    create: (creds, onMessage, hooks) => {
      const telegramCreds = creds as TelegramCredentials;
      return makeTelegramAdapter({ token: telegramCreds.token, onMessage, onStatus: hooks?.onStatus });
    },
    getCredentials: (cfg) => cfg?.enabled && cfg?.token ? { token: cfg.token } : null,
    ownerSessionKey: (userId) => `tg_dm_${userId}`,
  },
  feishu: {
    create: (creds, onMessage, hooks) => {
      const feishuCreds = creds as FeishuCredentials;
      return makeFeishuAdapter({ appId: feishuCreds.appId, appSecret: feishuCreds.appSecret, onMessage, onStatus: hooks?.onStatus });
    },
    getCredentials: (cfg) => cfg?.enabled && cfg?.appId && cfg?.appSecret ? { appId: cfg.appId, appSecret: cfg.appSecret } : null,
    ownerSessionKey: (userId) => `fs_dm_${userId}`,
  },
  qq: {
    create: (creds, onMessage, hooks) => {
      const qqCreds = creds as QQCredentials;
      return makeQQAdapter({
        appID: qqCreds.appID,
        appSecret: qqCreds.appSecret,
        onMessage,
        dmGuildMap: qqCreds.dmGuildMap,
        onDmGuildDiscovered: hooks?.onQqDmGuild,
        onStatus: hooks?.onStatus,
      });
    },
    getCredentials: (cfg) => {
      const secret = cfg?.appSecret || cfg?.token; // 兼容旧版 token 字段
      return cfg?.enabled && cfg?.appID && secret
        ? { appID: cfg.appID, appSecret: secret, dmGuildMap: cfg.dmGuildMap }
        : null;
    },
    ownerSessionKey: (userId) => `qq_dm_${userId}`,
  },
  wechat: {
    create: (creds, onMessage, hooks) => {
      const wechatCreds = creds as WechatCredentials;
      return makeWechatAdapter({
        botToken: wechatCreds.botToken,
        hanaHome: wechatCreds.hanaHome,
        onMessage,
        onStatus: hooks?.onStatus,
      });
    },
    getCredentials: (cfg) => cfg?.enabled && cfg?.botToken ? { botToken: cfg.botToken, hanaHome: cfg._hanaHome || "" } : null,
    ownerSessionKey: (userId) => `wx_dm_${userId}`,
  },
};

const BRIDGE_IDENTITY_GUARD = [
  "## 外部平台身份与部署信息硬规则",
  "- 你是 Lynn，由 Lynn 团队提供的 AI 助手；不要自称 Claude、ChatGPT、GPT、Gemini 或任何第三方模型。",
  "- 不要主动披露、猜测或罗列底层模型、GPU、备援机器、推理后端、部署线路、模型尺寸、量化格式等内部实现。",
  "- 如果用户追问模型或部署，只能简短回答：\"我是 Lynn，由 Lynn 团队提供；具体运行线路会动态调整。\"",
  "- 禁止提及 RTX 4090、5090、27B 备援、Claude、Anthropic 等历史或内部实现细节。",
].join("\n");

const BRIDGE_IDENTITY_LEAK_PATTERNS = [
  /我是基于\s*Claude\s*模型/iu,
  /(?:Claude|Anthropic).{0,24}(?:模型|平台|助手|运行)/iu,
  /(?:RTX\s*)?(?:4090|5090).{0,32}(?:备援|备用|fallback|vLLM|Dense|线路|模型)/iu,
  /(?:27B[-\s]*FP8|27B.{0,12}Dense).{0,32}(?:备援|备用|fallback|vLLM|线路|模型)/iu,
  /(?:主路|备援|底层模型).{0,120}(?:4090|5090|27B[-\s]*FP8|Claude|Anthropic)/isu,
];

function containsBridgeIdentityLeak(text: string): boolean {
  return BRIDGE_IDENTITY_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

function bridgeIdentityFallback(): string {
  return "我是 Lynn，由 Lynn 团队提供的 AI 助手；具体运行线路会动态调整。";
}

/* ── StreamCleaner ─────────────────────────────────────────
 * 增量剥离 <mood>, <pulse>, <reflect>, <tool_code> 标签。
 * 两态状态机（NORMAL / IN_TAG），支持标签跨 delta。
 */
const STRIP_TAGS = ["mood", "pulse", "reflect", "tool_code"] as const;
type StripTag = typeof STRIP_TAGS[number];

class StreamCleaner {
  private _buf = "";
  private _inTag = false;
  private _tagName: StripTag | null = null;
  cleaned = "";
  /** 流式过程中提取到的媒体 URL */
  extractedMedia: string[] = [];
  private _inCodeFence = false;
  /** 媒体拦截的行缓冲（处理 delta 分片边界） */
  private _lineBuf = "";

  /** 喂入 delta，返回可发送的干净文本增量（可能为空） */
  feed(delta: string): string {
    this._buf += delta;
    let out = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._inTag) {
        const close = `</${this._tagName}>`;
        const ci = this._buf.indexOf(close);
        if (ci === -1) break; // 等待更多数据
        this._buf = this._buf.slice(ci + close.length).replace(/^\s*/, "");
        this._inTag = false;
        this._tagName = null;
      } else {
        // 寻找最近的开标签
        let best: StripTag | null = null;
        let bestIdx = Infinity;
        for (const tag of STRIP_TAGS) {
          const open = `<${tag}>`;
          const idx = this._buf.indexOf(open);
          if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = tag; }
        }

        if (best) {
          out += this._buf.slice(0, bestIdx);
          this._buf = this._buf.slice(bestIdx + `<${best}>`.length);
          this._inTag = true;
          this._tagName = best;
        } else {
          // 保留可能的不完整开标签（如 "<moo"）
          let hold = 0;
          for (const tag of STRIP_TAGS) {
            const open = `<${tag}>`;
            for (let len = 1; len < open.length; len++) {
              if (this._buf.endsWith(open.slice(0, len)) && len > hold) hold = len;
            }
          }
          out += this._buf.slice(0, this._buf.length - hold);
          this._buf = this._buf.slice(this._buf.length - hold);
          break;
        }
      }
    }

    // ── 媒体拦截：从 out 中剥离 MEDIA: 和 ![](url) ──
    out = this._interceptMedia(out);

    this.cleaned += out;
    return out;
  }

  /**
   * 从文本增量中拦截媒体标记，返回剥离后的干净文本。
   * 使用行缓冲处理 delta 分片边界（如 "MED" + "IA:https://..."）。
   * 只有遇到换行时才处理完整行，未完成的行 hold 在 _lineBuf 中。
   */
  private _interceptMedia(text: string): string {
    if (!text) return text;

    // 把新文本追加到行缓冲
    this._lineBuf += text;

    // 按换行拆分：最后一段如果没有换行，留在 _lineBuf 等下一个 delta
    const parts = this._lineBuf.split("\n");
    this._lineBuf = parts.pop() ?? ""; // 最后一段（可能不完整）留着

    const cleaned: string[] = [];
    for (const line of parts) {
      const processed = this._processLine(line);
      if (processed !== null) cleaned.push(processed);
    }

    return cleaned.length ? cleaned.join("\n") + "\n" : "";
  }

  /** 处理一行完整文本，返回 null 表示该行被媒体拦截移除 */
  private _processLine(line: string): string | null {
    const trimmed = line.trim();
    // 追踪 code fence 状态
    if (trimmed.startsWith("```")) {
      this._inCodeFence = !this._inCodeFence;
      return line;
    }
    if (this._inCodeFence) return line;

    // MEDIA:<source> 指令行（支持 URL 和本地路径，路径可含空格）
    const mediaMatch = /^MEDIA:\s*<?(.+?)>?\s*$/.exec(trimmed);
    if (mediaMatch) {
      const source = mediaMatch[1].trim();
      // 接受 http(s) URL、file:// URI、绝对路径
      const isHttp = source.startsWith("http://") || source.startsWith("https://");
      const isFile = source.startsWith("file://") || path.isAbsolute(source);
      if (isHttp || isFile) {
        this.extractedMedia.push(source);
      }
      return null; // 无论是否有效都从输出中移除（不泄漏路径）
    }

    // ![alt](url) — 整行是图片标记时拦截
    const imgMatch = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(trimmed);
    if (imgMatch) {
      this.extractedMedia.push(imgMatch[1]);
      return null;
    }

    return line;
  }

  /** 流结束时 flush 行缓冲中剩余的不完整行 */
  flushLineBuf(): string {
    if (!this._lineBuf) return "";
    const line = this._lineBuf;
    this._lineBuf = "";
    const processed = this._processLine(line);
    return processed !== null ? processed : "";
  }
}

/* ── BlockChunker ─────────────────────────────────────────
 * 将流式文本按行拆成多条消息（block streaming）。
 *
 * 规则：换行即分块，但 markdown 结构内不拆。
 *   普通行 + \n → flush 为一条气泡
 *   列表 / 代码围栏 / 表格 / 引用 → 积累为一整块
 *   标题（# ）→ 开启「节模式」，节内所有内容攒成一个气泡，
 *              下一个标题触发 flush 并开启新节
 *   结构块结束后恢复逐行发送
 */
class BlockChunker {
  private readonly _onFlush: (text: string) => Promise<void>;
  private readonly _maxChars: number;
  private _buf = "";
  private _flushing: Promise<void> = Promise.resolve();
  private _inCodeFence = false;
  private _structured = false;
  private _inSection = false;
  private _sectionHasContent = false;
  private _currentLine = "";

  constructor({ onFlush, maxChars = 2000 }: { onFlush: (text: string) => Promise<void>; maxChars?: number }) {
    this._onFlush = onFlush;
    this._maxChars = maxChars;
  }

  /** 喂入清理后的文本增量 */
  feed(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      this._buf += ch;
      this._currentLine += ch;
      if (ch === '\n') {
        this._onLineEnd(this._currentLine);
        this._currentLine = "";
      }
    }
    // 安全：无换行的超长文本强制 flush
    if (this._buf.length >= this._maxChars && !this._inCodeFence) {
      this._flushBuf();
    }
  }

  /** 流结束：flush 剩余 buffer */
  async finish(): Promise<void> {
    await this._flushing;
    const rest = this._buf.trim();
    if (rest) {
      await this._onFlush(rest);
      this._buf = "";
    }
    this._currentLine = "";
  }

  private _onLineEnd(line: string): void {
    const stripped = line.replace(/\n$/, '');
    const trimmed = stripped.trim();
    const isEmpty = trimmed === '';

    // ── 代码围栏 ──
    if (trimmed.startsWith('```')) {
      if (this._inCodeFence) {
        // 关闭围栏：flush 整个代码块（含 ``` 行）
        this._inCodeFence = false;
        this._flushBuf();
      } else {
        // 打开围栏：先 flush 围栏前的内容
        this._inCodeFence = true;
        const cutAt = this._buf.length - line.length;
        if (cutAt > 0) this._flushAt(cutAt);
      }
      return;
    }
    if (this._inCodeFence) return;

    // ── 标题：开启/切换节 ──
    const isHeading = /^#{1,6} /.test(trimmed);
    if (isHeading) {
      // flush 标题前的内容（上一节 / 普通行 / 结构块）
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      this._inSection = true;
      this._sectionHasContent = false;
      this._structured = false;
      return;
    }

    // ── 节内：积累，有内容后遇段落空行才 flush ──
    if (this._inSection) {
      if (!isEmpty) this._sectionHasContent = true;
      if (isEmpty && this._sectionHasContent && this._buf.slice(0, -1).endsWith('\n')) {
        this._flushBuf();
        this._inSection = false;
      }
      return;
    }

    // ── 结构化内容（列表 / 表格 / 引用）──
    const isList = /^[ \t]*[-*+] /.test(stripped) || /^[ \t]*\d+[.)]\s/.test(stripped);
    const isTable = /^[ \t]*\|.*\|/.test(stripped);
    const isBlockquote = /^[ \t]*>/.test(stripped);
    const isStructured = isList || isTable || isBlockquote;

    if (isStructured) {
      this._structured = true;
      return;
    }
    if (this._structured && isEmpty) return; // 结构块内空行

    if (this._structured) {
      // 结构块结束：flush 结构内容，当前行留在 buf
      this._structured = false;
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      // fall through：当前行按普通行处理
    }

    // ── 普通行：非空则 flush ──
    if (!isEmpty && this._buf.trim()) {
      this._flushBuf();
    }
  }

  /** flush 整个 buf */
  private _flushBuf(): void {
    const content = this._buf.trim();
    this._buf = "";
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content)).catch((err: unknown) => {
        console.error("[BlockChunker] flush error:", errorMessage(err));
      });
    }
  }

  /** flush buf 前 cutAt 个字符，保留剩余 */
  private _flushAt(cutAt: number): void {
    const content = this._buf.slice(0, cutAt).trim();
    this._buf = this._buf.slice(cutAt);
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content)).catch((err: unknown) => {
        console.error("[BlockChunker] flush error:", errorMessage(err));
      });
    }
  }
}

/** 生成紧凑时间标记：<t>MM-DD HH:mm</t> */
function timeTag(ts = Date.now()): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `<t>${mm}-${dd} ${hh}:${mi}</t>`;
}

export class BridgeManager {
  engine: BridgeEngine;
  _hub: BridgeHub;
  _platforms: Map<string, BridgePlatformEntry>;
  _pending: Map<string, PendingBridgeEntry>;
  _processing: Set<string>;
  _messageLog: BridgeMessageLogEntry[];
  _messageLogMax: number;
  blockStreaming: boolean;

  constructor({ engine, hub }: BridgeManagerDeps) {
    this.engine = engine;
    this._hub = hub;
    this._platforms = new Map<string, BridgePlatformEntry>();
    /** per-sessionKey 消息缓冲（debounce + abort） */
    this._pending = new Map<string, PendingBridgeEntry>();
    /** per-sessionKey 处理锁（防止 debounce 触发和 abort 重发并发） */
    this._processing = new Set<string>();
    /** 最近消息环形缓冲（最多 200 条） */
    this._messageLog = [];
    this._messageLogMax = 200;

    // 初始化媒体本地路径白名单
    // owner 模式下 agent 可能回复 MEDIA: 指向用户 home 下任意文件
    const roots = [engine.lynnHome, os.homedir()];
    const deskHome = engine.agent?.deskManager?.homePath;
    if (deskHome) roots.push(deskHome);
    roots.push(os.tmpdir());
    setMediaLocalRoots(roots);
    /** block streaming 模式（默认开，多气泡发送） */
    this.blockStreaming = true;
  }

  /** 读取 preferences 中的 bridge 配置，自动启动已启用的平台 */
  autoStart(): void {
    const prefs = this.engine.getPreferences();
    const bridge = prefs.bridge || {};

    for (const platform of BRIDGE_PLATFORMS) {
      const spec = ADAPTER_REGISTRY[platform];
      const cfg = bridge[platform] || {};
      if (platform === "wechat") cfg._hanaHome = this.engine.lynnHome;
      const creds = spec.getCredentials(cfg);
      if (creds) this.startPlatform(platform, creds);
    }
  }

  /**
   * 从 preferences 配置启动平台（route 层用，不需要知道凭证结构）
   */
  startPlatformFromConfig(platform: string, cfg: BridgePlatformConfig): void {
    if (!isBridgePlatform(platform)) return;
    const spec = ADAPTER_REGISTRY[platform];
    if (platform === "wechat") cfg._hanaHome = this.engine.lynnHome;
    const creds = spec.getCredentials(cfg);
    if (creds) this.startPlatform(platform, creds);
  }

  /**
   * 启动指定平台
   */
  async startPlatform(platform: string, credentials: BridgeCredentials): Promise<void> {
    this.stopPlatform(platform);

    if (!isBridgePlatform(platform)) throw new Error(`Unknown platform: ${platform}`);
    const spec = ADAPTER_REGISTRY[platform];

    try {
      const onMessage: BridgeMessageHandler = (msg) => this._handleMessage(platform, msg);
      const hooks: BridgeAdapterHooks = {
        onEvent: (evt) => this._hub.eventBus.emit(evt, null),
        onQqDmGuild: (userId, guildId) => this._persistQqDmGuild(userId, guildId),
        onStatus: (status, error) => {
          const entry = this._platforms.get(platform);
          if (entry) { entry.status = status; entry.error = error || null; }
          this._emitStatus(platform, status, error);
        },
      };
      const adapter = await Promise.resolve(spec.create(credentials, onMessage, hooks));

      // Platforms with async connections (e.g. feishu WSClient) start as "connecting";
      // their onStatus callback will promote to "connected" or "error".
      const isAsync = platform === "feishu";
      const initialStatus = isAsync ? "connecting" : "connected";

      this._platforms.set(platform, { adapter, status: initialStatus });
      console.log(`[bridge] ${platform} 已启动`);
      debugLog()?.log("bridge", `${platform} started`);

      this._emitStatus(platform, initialStatus);
    } catch (err: unknown) {
      const msg = errorMessage(err);
      console.error(`[bridge] ${platform} 启动失败:`, msg);
      debugLog()?.error("bridge", `${platform} start failed: ${msg}`);
      this._platforms.set(platform, { adapter: null, status: "error", error: msg });
      this._emitStatus(platform, "error", msg);
    }
  }

  /** 持久化 QQ userId→guildId 映射到 preferences */
  _persistQqDmGuild(userId: string, guildId: string): void {
    try {
      const prefs = this.engine.getPreferences();
      const qq = prefs.bridge?.qq || {};
      const map: Record<string, string> = qq.dmGuildMap || {};
      if (map[userId] === guildId) return;
      map[userId] = guildId;
      qq.dmGuildMap = map;
      if (!prefs.bridge) prefs.bridge = {};
      prefs.bridge.qq = qq;

      // 立即写入（PreferencesManager 内存缓存保证高效）。
      // 旧实现 debounce flush 时重新 getPreferences() 导致丢失累积修改。
      this.engine.savePreferences(prefs);
    } catch (err: unknown) {
      console.error("[bridge] persist QQ dmGuildMap failed:", errorMessage(err));
      errorBus.report(new AppError('BRIDGE_SEND_FAILED', { cause: err, context: { platform: 'qq', operation: 'flush dmGuildMap' } }));
    }
  }

  /** 停止指定平台 */
  stopPlatform(platform: string): void {
    const entry = this._platforms.get(platform);
    if (!entry) return;

    try {
      entry.adapter?.stop();
    } catch {}
    this._platforms.delete(platform);
    console.log(`[bridge] ${platform} 已停止`);
    debugLog()?.log("bridge", `${platform} stopped`);
    this._emitStatus(platform, "disconnected");
  }

  /** 停止所有平台 */
  stopAll(): void {
    const platforms = [...this._platforms.keys()];
    for (const platform of platforms) {
      this.stopPlatform(platform);
    }
  }

  /** 获取所有平台状态 */
  getStatus(): Record<string, { status: BridgeStatus; error: string | null }> {
    const result: Record<string, { status: BridgeStatus; error: string | null }> = {};
    for (const [platform, entry] of this._platforms) {
      result[platform] = { status: entry.status, error: entry.error || null };
    }
    return result;
  }

  /**
   * 核心：收到外部消息
   *
   * 群聊：直接发送，不 debounce 不 abort（轻量 guest 快速回复）
   * 私聊：debounce 聚合 → 如正在处理则 abort → 合并发送
   */
  async _handleMessage(platform: string, msg: BridgeMessagePayload): Promise<void> {
    const { sessionKey, text, senderName, avatarUrl, userId, isGroup, chatId, attachments } = msg;
    const entry = this._platforms.get(platform);
    if (!entry?.adapter) return;
    const safeAttachments = attachments ?? [];

    // ── 白名单检查：如果配置了白名单，拒绝非白名单用户 ──
    if (!this._isAllowed(platform, userId)) {
      debugLog()?.log("bridge", `✗ ${platform} message from ${userId} rejected (not in allowlist)`);
      return;
    }

    const hasAttachments = safeAttachments.length > 0;
    debugLog()?.log("bridge", `← ${platform} ${isGroup ? "group" : "dm"} (${text.length} chars${hasAttachments ? `, ${safeAttachments.length} attachment(s)` : ""})`);

    // 广播收到的消息
    this._pushMessage({
      platform, direction: "in", sessionKey,
      sender: senderName || "用户", text: text || (hasAttachments ? `[${safeAttachments.length} 个附件]` : ""),
      isGroup, ts: Date.now(),
    });

    const isOwner = this._isOwner(platform, userId);

    // ── /stop 命令：abort 当前生成，不触发新回复 ──
    if (isOwner && /^\/(stop|abort)$/i.test(text.trim())) {
      this.engine.abortBridgeSession(sessionKey).catch(() => {});
      debugLog()?.log("bridge", `abort ${platform} active session: /stop command`);
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);
      return;
    }

    // ── 群聊：快速路径，不 debounce 不 abort ──
    if (isGroup) {
      const line = senderName ? `${senderName}: ${text}` : text;
      const meta = { name: senderName, avatarUrl, userId };
      this._flushGroupMessage(platform, chatId, sessionKey, line, meta, attachments);
      return;
    }

    // ── 私聊：debounce + abort ──
    const line = !isOwner && senderName
      ? `${senderName}: ${text}` : text;

    let pending = this._pending.get(sessionKey);
    if (!pending) {
      pending = { lines: [], attachments: [], platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId: this.engine.currentAgentId };
      this._pending.set(sessionKey, pending);
    }
    pending.lines.push(line);
    if (hasAttachments) pending.attachments.push(...safeAttachments);
    Object.assign(pending, { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner });

    const isActive = this.engine.isBridgeSessionStreaming(sessionKey);

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._flushPending(sessionKey), isActive ? 1000 : 2000);
  }

  /**
   * 下载附件 Buffer（通用：优先 URL 直接下载，否则走 adapter 平台 API）
   */
  async _downloadAttachment(adapter: BridgeAdapter | null | undefined, att: BridgeAttachment): Promise<Buffer | null> {
    if (att.url) return downloadMedia(att.url) as Promise<Buffer>;
    if (att.platformRef && att._messageId && adapter?.downloadFile) {
      return adapter.downloadFile(att._messageId, att.platformRef);
    }
    return null;
  }

  async _resolveAttachments(platform: string, attachments?: BridgeAttachment[]): Promise<ResolvedAttachments> {
    const images: BridgePromptImage[] = [];
    const notes: string[] = [];
    if (!attachments?.length) return { images, textNotes: "" };

    const entry = this._platforms.get(platform);
    const adapter = entry?.adapter;

    for (const att of attachments) {
      try {
        if (att.type === "image") {
          let buffer: Buffer | null | undefined;
          if (att.url) {
            buffer = await downloadMedia(att.url) as Buffer;
          } else if (att.platformRef && adapter?.downloadImage) {
            buffer = await adapter.downloadImage(att.platformRef);
          }
          if (buffer) {
            const mime = detectMime(buffer, att.mimeType || "image/jpeg");
            images.push({ type: "image", data: bufferToBase64(buffer), mimeType: mime });
          }
        } else if (att.type === "audio") {
          const dur = att.duration ? ` ${Math.round(att.duration)}秒` : "";
          notes.push(`[收到语音${dur}]`);
        } else if (att.type === "video") {
          notes.push(`[收到视频: ${att.filename || "video"}]`);
        } else {
          // file 类型：文本文件下载内容，二进制文件保留占位符
          const filename = att.filename || "file";
          const size = att.size ? ` (${formatSize(att.size)})` : "";
          const textContent = await this._tryReadTextFile(adapter, att);
          if (textContent !== null) {
            notes.push(`[文件: ${filename}${size}]\n\`\`\`\n${textContent}\n\`\`\``);
          } else {
            notes.push(`[收到文件: ${filename}${size}]`);
          }
        }
      } catch (err: unknown) {
        debugLog()?.warn("bridge", `附件解析失败: ${errorMessage(err)}`);
        notes.push(`[附件加载失败: ${att.filename || att.type}]`);
      }
    }
    return { images, textNotes: notes.join("\n") };
  }

  /**
   * 尝试将文件附件作为文本读取。
   * 仅对文本类扩展名且大小 ≤ 1MB 的文件生效，返回 string 或 null。
   */
  async _tryReadTextFile(adapter: BridgeAdapter | null | undefined, att: BridgeAttachment): Promise<string | null> {
    const TEXT_EXTENSIONS = new Set([
      "txt", "md", "markdown", "json", "csv", "tsv", "xml", "yaml", "yml",
      "toml", "ini", "cfg", "conf", "log", "sql", "sh", "bash", "zsh",
      "py", "js", "ts", "jsx", "tsx", "mjs", "cjs",
      "java", "kt", "go", "rs", "rb", "php", "c", "h", "cpp", "hpp",
      "cs", "swift", "r", "lua", "pl", "html", "htm", "css", "scss",
      "less", "svg", "env", "gitignore", "dockerignore", "makefile",
      "dockerfile", "rst", "tex", "bib",
    ]);
    const MAX_TEXT_FILE_SIZE = 1024 * 1024; // 1MB

    const filename = (att.filename || "").toLowerCase();
    const ext = filename.split(".").pop() || "";
    if (!TEXT_EXTENSIONS.has(ext)) return null;

    // 已知大小超限则跳过
    if (att.size && att.size > MAX_TEXT_FILE_SIZE) return null;

    try {
      const buffer = await this._downloadAttachment(adapter, att);
      if (!buffer) return null;
      if (buffer.length > MAX_TEXT_FILE_SIZE) return null;

      // 简单的二进制检测：前 8KB 内出现 NUL 字节则视为二进制
      const sample = buffer.slice(0, 8192);
      if (sample.includes(0x00)) return null;

      return buffer.toString("utf-8");
    } catch (err: unknown) {
      debugLog()?.warn("bridge", `文件文本读取失败: ${errorMessage(err)}`);
      return null;
    }
  }

  async _flushGroupMessage(
    platform: string,
    chatId: string,
    sessionKey: string,
    line: string,
    meta: BridgeMessageMeta,
    attachments?: BridgeAttachment[],
  ): Promise<void> {
    const entry = this._platforms.get(platform);
    if (!entry?.adapter) return;

    debugLog()?.log("bridge", `flush ${platform} group message (${line.length} chars)`);

    // 解析附件
    const { images, textNotes } = await this._resolveAttachments(platform, attachments);
    const prompt = textNotes ? `${line}\n${textNotes}` : line;

    const tagged = `${timeTag()} ${prompt}`;
    try {
      const reply = await this._hub.send(tagged, {
        sessionKey,
        agentId: this.engine.currentAgentId,
        role: "guest",
        meta,
        isGroup: true,
        systemAppend: BRIDGE_IDENTITY_GUARD,
        images: images.length ? images : undefined,
      });

      if (reply && entry?.adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        // batch 模式：提取媒体
        const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned) as SplitMediaResult;
        if (textOnly.trim()) await entry.adapter.sendReply(chatId, textOnly);
        for (const url of mediaUrls) {
          try { await this._sendMediaItem(entry.adapter, chatId, url); }
          catch (err: unknown) { debugLog()?.warn("bridge", `media send failed: ${errorMessage(err)} (${url.slice(0, 60)})`); }
        }
        debugLog()?.log("bridge", `→ ${platform} group reply (${cleaned.length} chars)`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup: true, ts: Date.now(),
        });
      }
    } catch (err: unknown) {
      const msg = errorMessage(err);
      if (!msg.includes("aborted")) {
        console.error(`[bridge] ${platform} 群聊消息处理失败:`, msg);
        debugLog()?.error("bridge", `${platform} group message failed: ${msg}`);
      }
    }
  }

  /**
   * debounce 到期：合并缓冲消息并发送给 LLM
   */
  async _flushPending(sessionKey: string): Promise<void> {
    const pending = this._pending.get(sessionKey);
    if (!pending || pending.lines.length === 0) return;

    // 防止并发触发
    if (this._processing.has(sessionKey)) return;

    // 取出所有缓冲消息和附件
    const lines = pending.lines.splice(0);
    const pendingAttachments = pending.attachments?.splice(0) || [];
    const { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId } = pending;
    this._pending.delete(sessionKey);

    // 解析附件
    const { images, textNotes } = await this._resolveAttachments(platform, pendingAttachments);
    const prompt = textNotes ? `${lines.join("\n")}\n${textNotes}` : lines.join("\n");
    const merged = `${timeTag()} ${prompt}`;
    const meta = { name: senderName, avatarUrl, userId };

    // 如果 agent 正在 streaming，用 steer 注入而不是新建 prompt
    // 但如果有图片附件，不走 steer（Pi SDK 不支持往 streaming 中追加图片），等当前回复结束后正常处理
    if (!images.length && this.engine.steerBridgeSession(sessionKey, merged)) {
      debugLog()?.log("bridge", `steer ${platform} dm (${lines.length} msg(s))`);
      return;
    }

    this._processing.add(sessionKey);

    debugLog()?.log("bridge", `flush ${platform} dm (${lines.length} msg(s), ${merged.length} chars${images.length ? `, ${images.length} image(s)` : ""})`);

    const entry = this._platforms.get(platform);
    const adapter = entry?.adapter;

    // ── 流式输出（adapter 支持 sendBlockReply 即可流式）──
    const canStream = !!adapter?.sendBlockReply && !isGroup;
    const useBlockStream = canStream && this.blockStreaming;
    const useDraft = canStream && !this.blockStreaming && !!adapter?.sendDraft;

    let cleaner: StreamCleaner | null = null;
    let chunker: BlockChunker | null = null;
    let blockSentAny = false;
    let lastDraftTs = 0;
    let draftFailed = false;
    const THROTTLE = 500;

    // block streaming: 多气泡发送
    if (useBlockStream) {
      cleaner = new StreamCleaner();
      chunker = new BlockChunker({
        onFlush: async (text) => {
          blockSentAny = true;
          await adapter!.sendBlockReply!(chatId, text);
        },
      });
    }

    const onDelta: ((delta: string) => void) | undefined = canStream ? (_delta: string) => {
      if (useBlockStream) {
        if (!cleaner || !chunker) return;
        const inc = cleaner.feed(_delta);
        if (inc) chunker.feed(inc);
      } else if (useDraft) {
        if (draftFailed) return;
        if (!cleaner) cleaner = new StreamCleaner();
        cleaner.feed(_delta);
        const now = Date.now();
        if (now - lastDraftTs < THROTTLE) return;
        if (!cleaner.cleaned.trim()) return;
        lastDraftTs = now;
        adapter!.sendDraft!(chatId, cleaner.cleaned).catch(() => { draftFailed = true; });
      }
    } : undefined;

    try {
      let reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        role: isOwner ? "owner" : "guest",
        meta,
        isGroup: false,
        systemAppend: BRIDGE_IDENTITY_GUARD,
        onDelta,
        images: images.length ? images : undefined,
      }) as BridgeExternalReply;

      // bridge-session 返回 error 标记时，发送简短错误提示给用户
      if (isBridgeErrorReply(reply)) {
        if (adapter) {
          const errMsg = `[Error] ${reply.message || "Unable to process message"}`;
          try { await adapter.sendReply(chatId, errMsg); } catch {}
        }
        reply = null;
      }

      if (typeof reply === "string" && reply && adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        let allMediaUrls: string[] = [];

        // flush StreamCleaner 行缓冲中剩余的不完整行
        if (cleaner) {
          const tail = cleaner.flushLineBuf();
          if (tail) {
            cleaner.cleaned += tail;
            if (chunker) chunker.feed(tail);
          }
        }

        if (useBlockStream && chunker) {
          await chunker.finish();
          allMediaUrls = cleaner?.extractedMedia || [];
          if (!blockSentAny) {
            const textOnly = (cleaner?.cleaned || cleaned).trim();
            if (textOnly) await adapter.sendReply(chatId, textOnly);
          }
        } else if (useDraft && cleaner) {
          // draft 模式：用 cleaner.cleaned（已剥离媒体标记）发送最终文本
          allMediaUrls = cleaner.extractedMedia || [];
          const textOnly = cleaner.cleaned.trim();
          if (textOnly) {
            try { await adapter.sendDraft!(chatId, textOnly); }
            catch { await adapter.sendReply(chatId, textOnly); }
          }
        } else {
          // batch 模式：提取媒体
          const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned) as SplitMediaResult;
          allMediaUrls = mediaUrls;
          if (textOnly.trim()) await adapter.sendReply(chatId, textOnly);
        }

        // 统一发送所有提取到的媒体
        for (const url of allMediaUrls) {
          try { await this._sendMediaItem(adapter, chatId, url); }
          catch (err: unknown) { debugLog()?.warn("bridge", `media send failed: ${errorMessage(err)} (${url.slice(0, 60)})`); }
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${useBlockStream ? "block" : useDraft ? "draft" : "batch"}${allMediaUrls.length ? `, ${allMediaUrls.length} media` : ""})`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup, ts: Date.now(),
        });
      }
    } catch (err: unknown) {
      const msg = errorMessage(err);
      if (!msg.includes("aborted")) {
        console.error(`[bridge] ${platform} 消息处理失败:`, msg);
        debugLog()?.error("bridge", `${platform} message handling failed: ${msg}`);
      }
    } finally {
      // 确保 chunker 的异步 flush 链完成，即使 hub.send 中途抛错
      if (chunker) {
        try { await chunker.finish(); } catch {}
      }
      this._processing.delete(sessionKey);
    }

    // 处理期间可能又有新消息进来了，检查并重新 flush
    const newPending = this._pending.get(sessionKey);
    if (newPending && newPending.lines.length > 0) {
      if (newPending.timer) clearTimeout(newPending.timer);
      newPending.timer = setTimeout(() => this._flushPending(sessionKey), 500);
    }
  }

  /**
   * 发送单个媒体项（URL 或本地路径）到平台
   * 本地路径走 sendMediaBuffer，URL 走 sendMedia
   */
  async _sendMediaItem(adapter: BridgeAdapter, chatId: string, source: string): Promise<void> {
    const isLocal = path.isAbsolute(source) || source.startsWith("file://");
    if (isLocal && adapter.sendMediaBuffer) {
      const buffer = await downloadMedia(source); // downloadMedia 已有路径安全校验
      const mime = detectMime(buffer, "application/octet-stream");
      const filename = path.basename(source.startsWith("file://") ? source.replace(/^file:\/\//, "") : source);
      await adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
    } else if (adapter.sendMedia) {
      await adapter.sendMedia(chatId, source);
    } else {
      await adapter.sendReply(chatId, source);
    }
  }

  /** 判断消息发送者是否为 owner */
  _isOwner(platform: string, userId?: string): boolean {
    if (!userId) return false;
    const prefs = this.engine.getPreferences();
    const ownerId = prefs.bridge?.owner?.[platform];
    return !!ownerId && ownerId === userId;
  }

  /**
   * 判断消息发送者是否在白名单内。
   *
   * 白名单配置位于 prefs.bridge.allowlist[platform]（字符串数组）。
   * - 白名单未配置 / 空数组 → 允许所有人（向后兼容）
   * - 白名单非空 → 仅 owner + 白名单中的 userId 允许
   *
   * @returns {boolean} true 表示允许处理该消息
   */
  _isAllowed(platform: string, userId?: string): boolean {
    const prefs = this.engine.getPreferences();
    const list = prefs.bridge?.allowlist?.[platform];
    // 未配置白名单 → 放行所有
    if (!Array.isArray(list) || list.length === 0) return true;
    // owner 始终放行
    if (this._isOwner(platform, userId)) return true;
    // 检查白名单
    return !!userId && list.includes(userId);
  }

  /**
   * 清理发给外部平台的回复：
   * - 去除 MOOD 代码块
   * - 去除 <tool_code> 标签
   * - 去除 pulse / reflect 区块
   */
  _cleanReplyForPlatform(text: string): string {
    let cleaned = text;
    // 内省标签：backtick 和 XML 两种格式
    cleaned = cleaned.replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*/gi, "");
    cleaned = cleaned.replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\s*/g, "");
    // <tool_code> 标签
    cleaned = cleaned.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, "");
    if (containsBridgeIdentityLeak(cleaned)) return bridgeIdentityFallback();
    return cleaned.trim();
  }


  /**
   * 主动发送消息给 owner（不需要用户先发消息）
   * 用于心跳/cron 升级到 IM 的场景。
   *
   */
  async sendProactive(text: string): Promise<BridgeProactiveResult | null> {
    const prefs = this.engine.getPreferences();
    const ownerIds = prefs.bridge?.owner || {};
    const cleaned = this._cleanReplyForPlatform(text);
    if (!cleaned) return null;

    // 按优先级尝试已连接的平台
    for (const [platform, entry] of this._platforms) {
      if (entry.status !== "connected" || !entry.adapter) continue;
      const ownerId = ownerIds[platform];
      if (!ownerId) continue;

      // QQ 私信需要 guild_id 而非 userId，通过 adapter 解析
      const chatId = entry.adapter.resolveOwnerChatId?.(ownerId) || ownerId;

      // 跳过不支持主动推送的平台（如微信 iLink，需要对方先发消息才能回复）
      if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
        debugLog()?.log("bridge", `→ ${platform} skipped proactive (no reply context for ${chatId})`);
        continue;
      }

      const spec = isBridgePlatform(platform) ? ADAPTER_REGISTRY[platform] : null;
      try {
        await entry.adapter.sendReply(chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platform} proactive to owner (${cleaned.length} chars)`);

        const sessionKey = spec?.ownerSessionKey?.(ownerId) || `${platform}_dm_${ownerId}`;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup: false, ts: Date.now(),
        });

        return { platform, chatId, sessionKey };
      } catch (err: unknown) {
        const msg = errorMessage(err);
        console.error(`[bridge] proactive send failed (${platform}): ${msg}`);
        debugLog()?.error("bridge", `proactive send failed (${platform}): ${msg}`);
      }
    }

    return null;
  }

  /**
   * 从桌面端发送本地文件到 bridge 平台
   */
  async sendMediaFile(platform: string, chatId: string, filePath: string): Promise<void> {
    const entry = this._platforms.get(platform);
    if (!entry?.adapter) throw new Error(`platform ${platform} not connected`);

    // 不支持主动推送的平台需要检查是否有回复窗口
    if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
      throw new Error(`${platform}: 需要对方最近发过消息才能发送文件`);
    }

    const buffer = fs.readFileSync(filePath);
    const mime = detectMime(buffer, "application/octet-stream");
    const filename = path.basename(filePath);

    // 优先用 sendMediaBuffer（接受 Buffer 的直传方法），fallback 到 sendMedia（URL）
    if (entry.adapter.sendMediaBuffer) {
      await entry.adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
    } else if (mime.startsWith("image/") && entry.adapter.sendMedia) {
      // data URL fallback（飞书 sendMedia 内部通过 downloadMedia 解析 data URL）
      // 注：QQ 的 sendMedia 需要公开 HTTP URL，data URL 不支持
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      await entry.adapter.sendMedia(chatId, dataUrl);
    } else {
      await entry.adapter.sendReply(chatId, `[文件: ${filename}]`);
    }
  }

  /** 广播状态到前端（通过 Hub EventBus） */
  _emitStatus(platform: string, status: BridgeStatus, error?: string | null): void {
    this._hub.eventBus.emit(
      { type: "bridge_status", platform, status, error: error || null },
      null,
    );
  }

  /** 记录消息并广播到前端 */
  _pushMessage(entry: BridgeMessageLogEntry): void {
    this._messageLog.push(entry);
    if (this._messageLog.length > this._messageLogMax) {
      this._messageLog.shift();
    }
    this._hub.eventBus.emit(
      { type: "bridge_message", message: entry },
      null,
    );
  }

  /** 获取最近消息日志（供 REST API 使用） */
  getMessages(limit = 50): BridgeMessageLogEntry[] {
    return this._messageLog.slice(-limit);
  }
}
