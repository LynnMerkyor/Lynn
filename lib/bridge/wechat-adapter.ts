/**
 * wechat-adapter.js — 微信 iLink Bridge Adapter
 *
 * 基于腾讯 iLink 协议（ilinkai.weixin.qq.com）实现。
 * 参考 @tencent-weixin/openclaw-weixin v1.0.2 源码（MIT 协议）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BridgeAdapter, BridgeAttachment, BridgeMessageHandler, BridgeStatusHandler, SendMediaBufferMeta } from "./adapter-types.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

const LONG_POLL_TIMEOUT_MS = 40_000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAYS = [2000, 5000, 30_000];
const CONTEXT_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const MSG_CHUNK_LIMIT = 4000;

// ── iLink 消息类型常量 ──

const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MessageType = { USER: 1, BOT: 2 };
const MessageState = { FINISH: 2 };
const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3 };

type WechatApiBody = Record<string, unknown>;

interface WechatApiResponse extends Record<string, unknown> {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  get_updates_buf?: string;
  msgs?: WechatInboundMessage[];
  upload_param?: string;
}

interface WechatMediaRef {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

interface WechatMessageItem {
  type?: number;
  text_item?: { text?: unknown };
  voice_item?: { text?: string };
  image_item?: {
    aeskey?: string;
    media?: WechatMediaRef;
    mid_size?: number;
  };
  file_item?: {
    file_name?: string;
    media?: WechatMediaRef;
  };
  video_item?: {
    media?: WechatMediaRef;
  };
  ref_msg?: {
    title?: string;
    message_item?: WechatMessageItem;
  };
}

interface WechatInboundMessage {
  from_user_id?: string;
  context_token?: string;
  item_list?: WechatMessageItem[];
}

interface WechatContextToken {
  token: string;
  ts: number;
}

interface UploadedMedia {
  filekey: string;
  downloadParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

interface WechatAdapterOptions {
  botToken: string;
  hanaHome?: string;
  onMessage: BridgeMessageHandler;
  onStatus?: BridgeStatusHandler;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// ── AES-128-ECB 加解密 ──

function encryptAesEcb(plaintext: Buffer, key: Buffer) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 解析 aes_key：base64 → 16 字节原始 key
 * 两种编码：base64(raw 16 bytes) 或 base64(hex string 32 chars)
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`invalid aes_key length: ${decoded.length}`);
}

// ── iLink HTTP API ──

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...(token ? { "Authorization": `Bearer ${token}` } : {}),
  };
}

/**
 * @param {AbortSignal} [parentSignal] - 外部 signal（adapter 级别），用于 stop() 中断所有请求
 */
