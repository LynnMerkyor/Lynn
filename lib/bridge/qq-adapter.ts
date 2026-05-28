/**
 * qq-adapter.js — QQ 机器人适配器（v2 API）
 *
 * 使用 QQ 开放平台 v2 鉴权（AppID + AppSecret → access_token）。
 * 自建 WebSocket 连接接收消息，支持频道消息和 C2C 私信。
 *
 * 凭证：appID + appSecret，从 QQ 机器人开放平台获取。
 */

import WebSocket, { type RawData } from "ws";
import { debugLog } from "../debug-log.js";
import type { BridgeAdapter, BridgeAttachment, BridgeMessageHandler, BridgeStatusHandler, SendMediaBufferMeta } from "./adapter-types.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const MAX_MSG_SIZE = 100_000;

// WebSocket OpCode
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// Intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

type QQHttpMethod = "GET" | "POST";

interface QQAdapterOptions {
  appID: string;
  appSecret: string;
  onMessage: BridgeMessageHandler;
  dmGuildMap?: Record<string, string>;
  onDmGuildDiscovered?: (userId: string, guildId: string) => void;
  onStatus?: BridgeStatusHandler;
}

interface QQTokenResponse {
  access_token?: string;
  expires_in?: number;
  [key: string]: unknown;
}

interface QQGatewayResponse {
  url?: string;
  [key: string]: unknown;
}

interface QQAttachmentRaw {
  content_type?: string;
  url?: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
}

interface QQAuthor {
  id?: string;
  user_openid?: string;
  member_openid?: string;
  username?: string;
}

interface QQEventData {
  id?: string;
  content?: string;
  attachments?: QQAttachmentRaw[];
  author?: QQAuthor;
  group_openid?: string;
  channel_id?: string;
  guild_id?: string;
}

interface QQPayload {
  op?: number;
  d?: QQEventData & { heartbeat_interval?: number; session_id?: string };
  s?: number;
  t?: string;
}

type QQApiBody = Record<string, unknown>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf-8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf-8");
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf-8");
  return Buffer.from(raw).toString("utf-8");
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeExtFromUrl(url: string): string {
  try { return new URL(url).pathname.split(".").pop()?.toLowerCase() || ""; }
  catch { return ""; }
}

