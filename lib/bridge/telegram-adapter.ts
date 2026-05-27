/**
 * telegram-adapter.js — Telegram Bot 长轮询适配器
 *
 * 使用 node-telegram-bot-api 监听消息，
 * 通过 onMessage 回调将标准化消息交给 BridgeManager。
 */

import TelegramBot from "node-telegram-bot-api";
import { debugLog } from "../debug-log.js";
import type { BridgeAdapter, BridgeAttachment, BridgeMessageHandler, BridgeStatusHandler, SendMediaBufferMeta } from "./adapter-types.js";

const MAX_MSG_SIZE = 100_000; // 100KB

/** 从 URL 安全提取扩展名（小写，无点号） */
function safeExtFromUrl(url: string): string {
  try { return new URL(url).pathname.split(".").pop()?.toLowerCase() || ""; }
  catch { return ""; }
}

interface TelegramAdapterOptions {
  token: string;
  onMessage: BridgeMessageHandler;
  onStatus?: BridgeStatusHandler;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createTelegramAdapter({ token, onMessage, onStatus }: TelegramAdapterOptions): BridgeAdapter {
  let bot = new TelegramBot(token, { polling: true });
  let stopped = false;
  let consecutiveErrors = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  function attachListeners(b: TelegramBot): void {
    b.on("message", async (msg) => {
      const text = msg.text || msg.caption || "";
      consecutiveErrors = 0;

      // 提取附件（每种类型独立 try/catch，单个失败不影响其他）
      const attachments: BridgeAttachment[] = [];
      if (msg.photo?.length) {
        try {
          const best = msg.photo[msg.photo.length - 1];
          const url = await bot.getFileLink(best.file_id);
          attachments.push({ type: "image", url, mimeType: "image/jpeg",
            width: best.width, height: best.height, platformRef: best.file_id });
        } catch (err) {
          debugLog()?.warn("bridge", `[telegram] photo 提取失败: ${errorMessage(err)}`);
        }
      }
      if (msg.document) {
        try {
          const url = await bot.getFileLink(msg.document.file_id);
          attachments.push({ type: "file", url, filename: msg.document.file_name,
            mimeType: msg.document.mime_type, size: msg.document.file_size,
            platformRef: msg.document.file_id });
        } catch (err) {
          debugLog()?.warn("bridge", `[telegram] document 提取失败: ${errorMessage(err)}`);
        }
      }
      if (msg.voice) {
        try {
          const url = await bot.getFileLink(msg.voice.file_id);
          attachments.push({ type: "audio", url, mimeType: msg.voice.mime_type,
            duration: msg.voice.duration, platformRef: msg.voice.file_id });
        } catch (err) {
          debugLog()?.warn("bridge", `[telegram] voice 提取失败: ${errorMessage(err)}`);
        }
      }
      if (msg.video) {
        try {
          const url = await bot.getFileLink(msg.video.file_id);
          attachments.push({ type: "video", url, filename: msg.video.file_name,
            mimeType: msg.video.mime_type, duration: msg.video.duration,
            platformRef: msg.video.file_id });
        } catch (err) {
          debugLog()?.warn("bridge", `[telegram] video 提取失败: ${errorMessage(err)}`);
        }
      }

      if (!text && !attachments.length) return;
      if (!msg.from) return;

      const trimmed = text.length > MAX_MSG_SIZE
        ? (console.warn(`[telegram] 消息过大（${text.length} chars），已截断`), text.slice(0, MAX_MSG_SIZE))
        : text;

      const chatId = String(msg.chat.id);
      const userId = String(msg.from.id);
      const chatType = msg.chat.type; // "private" | "group" | "supergroup" | "channel"
      const isGroup = chatType !== "private";
      const sessionKey = isGroup ? `tg_group_${chatId}` : `tg_dm_${userId}`;

      onMessage({
        platform: "telegram",
        chatId,
        userId,
        sessionKey,
        text: trimmed,
        senderName: msg.from.first_name || "User",
        isGroup,
        attachments: attachments.length ? attachments : undefined,
      });
    });

    b.on("polling_error", (err) => {
      consecutiveErrors++;
      const errMsg = errorMessage(err);
      console.error("[telegram] polling error:", errMsg);
      debugLog()?.error("bridge", `telegram polling error (${consecutiveErrors}): ${errMsg}`);

      // 连续错误超过 3 次且没有 pending restart，尝试重建 polling
      if (consecutiveErrors >= 3 && !stopped && !restartTimer) {
        debugLog()?.warn("bridge", `telegram polling failed ${consecutiveErrors}x, restarting...`);
        scheduleRestart();
      }
    });
  }

  function scheduleRestart(): void {
    if (stopped || restartTimer) return;
    const delay = Math.min(5000 * consecutiveErrors, 30_000);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopped) return;
      const oldBot = bot;
      try {
        oldBot.removeAllListeners();
        await oldBot.stopPolling();
      } catch (e) {
        debugLog()?.warn("bridge", `telegram old bot cleanup: ${errorMessage(e)}`);
      }
      try {
        bot = new TelegramBot(token, { polling: true });
        attachListeners(bot);
        consecutiveErrors = 0;
        debugLog()?.log("bridge", "telegram polling restarted");
        onStatus?.("connected");
      } catch (err) {
        const msg = errorMessage(err);
        debugLog()?.error("bridge", `telegram restart failed: ${msg}`);
        onStatus?.("error", msg);
      }
    }, delay);
  }

  attachListeners(bot);

  /** 上次 block streaming 发送时间（用于 humanDelay） */
  let lastBlockTs = 0;

  return {
    async sendReply(chatId: string, text: string) {
      // Telegram 单条消息限制 4096 字符，超长时分段发送
      const MAX = 4096;
      for (let i = 0; i < text.length; i += MAX) {
        await bot.sendMessage(chatId, text.slice(i, i + MAX));
      }
    },

    /** block streaming 专用：发一条气泡，两条之间加 humanDelay */
    async sendBlockReply(chatId: string, text: string) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200; // 800~2000ms
      if (lastBlockTs && elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
      const MAX = 4096;
      for (let i = 0; i < text.length; i += MAX) {
        await bot.sendMessage(chatId, text.slice(i, i + MAX));
      }
      lastBlockTs = Date.now();
    },

    /** 流式草稿（Bot API 9.5 sendMessageDraft） */
    async sendDraft(chatId: string, text: string) {
      return bot._request("sendMessageDraft", {
        form: { chat_id: chatId, text },
      });
    },

    /** 发送媒体（根据 URL 扩展名自动选择发送方式） */
    async sendMedia(chatId: string, url: string) {
      const ext = safeExtFromUrl(url);
      const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
      const videoExts = ["mp4", "mov", "avi", "mkv"];
      const audioExts = ["mp3", "ogg", "wav", "m4a", "opus"];
      try {
        if (imageExts.includes(ext)) await bot.sendPhoto(chatId, url);
        else if (videoExts.includes(ext)) await bot.sendVideo(chatId, url);
        else if (audioExts.includes(ext)) await bot.sendAudio(chatId, url);
        else await bot.sendDocument(chatId, url);
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] sendMedia 失败 (${ext}): ${errorMessage(err)}`);
        throw err;
      }
    },

    /** 发送本地 Buffer（sendMediaFile 专用，无需公开 URL） */
    async sendMediaBuffer(chatId: string, buffer: Buffer, { mime, filename }: SendMediaBufferMeta) {
      try {
        const opts = { filename };
        if (mime.startsWith("image/")) await bot.sendPhoto(chatId, buffer, {}, opts);
        else if (mime.startsWith("video/")) await bot.sendVideo(chatId, buffer, {}, opts);
        else if (mime.startsWith("audio/")) await bot.sendAudio(chatId, buffer, {}, opts);
        else await bot.sendDocument(chatId, buffer, {}, opts);
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] sendMediaBuffer 失败 (${mime}): ${errorMessage(err)}`);
        throw err;
      }
    },

    stop(): void {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      bot.removeAllListeners();
      void bot.stopPolling();
    },

    /** 验证 token 有效性 */
    async getMe() {
      return bot.getMe();
    },
  };
}