async function apiPost(baseUrl: string, endpoint: string, body: WechatApiBody, token: string, timeoutMs?: number, parentSignal?: AbortSignal): Promise<WechatApiResponse> {
  const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15_000);

  // 如果有父 signal，联动 abort
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text}`);
    return JSON.parse(text) as WechatApiResponse;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// ── Cursor 持久化 ──

function hash8(str: string): string {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 8);
}

function resolveSyncBufPath(hanaHome: string, botToken: string): string {
  const dir = path.join(hanaHome, "bridge", "wechat");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `sync-${hash8(botToken)}.json`);
}

function loadSyncBuf(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return data.get_updates_buf || "";
    }
  } catch { /* ignore */ }
  return "";
}

function saveSyncBuf(filePath: string, buf: string): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: buf }), "utf-8");
  } catch { /* ignore */ }
}

// ── CDN URL ──

function buildCdnDownloadUrl(encryptedQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

// ── 消息文本提取 ──

function extractText(itemList?: WechatMessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody: string = extractText([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function isMediaItem(item: WechatMessageItem): boolean {
  const mediaTypes: readonly number[] = [MessageItemType.IMAGE, MessageItemType.VIDEO, MessageItemType.FILE, MessageItemType.VOICE];
  return typeof item.type === "number"
    && mediaTypes.includes(item.type);
}

// ── Adapter 主函数 ──

/**
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string} [opts.hanaHome] - hanaHome 路径，用于 cursor 持久化
 * @param {(msg: object) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 */
export function createWechatAdapter({ botToken, hanaHome, onMessage, onStatus }: WechatAdapterOptions): BridgeAdapter {
  const baseUrl = DEFAULT_BASE_URL;
  let generation = 0;
  let abortController = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const contextCache = new Map<string, WechatContextToken>(); // chatId → { token, ts }

  const syncBufPath = hanaHome ? resolveSyncBufPath(hanaHome, botToken) : null;
  let getUpdatesBuf = syncBufPath ? loadSyncBuf(syncBufPath) : "";

  /** apiPost 带上当前 abortController.signal，stop() 时自动中断所有请求 */
  function api(endpoint: string, body: WechatApiBody, timeoutMs?: number): Promise<WechatApiResponse> {
    return apiPost(baseUrl, endpoint, body, botToken, timeoutMs, abortController.signal);
  }

  // ── 定时器管理 ──

  function addTimer(fn: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => { timers.delete(id); fn(); }, delay);
    timers.add(id);
    return id;
  }

  function guardedSleep(ms: number, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const id = setTimeout(() => { timers.delete(id); resolve(myGen === generation); }, ms);
      timers.add(id);
    });
  }

  // ── context_token 管理 ──

  function setContextToken(chatId: string, token: string): void {
    contextCache.set(chatId, { token, ts: Date.now() });
  }

  function getContextToken(chatId: string): string | null {
    const entry = contextCache.get(chatId);
    if (!entry) return null;
    if (Date.now() - entry.ts > CONTEXT_TOKEN_TTL_MS) {
      contextCache.delete(chatId);
      return null;
    }
    return entry.token;
  }

  // ── 发送消息 ──

  async function sendText(chatId: string, text: string, contextToken: string | null): Promise<void> {
    if (!contextToken) throw new Error("微信: 需要对方最近发过消息才能回复");
    await api("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: chatId,
        client_id: crypto.randomUUID(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : undefined,
        context_token: contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    });
  }

  // ── CDN 媒体上传 ──

  async function uploadMedia(buffer: Buffer, toUserId: string, mediaType: number): Promise<UploadedMedia> {
    const rawsize = buffer.length;
    const rawfilemd5 = crypto.createHash("md5").update(buffer).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString("hex");
    const aeskey = crypto.randomBytes(16);

    const uploadResp = await api("ilink/bot/getuploadurl", {
      filekey, media_type: mediaType, to_user_id: toUserId,
      rawsize, rawfilemd5, filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: { channel_version: "1.0.0" },
    });

    if (!uploadResp.upload_param) throw new Error("getUploadUrl 未返回 upload_param");

    const ciphertext = encryptAesEcb(buffer, aeskey);
    const uploadParam = typeof uploadResp.upload_param === "string" ? uploadResp.upload_param : "";
    const cdnUrl = buildCdnUploadUrl(uploadParam, filekey);
    const cdnRes = await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
    });
    if (!cdnRes.ok) throw new Error(`CDN upload failed: ${cdnRes.status}`);
    const downloadParam = cdnRes.headers.get("x-encrypted-param");
    if (!downloadParam) throw new Error("CDN 未返回 x-encrypted-param");

    return { filekey, downloadParam, aeskey: aeskey.toString("hex"), fileSize: rawsize, fileSizeCiphertext: filesize };
  }

  async function sendImageMessage(chatId: string, uploaded: UploadedMedia, contextToken: string, caption: string): Promise<void> {
    const items: WechatMessageItem[] = [];
    if (caption) items.push({ type: MessageItemType.TEXT, text_item: { text: caption } });
    items.push({
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadParam,
          aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
          encrypt_type: 1,
        },
        mid_size: uploaded.fileSizeCiphertext,
      },
    });
    for (const item of items) {
      await api("ilink/bot/sendmessage", {
        msg: {
          from_user_id: "", to_user_id: chatId,
          client_id: crypto.randomUUID(),
          message_type: MessageType.BOT, message_state: MessageState.FINISH,
          item_list: [item], context_token: contextToken,
        },
        base_info: { channel_version: "1.0.0" },
      });
    }
  }

  async function sendFileMessage(chatId: string, uploaded: UploadedMedia, contextToken: string, filename: string): Promise<void> {
    await api("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "", to_user_id: chatId,
        client_id: crypto.randomUUID(),
        message_type: MessageType.BOT, message_state: MessageState.FINISH,
        item_list: [{
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
              encrypt_type: 1,
            },
            file_name: filename,
            len: String(uploaded.fileSize),
          },
        }],
        context_token: contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    });
  }

  // ── 入站消息处理 ──

  function handleInbound(msg: WechatInboundMessage): void {
    const fromUserId = msg.from_user_id || "";
    if (!fromUserId || fromUserId.endsWith("@im.bot")) return;

    if (msg.context_token) {
      setContextToken(fromUserId, msg.context_token);
    }

    const text = extractText(msg.item_list);
    const attachments: BridgeAttachment[] = [];

    for (const item of msg.item_list || []) {
      if (item.type === MessageItemType.IMAGE && item.image_item?.media?.encrypt_query_param) {
        const aesKey = item.image_item.aeskey
          ? Buffer.from(item.image_item.aeskey, "hex").toString("base64")
          : item.image_item.media.aes_key;
        attachments.push({
          type: "image",
          platformRef: JSON.stringify({
            encrypt_query_param: item.image_item.media.encrypt_query_param,
            aes_key: aesKey,
          }),
          mimeType: "image/jpeg",
        });
      } else if (item.type === MessageItemType.FILE && item.file_item?.media?.encrypt_query_param) {
        attachments.push({
          type: "file",
          platformRef: JSON.stringify({
            encrypt_query_param: item.file_item.media.encrypt_query_param,
            aes_key: item.file_item.media.aes_key,
          }),
          filename: item.file_item.file_name,
          mimeType: "application/octet-stream",
        });
      } else if (item.type === MessageItemType.VIDEO && item.video_item?.media?.encrypt_query_param) {
        attachments.push({
          type: "video",
          platformRef: JSON.stringify({
            encrypt_query_param: item.video_item.media.encrypt_query_param,
            aes_key: item.video_item.media.aes_key,
          }),
          mimeType: "video/mp4",
        });
      }
      // 语音有转文字，已通过 extractText 处理，不单独附件
    }

    // 引用消息里的媒体
    if (!attachments.length) {
      for (const item of msg.item_list || []) {
        if (item.type === MessageItemType.TEXT && item.ref_msg?.message_item) {
          const ref = item.ref_msg.message_item;
          if (ref.type === MessageItemType.IMAGE && ref.image_item?.media?.encrypt_query_param) {
            const aesKey = ref.image_item.aeskey
              ? Buffer.from(ref.image_item.aeskey, "hex").toString("base64")
              : ref.image_item.media.aes_key;
            attachments.push({
              type: "image",
              platformRef: JSON.stringify({
                encrypt_query_param: ref.image_item.media.encrypt_query_param,
                aes_key: aesKey,
              }),
              mimeType: "image/jpeg",
            });
          }
        }
      }
    }

    if (!text && !attachments.length) return;

    onMessage({
      platform: "wechat",
      chatId: fromUserId,
      userId: fromUserId,
      sessionKey: `wx_dm_${fromUserId}`,
      text,
      senderName: fromUserId.split("@")[0] || "微信用户",
      isGroup: false,
      attachments: attachments.length ? attachments : undefined,
    });
  }

  // ── 长轮询主循环 ──

  async function pollLoop(): Promise<void> {
    const myGen = generation;
    let consecutiveFailures = 0;

    onStatus?.("connected");

    while (myGen === generation) {
      try {
        const resp = await api("ilink/bot/getupdates", {
          get_updates_buf: getUpdatesBuf,
          base_info: { channel_version: "1.0.0" },
        }, LONG_POLL_TIMEOUT_MS);

        // session 过期
        const isError = (resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0);
        if (isError) {
          const isExpired = resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;
          if (isExpired) {
            onStatus?.("error", "session expired, pausing 1h");
            const alive = await guardedSleep(SESSION_PAUSE_MS, myGen);
            if (!alive) return;
            onStatus?.("connected");
            continue;
          }
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            const alive = await guardedSleep(BACKOFF_DELAYS[2], myGen);
            if (!alive) return;
          } else {
            const alive = await guardedSleep(BACKOFF_DELAYS[0], myGen);
            if (!alive) return;
          }
          continue;
        }

        consecutiveFailures = 0;

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
          if (syncBufPath) saveSyncBuf(syncBufPath, getUpdatesBuf);
        }

        for (const msg of resp.msgs || []) {
          try { handleInbound(msg); } catch (err) {
            console.error("[wechat] handleInbound error:", errorMessage(err));
          }
        }
      } catch (err) {
        if (myGen !== generation) return;
        if (isAbortError(err)) continue; // 长轮询超时，正常
        consecutiveFailures++;
        const delay = BACKOFF_DELAYS[Math.min(consecutiveFailures - 1, BACKOFF_DELAYS.length - 1)];
        const alive = await guardedSleep(delay, myGen);
        if (!alive) return;
      }
    }
  }

  // 启动轮询
  pollLoop().catch((err) => {
    const msg = errorMessage(err);
    console.error("[wechat] pollLoop crashed:", msg);
    onStatus?.("error", msg);
  });

  // ── 返回 adapter 对象 ──

  return {
    capabilities: { proactive: false },

    canReply(chatId: string): boolean {
      return !!getContextToken(chatId);
    },

    async sendReply(chatId: string, text: string): Promise<void> {
      const ctx = getContextToken(chatId);
      if (!ctx) throw new Error("微信: 需要对方最近发过消息才能回复");
      // 长文本分段
      for (let i = 0; i < text.length; i += MSG_CHUNK_LIMIT) {
        await sendText(chatId, text.slice(i, i + MSG_CHUNK_LIMIT), ctx);
      }
    },

    // 不提供 sendBlockReply：iLink API 对连续发消息有速率限制，
    // block streaming 模式下后续消息会被丢弃。走 batch 模式一次性发完更稳。

    async sendMedia(chatId: string, url: string): Promise<void> {
      const ctx = getContextToken(chatId);
      if (!ctx) throw new Error("微信: 需要对方最近发过消息才能回复");
      // 下载远程文件
      const res = await fetch(url);
      if (!res.ok) throw new Error(`下载媒体失败: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || "";
      const isImage = contentType.startsWith("image/") || /\.(jpe?g|png|gif|webp|bmp)$/i.test(url);
      const uploaded = await uploadMedia(buffer, chatId, isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE);
      if (isImage) {
        await sendImageMessage(chatId, uploaded, ctx, "");
      } else {
        const filename = path.basename(new URL(url).pathname) || "file";
        await sendFileMessage(chatId, uploaded, ctx, filename);
      }
    },

    async sendMediaBuffer(chatId: string, buffer: Buffer, { mime, filename }: SendMediaBufferMeta): Promise<void> {
      const ctx = getContextToken(chatId);
      if (!ctx) throw new Error("微信: 需要对方最近发过消息才能回复");
      const isImage = mime?.startsWith("image/");
      const mediaType = isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE;
      const uploaded = await uploadMedia(buffer, chatId, mediaType);
      if (isImage) {
        await sendImageMessage(chatId, uploaded, ctx, "");
      } else {
        await sendFileMessage(chatId, uploaded, ctx, filename || "file");
      }
    },

    async downloadImage(platformRef: string): Promise<Buffer> {
      const { encrypt_query_param, aes_key } = JSON.parse(platformRef) as { encrypt_query_param: string; aes_key?: string };
      const cdnUrl = buildCdnDownloadUrl(encrypt_query_param);
      const res = await fetch(cdnUrl);
      if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
      const encrypted = Buffer.from(await res.arrayBuffer());
      if (!aes_key) return encrypted; // 无加密，直接返回
      const key = parseAesKey(aes_key);
      return decryptAesEcb(encrypted, key);
    },

    stop(): void {
      generation++;
      abortController.abort();
      abortController = new AbortController();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      onStatus?.("disconnected");
    },

    async getMe() {
      // 用 getconfig 验证 token（不污染 cursor）
      try {
        const resp = await api("ilink/bot/getconfig", {
          base_info: { channel_version: "1.0.0" },
        }, 10_000);
        if (resp.ret && resp.ret !== 0) {
          throw new Error(resp.errmsg || `errcode ${resp.ret}`);
        }
        return { ok: true, platform: "wechat" };
      } catch (err) {
        throw new Error(`微信 token 验证失败: ${errorMessage(err)}`);
      }
    },
  };
}
