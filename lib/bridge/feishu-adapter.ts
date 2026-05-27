/**
 * feishu-adapter.js — 飞书 Bot WebSocket 长连接适配器
 *
 * 使用 @larksuiteoapi/node-sdk 的 WSClient 接收消息，
 * 通过 onMessage 回调将标准化消息交给 BridgeManager。
 *
 * Lark SDK 通过 dynamic import 按需加载（~24MB），
 * 仅在用户实际配置飞书 Bridge 时才会加载。
 */

import { debugLog } from "../debug-log.js";
import { downloadMedia, detectMime, streamToBuffer } from "./media-utils.js";
import type { BridgeAdapter, BridgeAttachment, BridgeMessageHandler, BridgeStatusHandler, SendMediaBufferMeta } from "./adapter-types.js";

/** 延迟加载 Lark SDK，首次调用后缓存 */
let _larkModule: LarkModule | null = null;

interface LarkModule {
  Client: new (options: { appId: string; appSecret: string }) => LarkClient;
  EventDispatcher: new (options: Record<string, unknown>) => {
    register(handlers: Record<string, (data: LarkMessageEvent) => void | Promise<void>>): unknown;
  };
  WSClient: new (options: { appId: string; appSecret: string; loggerLevel: unknown }) => LarkWsClient;
  LoggerLevel: { warn: unknown };
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
  im: {
    message: {
      create(args: { params: { receive_id_type: "chat_id" }; data: Record<string, unknown> }): Promise<unknown>;
    };
    image: {
      get(args: { path: { image_key: string } }): Promise<AsyncIterable<Buffer | Uint8Array>>;
      create(args: { data: { image_type: "message"; image: Buffer } }): Promise<{ data: { image_key: string } }>;
    };
    messageResource: {
      get(args: { path: { message_id: string; file_key: string }; params: { type: "file" } }): Promise<AsyncIterable<Buffer | Uint8Array>>;
    };
    file: {
      create(args: { data: { file_type: string; file_name: string; file: Buffer } }): Promise<{ data: { file_key: string } }>;
    };
  };
}

interface LarkWsClient {
  wsConfig?: { wsInstance?: { readyState?: number } | null };
  start(args: { eventDispatcher: unknown }): Promise<unknown>;
  close(): void;
}

interface LarkMessageEvent {
  message: {
    message_type: string;
    content: string;
    message_id: string;
    chat_id: string;
    chat_type: string;
  };
  sender: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      user_id?: string;
    };
  };
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

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function loadLarkSDK(): Promise<LarkModule> {
  if (!_larkModule) {
    try {
      _larkModule = await import("@larksuiteoapi/node-sdk") as unknown as LarkModule;
    } catch (err) {
      throw new Error(
        `飞书 SDK (@larksuiteoapi/node-sdk) 未安装。请运行 npm install @larksuiteoapi/node-sdk 后重试。原始错误: ${errorMessage(err)}`
      );
    }
  }
  return _larkModule;
}