export function createQQAdapter({ appID, appSecret, onMessage, dmGuildMap, onDmGuildDiscovered, onStatus }: QQAdapterOptions): BridgeAdapter {
  let accessToken: string | null = null;
  let tokenExpiresAt = 0;
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeq: number | null = null;
  let sessionId: string | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let heartbeatAckReceived = true;
  let lastConnectedAt = 0;

  const userGuildMap = new Map(Object.entries(dmGuildMap || {}));

  // ── Token 管理 ──

  async function refreshToken(): Promise<string> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: appID, clientSecret: appSecret }),
    });
    const data = await res.json() as QQTokenResponse;
    if (!data.access_token) {
      throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
    }
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    debugLog()?.log("bridge", `[qq] token 已刷新，有效期 ${data.expires_in}s`);
    return accessToken;
  }

  async function getToken(): Promise<string> {
    // 提前 5 分钟刷新
    if (!accessToken || Date.now() > tokenExpiresAt - 5 * 60 * 1000) {
      return refreshToken();
    }
    return accessToken;
  }

  // ── API 请求 ──

  async function apiRequest<T extends Record<string, unknown> = Record<string, unknown>>(method: QQHttpMethod, path: string, body?: QQApiBody): Promise<T> {
    const token = await getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QQ API [${path}] ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json() as T;
  }

  // ── WebSocket ──

  async function connect(): Promise<void> {
    if (stopped) return;
    try {
      const token = await getToken();
      const { url } = await apiRequest<QQGatewayResponse>("GET", "/gateway");
      if (!url) throw new Error("QQ gateway missing url");

      ws = new WebSocket(url);

      ws.on("open", () => {
        debugLog()?.log("bridge", "[qq] WebSocket 已连接");
        lastConnectedAt = Date.now();
        reconnectAttempts = 0;
      });

      ws.on("message", (raw) => {
        let payload: QQPayload;
        try { payload = JSON.parse(rawDataToString(raw)) as QQPayload; } catch { return; }
        handlePayload(payload, token);
      });

      ws.on("close", (code) => {
        debugLog()?.log("bridge", `[qq] WebSocket 断开 (code: ${code})`);
        stopHeartbeat();
        if (!stopped) scheduleReconnect();
      });

      ws.on("error", (err) => {
        const msg = errorMessage(err);
        console.error("[qq] WebSocket error:", msg);
        debugLog()?.error("bridge", `[qq] WebSocket error: ${msg}`);
        onStatus?.("error", msg);
      });
    } catch (err) {
      const msg = errorMessage(err);
      console.error("[qq] 连接失败:", msg);
      onStatus?.("error", msg);
      if (!stopped) scheduleReconnect();
    }
  }

  function handlePayload(payload: QQPayload, token: string): void {
    const { op, d, s, t } = payload;
    if (s) lastSeq = s;

    switch (op) {
      case OP.HELLO:
        startHeartbeat(d?.heartbeat_interval || 45_000);
        // 鉴权
        if (sessionId) {
          // Resume
          wsSend({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } });
        } else {
          // Identify
          wsSend({
            op: OP.IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
              shard: [0, 1],
            },
          });
        }
        break;

      case OP.DISPATCH:
        if (t === "READY") {
          sessionId = d?.session_id || null;
          debugLog()?.log("bridge", `[qq] 鉴权成功，session: ${sessionId}`);
          onStatus?.("connected");
        } else if (t === "RESUMED") {
          debugLog()?.log("bridge", "[qq] 会话已恢复");
          onStatus?.("connected");
        } else {
          if (t && d) handleEvent(t, d);
        }
        break;

      case OP.HEARTBEAT_ACK:
        heartbeatAckReceived = true;
        break;

      case OP.RECONNECT:
        debugLog()?.log("bridge", "[qq] 收到重连指令");
        ws?.close();
        break;

      case OP.INVALID_SESSION:
        debugLog()?.log("bridge", "[qq] 会话失效，重新鉴权");
        sessionId = null;
        lastSeq = null;
        ws?.close();
        break;
    }
  }

  /** 从 QQ v2 API 事件的 data.attachments 提取统一附件 */
  function extractAttachments(data: QQEventData): BridgeAttachment[] {
    const attachments: BridgeAttachment[] = [];
    if (data.attachments?.length) {
      for (const att of data.attachments) {
        const ct = att.content_type || "";
        const type = ct.startsWith("image/") ? "image"
          : ct.startsWith("video/") ? "video"
          : ct.startsWith("audio/") ? "audio" : "file";
        attachments.push({
          type, url: att.url, filename: att.filename,
          mimeType: ct, size: att.size,
          width: att.width, height: att.height,
        });
      }
    }
    return attachments;
  }

  function handleEvent(type: string, data: QQEventData): void {
    // C2C 私信
    if (type === "C2C_MESSAGE_CREATE") {
      const text = safeString(data.content).trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      if (text.length > MAX_MSG_SIZE) return;
      const userId = data.author?.user_openid || data.author?.id;
      if (!userId) return;
      onMessage({
        platform: "qq",
        chatId: userId,
        userId,
        sessionKey: `qq_dm_${userId}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: false,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
    // 群聊消息
    else if (type === "GROUP_AT_MESSAGE_CREATE") {
      let text = (data.content || "").replace(/<@!?\d+>/g, "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      if (text.length > MAX_MSG_SIZE) return;
      if (!data.group_openid) return;
      onMessage({
        platform: "qq",
        chatId: data.group_openid,
        userId: data.author?.member_openid || data.author?.id,
        sessionKey: `qq_group_${data.group_openid}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: true,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
    // 频道公域消息（兼容旧的频道机器人）
    else if (type === "AT_MESSAGE_CREATE") {
      let text = (data.content || "").replace(/<@!?\d+>/g, "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      if (!data.channel_id) return;
      onMessage({
        platform: "qq",
        chatId: data.channel_id,
        userId: data.author?.id,
        sessionKey: `qq_group_${data.channel_id}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: true,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
    // 频道私信
    else if (type === "DIRECT_MESSAGE_CREATE") {
      const text = safeString(data.content).trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      const chatId = data.guild_id;
      if (!chatId) return;
      if (data.author?.id && chatId) {
        if (userGuildMap.get(data.author.id) !== chatId) {
          userGuildMap.set(data.author.id, chatId);
          onDmGuildDiscovered?.(data.author.id, chatId);
        }
      }
      onMessage({
        platform: "qq",
        chatId,
        userId: data.author?.id,
        sessionKey: `qq_dm_${data.author?.id}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: false,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
  }

  function wsSend(data: QQApiBody): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function startHeartbeat(interval: number): void {
    stopHeartbeat();
    heartbeatAckReceived = true;
    heartbeatTimer = setInterval(() => {
      if (!heartbeatAckReceived) {
        debugLog()?.log("bridge", "[qq] 心跳超时（未收到 ACK），强制重连");
        ws?.close();
        return;
      }
      heartbeatAckReceived = false;
      wsSend({ op: OP.HEARTBEAT, d: lastSeq });
    }, interval);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    // 如果上次连接保活超过 5 分钟，说明不是启动阶段频繁失败，重置计数
    if (lastConnectedAt && Date.now() - lastConnectedAt > 5 * 60 * 1000) {
      reconnectAttempts = 0;
    }
    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(reconnectAttempts, delays.length - 1)];
    reconnectAttempts++;
    debugLog()?.log("bridge", `[qq] ${delay / 1000}s 后重连（第 ${reconnectAttempts} 次）`);
    setTimeout(() => connect(), delay);
  }

  // ── 启动 ──
  connect();

  // ── Token 定时刷新 ──
  let tokenRefreshFailures = 0;
  const tokenRefreshTimer = setInterval(async () => {
    try {
      await refreshToken();
      tokenRefreshFailures = 0;
    } catch (err) {
      tokenRefreshFailures++;
      const msg = errorMessage(err);
      console.error(`[qq] token 刷新失败（连续第 ${tokenRefreshFailures} 次）:`, msg);
      debugLog()?.error("bridge", `[qq] token 刷新失败: ${msg}`);
      if (tokenRefreshFailures >= 3) {
        onStatus?.("error", `Token 连续 ${tokenRefreshFailures} 次刷新失败`);
      }
    }
  }, 60 * 60 * 1000); // 每小时刷新

  let lastBlockTs = 0;

  async function sendReply(chatId: string, text: string, _msgId?: string): Promise<void> {
    const MAX = 2000;
    for (let i = 0; i < text.length; i += MAX) {
      const chunk = text.slice(i, i + MAX);
      const body: QQApiBody = { content: chunk, msg_type: 0 };
      if (_msgId) body.msg_id = _msgId;

      // 尝试 C2C → 群聊 → 频道，根据 chatId 格式判断
      // v2 API: C2C 用 user_openid，群用 group_openid，频道用 channel_id
      try {
        await apiRequest("POST", `/v2/users/${chatId}/messages`, body);
      } catch (e1) {
        try {
          await apiRequest("POST", `/v2/groups/${chatId}/messages`, body);
        } catch (e2) {
          try {
            await apiRequest("POST", `/channels/${chatId}/messages`, { content: chunk, ...(_msgId ? { msg_id: _msgId } : {}) });
          } catch (e3) {
            debugLog()?.error("bridge", `[qq] 消息发送全部失败 chatId=${chatId}: C2C=${errorMessage(e1)}, Group=${errorMessage(e2)}, Channel=${errorMessage(e3)}`);
            throw e3;
          }
        }
      }
    }
  }

  return {
    sendReply,

    async sendBlockReply(chatId: string, text: string, _msgId?: string) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200;
      if (lastBlockTs && elapsed < delay) {
        await new Promise((r) => setTimeout(r, delay - elapsed));
      }
      await sendReply(chatId, text, _msgId);
      lastBlockTs = Date.now();
    },

    /** 发送媒体（两步上传：先上传获取 file_info，再发送富媒体消息） */
    async sendMedia(chatId: string, url: string) {
      const ext = safeExtFromUrl(url);
      const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
      const videoExts = ["mp4", "mov"];
      const audioExts = ["mp3", "ogg", "wav", "silk", "amr"];

      // file_type: 1=图片, 2=视频, 3=音频, 4=文件
      let fileType = 4;
      if (imageExts.includes(ext)) fileType = 1;
      else if (videoExts.includes(ext)) fileType = 2;
      else if (audioExts.includes(ext)) fileType = 3;

      const uploadBody = { file_type: fileType, url, srv_send_msg: false };
      let fileInfo: unknown;
      // Step 1: 上传（C2C → Group fallback）
      try {
        const res = await apiRequest("POST", `/v2/users/${chatId}/files`, uploadBody);
        fileInfo = res.file_info;
      } catch {
        try {
          const res = await apiRequest("POST", `/v2/groups/${chatId}/files`, uploadBody);
          fileInfo = res.file_info;
        } catch (err) {
          debugLog()?.error("bridge", `[qq] 媒体上传失败: ${errorMessage(err)}`);
          throw err;
        }
      }
      // Step 2: 发送富媒体消息
      const msgBody = { msg_type: 7, media: { file_info: fileInfo }, content: " " };
      try {
        await apiRequest("POST", `/v2/users/${chatId}/messages`, msgBody);
      } catch {
        try {
          await apiRequest("POST", `/v2/groups/${chatId}/messages`, msgBody);
        } catch (err) {
          debugLog()?.error("bridge", `[qq] 富媒体消息发送失败: ${errorMessage(err)}`);
          throw err;
        }
      }
    },

    /** 发送本地 Buffer（桌面端推送文件用，尝试 base64 上传） */
    async sendMediaBuffer(chatId: string, buffer: Buffer, { mime, filename }: SendMediaBufferMeta) {
      const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
      const videoExts = ["mp4", "mov"];
      const audioExts = ["mp3", "ogg", "wav", "silk", "amr"];
      const ext = (filename || "").split(".").pop()?.toLowerCase() || "";

      let fileType = 4;
      if (mime.startsWith("image/") || imageExts.includes(ext)) fileType = 1;
      else if (mime.startsWith("video/") || videoExts.includes(ext)) fileType = 2;
      else if (mime.startsWith("audio/") || audioExts.includes(ext)) fileType = 3;

      // 尝试用 file_data (base64) 上传
      const uploadBody = { file_type: fileType, file_data: buffer.toString("base64"), srv_send_msg: false };
      let fileInfo: unknown;
      try {
        const res = await apiRequest("POST", `/v2/users/${chatId}/files`, uploadBody);
        fileInfo = res.file_info;
      } catch {
        try {
          const res = await apiRequest("POST", `/v2/groups/${chatId}/files`, uploadBody);
          fileInfo = res.file_info;
        } catch (err) {
          // base64 上传不被支持，抛错让调用方知道（不静默 fallback 避免伪成功）
          const msg = errorMessage(err);
          debugLog()?.warn("bridge", `[qq] sendMediaBuffer base64 上传失败: ${msg}`);
          throw new Error(`QQ base64 上传不支持: ${msg}`);
        }
      }
      const msgBody = { msg_type: 7, media: { file_info: fileInfo }, content: " " };
      try {
        await apiRequest("POST", `/v2/users/${chatId}/messages`, msgBody);
      } catch {
        try {
          await apiRequest("POST", `/v2/groups/${chatId}/messages`, msgBody);
        } catch (err) {
          debugLog()?.error("bridge", `[qq] sendMediaBuffer 发送失败: ${errorMessage(err)}`);
          throw err;
        }
      }
    },

    stop(): void {
      stopped = true;
      stopHeartbeat();
      clearInterval(tokenRefreshTimer);
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
    },

    async getMe() {
      return apiRequest("GET", "/users/@me");
    },

    resolveOwnerChatId(userId: string): string | null {
      return userGuildMap.get(userId) || null;
    },
  };
}
