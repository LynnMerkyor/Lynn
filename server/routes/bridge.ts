/**
 * bridge.js — 外部平台接入 REST API
 *
 * 管理 Telegram / 飞书 / QQ 等外部消息平台的连接。
 */

import fs from "fs";
import path from "path";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { getWechatQrcode, pollWechatQrcodeStatus } from "../../lib/bridge/wechat-login.js";
import { debugLog } from "../../lib/debug-log.js";
import { parseSessionKey, collectKnownUsers, KNOWN_PLATFORMS } from "../../lib/bridge/session-key.js";
import { t } from "../i18n.js";

type BridgePlatform = string;

type BridgePlatformConfig = {
  enabled?: boolean;
  token?: string;
  appId?: string;
  appSecret?: string;
  appID?: string;
  appSecretLegacy?: string;
  botToken?: string;
  [key: string]: unknown;
};

type BridgePreferences = {
  telegram?: BridgePlatformConfig;
  feishu?: BridgePlatformConfig;
  qq?: BridgePlatformConfig;
  wechat?: BridgePlatformConfig;
  readOnly?: boolean;
  owner?: Record<string, string>;
  [platform: string]: BridgePlatformConfig | Record<string, string> | boolean | undefined;
};

type Preferences = {
  bridge?: BridgePreferences;
  [key: string]: unknown;
};

type BridgeIndexEntry = {
  file?: string;
  userId?: string;
  name?: string;
  avatarUrl?: string;
  [key: string]: unknown;
};

type BridgeIndex = Record<string, string | BridgeIndexEntry>;

type BridgeEngine = {
  lynnHome: string;
  homeCwd?: string;
  cwd?: string;
  agent: {
    sessionDir: string;
    deskManager?: { deskDir?: string };
  };
  getPreferences(): Preferences;
  savePreferences(prefs: Preferences): void;
  getBridgeIndex(): BridgeIndex;
  saveBridgeIndex(index: BridgeIndex): void;
};

type PlatformStatus = {
  status?: string;
  error?: unknown;
};

type BridgeManager = {
  getStatus(): Partial<Record<string, PlatformStatus>>;
  startPlatformFromConfig(platform: BridgePlatform, cfg: BridgePlatformConfig): unknown;
  stopPlatform(platform: BridgePlatform): unknown;
  getMessages(limit: number): unknown[];
  sendMediaFile(platform: BridgePlatform, chatId: string, filePath: string): Promise<unknown> | unknown;
};

type OwnerBody = {
  platform?: unknown;
  userId?: unknown;
};

type ConfigBody = {
  platform?: unknown;
  credentials?: unknown;
  enabled?: unknown;
};

type SettingsBody = {
  readOnly?: unknown;
};

type StopBody = {
  platform?: unknown;
};

type SendMediaBody = {
  platform?: unknown;
  chatId?: unknown;
  filePath?: unknown;
};

type TestCredentials = Record<string, string | undefined>;
type TelegramBotCtor = new (token: string) => {
  getMe(): Promise<{ username?: string; first_name?: string }>;
};

type TestBody = {
  platform?: unknown;
  credentials?: unknown;
};

type QrcodeStatusBody = {
  qrcodeId?: unknown;
};

type BridgeSessionMessage = {
  role?: unknown;
  content?: unknown;
};