export async function createFeishuAdapter({ appId, appSecret, onMessage, onStatus }: FeishuAdapterOptions): Promise<BridgeAdapter> {
  const lark = await loadLarkSDK();
  const client = new lark.Client({ appId, appSecret });

  /** 用户信息缓存 { [openId]: { name, avatarUrl } } */
  const userCache = new Map<string, FeishuUserInfo>();

  async function getUserInfo(openId: string): Promise<FeishuUserInfo> {
    const cached = userCache.get(openId);
    // 只使用成功缓存（有 name 的），失败的下次重试
    if (cached?.name) return cached;

    try {
      const res = await client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });
      const user = res?.data?.user;
      // 优先 nickname（用户昵称）→ en_name → name（真名，最后 fallback）
      const displayName = user?.nickname || user?.en_name || user?.name || null;
      const avatarUrl = user?.avatar?.avatar_240 || user?.avatar?.avatar_72 || null;
      console.log("[feishu] getUserInfo succeeded (cached:", !!cached, ")");
      const info = { name: displayName, avatarUrl };
      if (info.name) userCache.set(openId, info);
      return info;
    } catch {
      console.error("[feishu] getUserInfo failed");
      return { name: null, avatarUrl: null };
    }
  }

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const { message, sender } = data;

      // 忽略 bot 自身消息
      if (sender.sender_type === "bot") return;

      const attachments: BridgeAttachment[] = [];
      let text = "";

      try {
        if (message.message_type === "text") {
          text = String(parseJsonObject(message.content).text || "");
        } else if (message.message_type === "image") {
          const { image_key } = parseJsonObject(message.content);
          if (typeof image_key === "string") attachments.push({ type: "image", platformRef: image_key, mimeType: "image/jpeg" });
        } else if (message.message_type === "file") {
          const { file_key, file_name } = parseJsonObject(message.content);
          if (typeof file_key === "string") attachments.push({ type: "file", platformRef: file_key, filename: typeof file_name === "string" ? file_name : undefined,
            _messageId: message.message_id });
        } else if (message.message_type === "audio") {
          const { file_key, duration } = parseJsonObject(message.content);
          if (typeof file_key === "string") attachments.push({ type: "audio", platformRef: file_key,
            duration: duration ? Number(duration) / 1000 : undefined, _messageId: message.message_id });
        } else if (message.message_type === "media") {
          // 飞书 "media" = 视频
          const { file_key, file_name, duration } = parseJsonObject(message.content);
          if (typeof file_key === "string") attachments.push({ type: "video", platformRef: file_key, filename: typeof file_name === "string" ? file_name : undefined,
            duration: duration ? Number(duration) / 1000 : undefined, _messageId: message.message_id });
        } else {
          return; // sticker 等暂不支持
        }
      } catch (e) {
        console.error("[feishu] Failed to parse message content:", errorMessage(e));
        return;
      }

      if (!text && !attachments.length) return;

      const MAX_MSG_SIZE = 100_000;
      if (text.length > MAX_MSG_SIZE) {
        console.warn(`[feishu] 消息过大（${text.length} chars），已截断`);
        text = text.slice(0, MAX_MSG_SIZE);
      }

      const chatId = message.chat_id;
      const openId = sender.sender_id?.open_id || "unknown";
      const userId = sender.sender_id?.user_id || openId;
      const chatType = message.chat_type; // "p2p" | "group"
      const isGroup = chatType === "group";
      const sessionKey = isGroup ? `fs_group_${chatId}` : `fs_dm_${openId}`;

      const userInfo = await getUserInfo(openId);

      onMessage({
        platform: "feishu",
        chatId,
        userId,
        sessionKey,
        text,
        senderName: userInfo.name,
        avatarUrl: userInfo.avatarUrl,
        isGroup,
        attachments: attachments.length ? attachments : undefined,
      });
    },
  });

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  });

  // start() 调用 reConnect() 后立即 resolve，不等 WebSocket 连通。
  // SDK 内部有自动重连机制，连接成功后 wsConfig.wsInstance 会被设置。
  // 通过轮询 wsInstance 确认连接状态，避免访问不存在的私有属性。
  wsClient.start({ eventDispatcher }).then(() => {
    // 轮询检查连接状态（SDK 不暴露连接事件）
    let checks = 0;
    const maxChecks = 20; // 20 × 500ms = 10s
    const timer = setInterval(() => {
      checks++;
      const wsInstance = wsClient.wsConfig?.wsInstance;
      if (wsInstance && wsInstance.readyState === 1) {
        clearInterval(timer);
        onStatus?.("connected");
      } else if (checks >= maxChecks) {
        clearInterval(timer);
        console.error("[feishu] WSClient not connected after 10s");
        onStatus?.("error", "WebSocket connection failed");
      }
    }, 500);
  }).catch((err: unknown) => {
    const msg = errorMessage(err);
    console.error("[feishu] WSClient start failed:", msg);
    debugLog()?.error("bridge", `feishu WSClient start failed: ${msg}`);
    onStatus?.("error", msg);
  });

  /** 每个 chatId 独立的 block streaming 发送时间（用于 humanDelay） */
  const lastBlockTsMap = new Map<string, number>();

  async function sendMediaBuffer(chatId: string, buffer: Buffer, { mime, filename }: SendMediaBufferMeta): Promise<void> {
    if (mime.startsWith("image/")) {
      const res = await client.im.image.create({
        data: { image_type: "message", image: buffer },
      });
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId, msg_type: "image",
          content: JSON.stringify({ image_key: res.data.image_key }),
        },
      });
    } else {
      const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
      const fileType = { pdf: "pdf", doc: "doc", docx: "doc", xls: "xls",
        xlsx: "xls", ppt: "ppt", pptx: "ppt", mp4: "mp4" }[ext] || "stream";
      const res = await client.im.file.create({
        data: { file_type: fileType, file_name: filename || "file", file: buffer },
      });
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId, msg_type: "file",
          content: JSON.stringify({ file_key: res.data.file_key }),
        },
      });
    }
  }

  return {
    async sendReply(chatId: string, text: string) {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    },

    /** block streaming 专用：发一条气泡，两条之间加 humanDelay */
    async sendBlockReply(chatId: string, text: string) {
      const now = Date.now();
      const lastTs = lastBlockTsMap.get(chatId) || 0;
      const elapsed = now - lastTs;
      const delay = 800 + Math.random() * 1200; // 800~2000ms
      if (lastTs && elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      lastBlockTsMap.set(chatId, Date.now());
    },

    /** 下载飞书图片（通过 image_key） */
    async downloadImage(imageKey: string): Promise<Buffer> {
      const resp = await client.im.image.get({ path: { image_key: imageKey } });
      return streamToBuffer(resp);
    },

    /** 下载飞书文件/音频/视频（通过 message_id + file_key） */
    async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
      const resp = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: "file" },
      });
      return streamToBuffer(resp);
    },

    /** 发送媒体（图片走 image API，其他走 file API） */
    async sendMedia(chatId: string, url: string) {
      const buffer = await downloadMedia(url);
      const mime = detectMime(buffer, "application/octet-stream");
      const filename = (() => { try { return new URL(url).pathname.split("/").pop() || "file"; } catch { return "file"; } })();
      await sendMediaBuffer(chatId, buffer, { mime, filename });
    },

    /** 发送本地 Buffer（sendMediaFile 专用，无需公开 URL） */
    sendMediaBuffer,

    stop(): void {
      try { wsClient.close(); } catch {}
    },
  };
}
