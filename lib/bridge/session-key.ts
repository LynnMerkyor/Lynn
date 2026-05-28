/**
 * session-key.ts — bridge sessionKey 解析工具
 *
 * 从 sessionKey 中提取平台、聊天类型、chatId。
 * 数据驱动：新增平台只需在 SESSION_PREFIX_MAP 注册前缀。
 */

export type BridgePlatform = "telegram" | "feishu" | "qq" | "wechat";
export type BridgeChatType = "dm" | "group";

export type ParsedSessionKey = {
  platform: BridgePlatform | "unknown";
  chatType: BridgeChatType;
  chatId: string;
};

export type KnownBridgeUser = {
  userId: string;
  name: string | null;
};

type BridgeIndexEntry = {
  file?: string;
  userId?: string;
  name?: string | null;
};

export type BridgeIndex = Record<string, string | BridgeIndexEntry>;

// sessionKey 前缀 → [platform, chatType]
export const SESSION_PREFIX_MAP: Array<[string, BridgePlatform, BridgeChatType]> = [
  ["tg_dm_",       "telegram", "dm"],
  ["tg_group_",    "telegram", "group"],
  ["fs_dm_",       "feishu",   "dm"],
  ["fs_group_",    "feishu",   "group"],
  ["qq_dm_",       "qq",       "dm"],
  ["qq_group_",    "qq",       "group"],
  ["wx_dm_",       "wechat",   "dm"],
];

/** 已知平台列表（从前缀表去重） */
export const KNOWN_PLATFORMS: string[] = [...new Set(SESSION_PREFIX_MAP.map(([, p]) => p))];

/** 从 sessionKey 解析平台 + 类型 + chatId */
export function parseSessionKey(sessionKey: string): ParsedSessionKey {
  for (const [prefix, platform, chatType] of SESSION_PREFIX_MAP) {
    if (sessionKey.startsWith(prefix)) {
      return { platform, chatType, chatId: sessionKey.slice(prefix.length) };
    }
  }
  return { platform: "unknown", chatType: "dm", chatId: sessionKey };
}

/**
 * 从 bridge index 中按 userId 去重收集已知用户
 * @param index - bridge-index.json 的内容
 */
export function collectKnownUsers(index: BridgeIndex): Partial<Record<BridgePlatform, KnownBridgeUser[]>> {
  const byPlatform: Partial<Record<BridgePlatform, Map<string, KnownBridgeUser>>> = {};

  for (const [sessionKey, raw] of Object.entries(index)) {
    const entry = typeof raw === "string" ? { file: raw } : raw;
    if (!entry.userId) continue;

    const { platform } = parseSessionKey(sessionKey);
    if (platform === "unknown") continue;

    if (!byPlatform[platform]) byPlatform[platform] = new Map<string, KnownBridgeUser>();
    const map = byPlatform[platform];
    if (!map) continue;
    if (!map.has(entry.userId) || entry.name) {
      map.set(entry.userId, { userId: entry.userId, name: entry.name || null });
    }
  }

  const result: Partial<Record<BridgePlatform, KnownBridgeUser[]>> = {};
  for (const platform of Object.keys(byPlatform) as BridgePlatform[]) {
    const map = byPlatform[platform];
    if (map) result[platform] = [...map.values()];
  }
  return result;
}