type BridgeSessionLine = {
  type?: unknown;
  message?: BridgeSessionMessage;
  timestamp?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownPlatform(value: unknown): value is BridgePlatform {
  return typeof value === "string" && KNOWN_PLATFORMS.includes(value);
}

function asPlatformConfig(value: unknown): BridgePlatformConfig {
  return isRecord(value) ? value as BridgePlatformConfig : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadTelegramBot(): TelegramBotCtor {
  const require = createRequire(import.meta.url);
  const mod = require("node-telegram-bot-api") as TelegramBotCtor | { default?: TelegramBotCtor };
  return typeof mod === "function" ? mod : mod.default as TelegramBotCtor;
}

export function createBridgeRoute(engine: BridgeEngine, bridgeManager: BridgeManager) {
  const route = new Hono();

  /** 获取所有平台连接状态 */
  route.get("/bridge/status", async (c) => {
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const live = bridgeManager.getStatus();

    // 直接返回完整凭证（本地 app，不经过公网）
    const tgToken = bridge.telegram?.token || "";
    const fsAppId = bridge.feishu?.appId || "";
    const fsAppSecret = bridge.feishu?.appSecret || "";

    return c.json({
      telegram: {
        configured: !!tgToken,
        enabled: !!bridge.telegram?.enabled,
        status: live.telegram?.status || "disconnected",
        error: live.telegram?.error || null,
        token: tgToken,
      },
      feishu: {
        configured: !!(fsAppId && fsAppSecret),
        enabled: !!bridge.feishu?.enabled,
        status: live.feishu?.status || "disconnected",
        error: live.feishu?.error || null,
        appId: fsAppId,
        appSecret: fsAppSecret,
      },
      qq: {
        configured: !!(bridge.qq?.appID && (bridge.qq?.appSecret || bridge.qq?.token)),
        enabled: !!bridge.qq?.enabled,
        status: live.qq?.status || "disconnected",
        error: live.qq?.error || null,
        appID: bridge.qq?.appID || "",
        appSecret: bridge.qq?.appSecret || bridge.qq?.token || "",
      },
      wechat: {
        configured: !!bridge.wechat?.botToken,
        enabled: !!bridge.wechat?.enabled,
        status: live.wechat?.status || "disconnected",
        error: live.wechat?.error || null,
        token: bridge.wechat?.botToken || "",
      },
      readOnly: !!bridge.readOnly,
      knownUsers: collectKnownUsers(engine.getBridgeIndex()),
      owner: bridge.owner || {},
    });
  });

  /** 设置 owner（哪个账号是你） */
  route.post("/bridge/owner", async (c) => {
    const body = await safeJson<OwnerBody>(c);
    const { platform, userId } = body;
    if (!isKnownPlatform(platform)) {
      return c.json({ ok: false, error: "invalid platform" });
    }
    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    if (!prefs.bridge.owner) prefs.bridge.owner = {};
    if (typeof userId === "string" && userId) {
      prefs.bridge.owner[platform] = userId;
    } else {
      delete prefs.bridge.owner[platform];
    }
    engine.savePreferences(prefs);
    debugLog()?.log("api", `POST /api/bridge/owner platform=${platform} owner=${userId ? "[set]" : "[cleared]"}`);
    return c.json({ ok: true });
  });

  /** 保存凭证 + 启停平台 */
  route.post("/bridge/config", async (c) => {
    const body = await safeJson<ConfigBody>(c);
    const { platform, credentials, enabled } = body;
    if (!isKnownPlatform(platform)) {
      return c.json({ error: "invalid platform" }, 400);
    }

    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    if (!prefs.bridge[platform]) prefs.bridge[platform] = {};
    const platformPrefs = asPlatformConfig(prefs.bridge[platform]);
    prefs.bridge[platform] = platformPrefs;

    // 更新凭证
    if (isRecord(credentials)) {
      Object.assign(platformPrefs, credentials);
    }

    // 更新启用状态
    if (typeof enabled === "boolean") {
      platformPrefs.enabled = enabled;
    }

    engine.savePreferences(prefs);

    // 启停（委托给 bridgeManager，由 ADAPTER_REGISTRY 决定凭证提取逻辑）
    const cfg = platformPrefs;
    if (cfg.enabled) {
      bridgeManager.startPlatformFromConfig(platform, cfg);
    } else {
      bridgeManager.stopPlatform(platform);
    }

    debugLog()?.log("api", `POST /api/bridge/config platform=${platform} enabled=${!!cfg.enabled}`);
    return c.json({ ok: true });
  });

  /** 更新 bridge 全局设置（readOnly 等） */
  route.post("/bridge/settings", async (c) => {
    const body = await safeJson<SettingsBody>(c);
    const { readOnly } = body;
    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    if (typeof readOnly === "boolean") prefs.bridge.readOnly = readOnly;
    engine.savePreferences(prefs);
    debugLog()?.log("api", `POST /api/bridge/settings readOnly=${prefs.bridge.readOnly}`);
    return c.json({ ok: true });
  });

  /** 停止指定平台 */
  route.post("/bridge/stop", async (c) => {
    const body = await safeJson<StopBody>(c);
    const { platform } = body;
    if (typeof platform !== "string" || !platform) {
      return c.json({ error: "platform required" }, 400);
    }

    bridgeManager.stopPlatform(platform);

    // 同步更新 preferences
    const prefs = engine.getPreferences();
    const platformPrefs = asPlatformConfig(prefs.bridge?.[platform]);
    if (prefs.bridge?.[platform]) {
      platformPrefs.enabled = false;
      prefs.bridge[platform] = platformPrefs;
      engine.savePreferences(prefs);
    }

    debugLog()?.log("api", `POST /api/bridge/stop platform=${platform}`);
    return c.json({ ok: true });
  });

  /** 获取最近消息日志（实时内存缓冲） */
  route.get("/bridge/messages", async (c) => {
    const limit = parseInt(c.req.query("limit") || "", 10) || 50;
    return c.json({ messages: bridgeManager.getMessages(limit) });
  });

  /** 获取 bridge session 列表 */
  route.get("/bridge/sessions", async (c) => {
    const platform = c.req.query("platform"); // optional filter
    const index = engine.getBridgeIndex();
    const bridgeDir = path.join(engine.agent.sessionDir, "bridge");
    const prefs = engine.getPreferences();
    const owner = prefs.bridge?.owner || {};
    const sessions: Array<{
      sessionKey: string;
      platform: string;
      chatType: string | null;
      chatId: string | null;
      file: string;
      lastActive: number | null;
      displayName: string | null;
      avatarUrl: string | null;
      isOwner: boolean;
    }> = [];

    for (const [sessionKey, raw] of Object.entries(index)) {
      // 兼容旧格式（字符串）和新格式（对象）
      const entry: BridgeIndexEntry = typeof raw === "string" ? { file: raw } : raw;
      const file = entry.file;
      if (!file) continue;

      // 解析 sessionKey → 平台 + 类型
      const { platform: plat, chatType, chatId } = parseSessionKey(sessionKey);

      // 按平台过滤
      if (platform && plat !== platform) continue;

      // 获取最后修改时间
      let lastActive = null;
      const fp = path.join(bridgeDir, file);
      try {
        const stat = fs.statSync(fp);
        lastActive = stat.mtimeMs;
      } catch {
        // Missing or unreadable bridge files are treated as inactive metadata.
      }

      // isOwner 运行时计算：entry.userId 匹配 prefs.bridge.owner[platform]
      const ownerUserId = owner[plat] || null;
      const isOwner = !!(typeof entry.userId === "string" && ownerUserId && entry.userId === ownerUserId);

      sessions.push({
        sessionKey, platform: plat, chatType, chatId, file, lastActive,
        displayName: typeof entry.name === "string" ? entry.name : null,
        avatarUrl: typeof entry.avatarUrl === "string" ? entry.avatarUrl : null,
        isOwner,
      });
    }

    // 按最后活跃时间排序
    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return c.json({ sessions });
  });

  /** 读取指定 bridge session 的消息 */
  route.get("/bridge/sessions/:sessionKey/messages", async (c) => {
    const sessionKey = c.req.param("sessionKey");
    const index = engine.getBridgeIndex();
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) return c.json({ error: "session not found", messages: [] });

    const bridgeDir = path.join(engine.agent.sessionDir, "bridge");
    const fp = path.resolve(bridgeDir, file);

    // 防止 path traversal
    if (!fp.startsWith(path.resolve(bridgeDir) + path.sep)) {
      return c.json({ error: "invalid session path", messages: [] });
    }

    try {
      const rawContent = fs.readFileSync(fp, "utf-8");
      const lines = rawContent.trim().split("\n").map(l => {
        try { return JSON.parse(l) as BridgeSessionLine; } catch { return null; }
      }).filter((line): line is BridgeSessionLine => Boolean(line));

      const messages: Array<{
        role: "user" | "assistant";
        content: string;
        hasMedia: boolean;
        mediaCount: number;
        ts: unknown;
      }> = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

        let textContent = "";
        let mediaCount = 0;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (!isRecord(b)) continue;
            if (b.type === "text" && typeof b.text === "string") textContent += b.text;
            if (b.type === "image") mediaCount++;
          }
        } else if (typeof msg.content === "string") {
          textContent = msg.content;
        }

        const hasMedia = mediaCount > 0;
        if (!textContent && !hasMedia) continue;
        messages.push({
          role: msg.role,
          content: textContent || (hasMedia ? `[图片 x${mediaCount}]` : ""),
          hasMedia,
          mediaCount,
          ts: line.timestamp || null,
        });
      }

      return c.json({ messages });
    } catch (err) {
      return c.json({ error: errorMessage(err), messages: [] });
    }
  });

  /** 重置 bridge session（清除上下文，下次消息新建 session） */
  route.post("/bridge/sessions/:sessionKey/reset", async (c) => {
    const sessionKey = c.req.param("sessionKey");
    const index = engine.getBridgeIndex();
    const raw = index[sessionKey];
    if (!raw) return c.json({ ok: false, error: "session not found" });

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry: BridgeIndexEntry = typeof raw === "string" ? {} : { ...raw };
    delete entry.file;
    index[sessionKey] = entry;
    engine.saveBridgeIndex(index);

    return c.json({ ok: true });
  });

  /** 发送媒体到 bridge 平台（桌面端推送文件） */
  route.post("/bridge/send-media", async (c) => {
    const body = await safeJson<SendMediaBody>(c);
    const { platform, chatId, filePath } = body;
    if (typeof platform !== "string" || typeof chatId !== "string" || typeof filePath !== "string") {
      return c.json({ error: "platform, chatId, filePath required" }, 400);
    }

    // 路径安全检查（对齐 fs.js 的 getAllowedRoots 逻辑）
    const hanaHome = path.resolve(engine.lynnHome);
    const allowedRoots = [hanaHome];
    const deskHome = engine.agent?.deskManager?.deskDir;
    if (deskHome) allowedRoots.push(path.resolve(deskHome));
    if (engine.homeCwd) allowedRoots.push(path.resolve(engine.homeCwd));
    if (engine.cwd) allowedRoots.push(path.resolve(engine.cwd));

    // 先检查文件是否存在
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return c.json({ error: "file not found" }, 404);
    }

    // 用 realpathSync 解析 symlink，防止 symlink 绕过白名单
    let realPath: string;
    try { realPath = fs.realpathSync(resolved); }
    catch { return c.json({ error: "file not found" }, 404); }

    const isSafe = allowedRoots.some(root =>
      realPath === root || realPath.startsWith(root + path.sep)
    );
    if (!isSafe) {
      return c.json({ error: "path outside allowed roots" }, 403);
    }

    // Fix 3: 文件大小保护（50MB 上限，避免同步读大文件卡事件循环）
    const MAX_MEDIA_SIZE = 50 * 1024 * 1024;
    try {
      const stat = fs.statSync(realPath);
      if (stat.size > MAX_MEDIA_SIZE) {
        return c.json({ error: `file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` }, 413);
      }
    } catch { return c.json({ error: "file not found" }, 404); }

    try {
      await bridgeManager.sendMediaFile(platform, chatId, realPath);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  /** 测试凭证（不启动轮询） */
  route.post("/bridge/test", async (c) => {
    const body = await safeJson<TestBody>(c);
    const { platform, credentials } = body;
    if (typeof platform !== "string" || !isRecord(credentials)) {
      return c.json({ error: "platform and credentials required" }, 400);
    }

    if (!isKnownPlatform(platform)) {
      return c.json({ error: "unknown platform" }, 400);
    }

    const typedCredentials = credentials as TestCredentials;

    try {
      if (platform === "telegram") {
        const TelegramBot = loadTelegramBot();
        const bot = new TelegramBot(String(typedCredentials.token || ""));
        const me = await bot.getMe();
        return c.json({ ok: true, info: { username: me.username, name: me.first_name } });
      } else if (platform === "feishu") {
        const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: typedCredentials.appId,
            app_secret: typedCredentials.appSecret,
          }),
        });
        const data = await resp.json() as { code?: number; msg?: string };
        if (data.code === 0) {
          return c.json({ ok: true, info: { msg: t("error.tokenSuccess") } });
        }
        return c.json({ ok: false, error: data.msg || t("error.verifyFailed") });
      } else if (platform === "qq") {
        // v2 鉴权：appID + appSecret → access_token → /users/@me
        const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: typedCredentials.appID, clientSecret: typedCredentials.appSecret }),
        });
        const tokenData = await tokenRes.json() as { access_token?: string; message?: string };
        if (!tokenData.access_token) {
          return c.json({ ok: false, error: tokenData.message || t("error.tokenFetchFailed") });
        }
        const meRes = await fetch("https://api.sgroup.qq.com/users/@me", {
          headers: { Authorization: `QQBot ${tokenData.access_token}` },
        });
        const me = await meRes.json() as { id?: string; username?: string; message?: string };
        if (me.id) {
          return c.json({ ok: true, info: { username: me.username, name: me.username } });
        }
        return c.json({ ok: false, error: me.message || t("error.botInfoFailed") });
      }
      if (platform === "wechat") {
        // 用 getconfig 验证 token（不污染 cursor）
        const crypto = await import("node:crypto");
        const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
        const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/getconfig", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "Authorization": `Bearer ${typedCredentials.botToken || ""}`,
            "X-WECHAT-UIN": uin,
          },
          body: JSON.stringify({ base_info: { channel_version: "1.0.0" } }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json() as { ret?: number; errmsg?: string };
        if (data.ret && data.ret !== 0) {
          return c.json({ ok: false, error: data.errmsg || `errcode ${data.ret}` });
        }
        return c.json({ ok: true, info: { msg: "微信 iLink 连接成功" } });
      }
      return c.json({ ok: false, error: t("error.platformTestUnsupported") });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) });
    }
  });

  /** 获取微信扫码登录二维码 */
  route.post("/bridge/wechat/qrcode", async (c) => {
    return c.json(await getWechatQrcode());
  });

  /** 轮询微信扫码状态 */
  route.post("/bridge/wechat/qrcode-status", async (c) => {
    const body = await safeJson<QrcodeStatusBody>(c);
    const { qrcodeId } = body;
    return c.json(await pollWechatQrcodeStatus(asString(qrcodeId) || ""));
  });

  return route;
}
