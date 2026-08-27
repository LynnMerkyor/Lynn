/**
 * feishu-adapter.js — 飞书 Bot Channel 长连接适配器
 *
 * 使用 @larksuiteoapi/node-sdk 的公开 Channel API 接收、标准化和发送消息。
 * Channel.connect() 会等待真实 WebSocket 握手，并公开重连生命周期，避免依赖
 * WSClient 的私有 wsConfig 字段。SDK 仍按需动态加载，仅在启用飞书 Bridge 时加载。
 */

import { debugLog } from "../debug-log.js";
import { downloadMedia, detectMime } from "./media-utils.js";
import type { BridgeAdapter, BridgeAttachment, BridgeMessageHandler, BridgeStatusHandler, SendMediaBufferMeta } from "./adapter-types.js";

let _larkModule: LarkModule | null = null;

interface LarkResource {
  type: "image" | "file" | "audio" | "video" | "sticker";
  fileKey: string;
  fileName?: string;
  durationMs?: number;
}

interface LarkNormalizedMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  resources: LarkResource[];
}

interface LarkChannelError extends Error {
  code?: string;
}

interface LarkClient {
  contact: {
    user: {
      get(args: { path: { user_id: string }; params: { user_id_type: "open_id" } }): Promise<{
        data?: {
          user?: {
            nickname?: string | null;
            en_name?: string | null;
            name?: string | null;
            avatar?: {
              avatar_240?: string | null;
              avatar_72?: string | null;
            } | null;
          };
        };
      }>;
    };
  };
}

interface LarkChannel {
  rawClient: LarkClient;
  botIdentity?: { openId: string; userId?: string; name: string };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: "message", handler: (message: LarkNormalizedMessage) => void | Promise<void>): () => void;
  on(event: "error", handler: (error: LarkChannelError) => void): () => void;
  on(event: "reconnecting" | "reconnected", handler: () => void): () => void;
  send(chatId: string, input:
    | { text: string }
    | { image: { source: Buffer } }
    | { file: { source: Buffer; fileName: string } }
    | { audio: { source: Buffer; duration?: number } }
    | { video: { source: Buffer; duration?: number } },
  ): Promise<unknown>;
  downloadResource(fileKey: string, type: "image" | "file"): Promise<Buffer>;
}

interface LarkModule {
  createLarkChannel(options: {
    appId: string;
    appSecret: string;
    loggerLevel: unknown;
    source: string;
    handshakeTimeoutMs: number;
    wsConfig: { pingTimeout: number };
    policy: { requireMention: boolean; dmMode: "open"; respondToMentionAll: boolean };
    safety: {
      chatQueue: { enabled: boolean };
      staleMessageWindowMs: number;
    };
  }): LarkChannel;
  LoggerLevel: { warn: unknown };
}

interface FeishuUserInfo {
  name: string | null;
  avatarUrl: string | null;
}

interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  onMessage: BridgeMessageHandler;
  onStatus?: BridgeStatusHandler;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripResourcePlaceholders(content: string, resources: readonly LarkResource[]): string {
  if (resources.length === 0) return content.trim();
  let text = content;
  for (const resource of resources) {
    const escapedKey = resource.fileKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (resource.type === "image") {
      text = text.replace(new RegExp(`!\\[image\\]\\(${escapedKey}\\)`, "g"), "");
    } else {
      text = text.replace(new RegExp(`<${resource.type}\\b[^>]*\\bkey=["']${escapedKey}["'][^>]*/>`, "g"), "");
    }
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function toBridgeAttachments(message: LarkNormalizedMessage): BridgeAttachment[] {
  return message.resources.flatMap((resource): BridgeAttachment[] => {
    if (resource.type === "sticker") return [];
    return [{
      type: resource.type,
      platformRef: resource.fileKey,
      ...(resource.fileName ? { filename: resource.fileName } : {}),
      ...(resource.durationMs != null ? { duration: resource.durationMs / 1000 } : {}),
      ...(resource.type === "image" ? { mimeType: "image/jpeg" } : {}),
      _messageId: message.messageId,
    }];
  });
}

async function loadLarkSDK(): Promise<LarkModule> {
  if (!_larkModule) {
    try {
      _larkModule = await import("@larksuiteoapi/node-sdk") as unknown as LarkModule;
    } catch (err) {
      throw new Error(
        `飞书 SDK (@larksuiteoapi/node-sdk) 未安装。请重新安装或更新 Lynn 后重试。原始错误: ${errorMessage(err)}`
      );
    }
  }
  return _larkModule;
}

function createChannel(lark: LarkModule, appId: string, appSecret: string): LarkChannel {
  return lark.createLarkChannel({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.warn,
    source: "lynn-agent",
    handshakeTimeoutMs: 15_000,
    wsConfig: { pingTimeout: 45 },
    policy: { requireMention: false, dmMode: "open", respondToMentionAll: true },
    safety: { chatQueue: { enabled: false }, staleMessageWindowMs: 5 * 60_000 },
  });
}

/** 使用与生产 Bridge 相同的真实 WebSocket 握手验证凭证和长连接配置。 */
export async function testFeishuConnection(appId: string, appSecret: string): Promise<{ name?: string; openId?: string }> {
  const lark = await loadLarkSDK();
  const channel = createChannel(lark, appId, appSecret);
  try {
    await channel.connect();
    return { name: channel.botIdentity?.name, openId: channel.botIdentity?.openId };
  } finally {
    await channel.disconnect().catch(() => undefined);
  }
}

export async function createFeishuAdapter({ appId, appSecret, onMessage, onStatus }: FeishuAdapterOptions): Promise<BridgeAdapter> {
  const lark = await loadLarkSDK();
  const channel = createChannel(lark, appId, appSecret);
  const client = channel.rawClient;
  const userCache = new Map<string, FeishuUserInfo>();

  async function getUserInfo(openId: string, normalizedName?: string): Promise<FeishuUserInfo> {
    const cached = userCache.get(openId);
    if (cached?.name) return cached;
    if (normalizedName) {
      const info = { name: normalizedName, avatarUrl: cached?.avatarUrl || null };
      userCache.set(openId, info);
      return info;
    }
    try {
      const res = await client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });
      const user = res?.data?.user;
      const info = {
        name: user?.nickname || user?.en_name || user?.name || null,
        avatarUrl: user?.avatar?.avatar_240 || user?.avatar?.avatar_72 || null,
      };
      if (info.name) userCache.set(openId, info);
      return info;
    } catch (error) {
      debugLog()?.log("bridge", `feishu user lookup unavailable: ${errorMessage(error)}`);
      return { name: null, avatarUrl: null };
    }
  }

  channel.on("message", async (message) => {
    const attachments = toBridgeAttachments(message);
    const text = stripResourcePlaceholders(message.content, message.resources);
    if (!text && attachments.length === 0) return;

    const MAX_MSG_SIZE = 100_000;
    const boundedText = text.length > MAX_MSG_SIZE ? text.slice(0, MAX_MSG_SIZE) : text;
    if (text.length > MAX_MSG_SIZE) console.warn(`[feishu] 消息过大（${text.length} chars），已截断`);

    const openId = message.senderId || "unknown";
    const isGroup = message.chatType === "group";
    const sessionKey = isGroup ? `fs_group_${message.chatId}` : `fs_dm_${openId}`;
    const userInfo = await getUserInfo(openId, message.senderName);

    await onMessage({
      platform: "feishu",
      chatId: message.chatId,
      userId: openId,
      sessionKey,
      text: boundedText,
      senderName: userInfo.name,
      avatarUrl: userInfo.avatarUrl,
      isGroup,
      attachments: attachments.length ? attachments : undefined,
    });
  });

  channel.on("reconnecting", () => onStatus?.("connecting"));
  channel.on("reconnected", () => onStatus?.("connected"));
  channel.on("error", (error) => {
    const detail = error.code ? `${error.code}: ${error.message}` : error.message;
    debugLog()?.error("bridge", `feishu channel error: ${detail}`);
    onStatus?.("error", detail);
  });

  try {
    await channel.connect();
    onStatus?.("connected");
  } catch (error) {
    const detail = errorMessage(error);
    debugLog()?.error("bridge", `feishu Channel connect failed: ${detail}`);
    onStatus?.("error", detail);
    await channel.disconnect().catch(() => undefined);
    throw error;
  }

  const lastBlockTsMap = new Map<string, number>();

  async function sendMediaBuffer(chatId: string, buffer: Buffer, { mime, filename }: SendMediaBufferMeta): Promise<void> {
    if (mime.startsWith("image/")) {
      await channel.send(chatId, { image: { source: buffer } });
      return;
    }
    if (mime.startsWith("audio/")) {
      await channel.send(chatId, { audio: { source: buffer } });
      return;
    }
    if (mime.startsWith("video/")) {
      await channel.send(chatId, { video: { source: buffer } });
      return;
    }
    await channel.send(chatId, { file: { source: buffer, fileName: filename || "file" } });
  }

  return {
    async sendReply(chatId: string, text: string) {
      await channel.send(chatId, { text });
    },

    async sendBlockReply(chatId: string, text: string) {
      const now = Date.now();
      const lastTs = lastBlockTsMap.get(chatId) || 0;
      const elapsed = now - lastTs;
      const delay = 800 + Math.random() * 1200;
      if (lastTs && elapsed < delay) await new Promise(resolve => setTimeout(resolve, delay - elapsed));
      await channel.send(chatId, { text });
      lastBlockTsMap.set(chatId, Date.now());
    },

    async downloadImage(imageKey: string): Promise<Buffer> {
      return channel.downloadResource(imageKey, "image");
    },

    async downloadFile(_messageId: string, fileKey: string): Promise<Buffer> {
      return channel.downloadResource(fileKey, "file");
    },

    async sendMedia(chatId: string, url: string) {
      const buffer = await downloadMedia(url);
      const mime = detectMime(buffer, "application/octet-stream");
      const filename = (() => { try { return new URL(url).pathname.split("/").pop() || "file"; } catch { return "file"; } })();
      await sendMediaBuffer(chatId, buffer, { mime, filename });
    },

    sendMediaBuffer,

    stop(): void {
      void channel.disconnect().catch((error) => {
        debugLog()?.log("bridge", `feishu disconnect warning: ${errorMessage(error)}`);
      });
    },
  };
}

export const __testing__ = {
  stripResourcePlaceholders,
  toBridgeAttachments,
};
