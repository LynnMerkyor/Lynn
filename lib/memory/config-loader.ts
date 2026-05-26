/**
 * config-loader.js — per-agent config.yaml 加载与保存
 *
 * 职责单一：读写 agent 的 config.yaml，提供缓存和原子写入。
 * 不做凭证解析（运行时凭证解析走 ProviderRegistry / AuthStore）。
 *
 * 支持三通道 API 区块：
 *   api          → 主通道（chat / summarizer / compiler）
 *   embedding_api → Embedding 专用通道（可选）
 *   utility_api   → 工具模型通道（可选）
 */

import fs from "fs";
import YAML from "js-yaml";

export type ConfigObject = Record<string, unknown>;

export interface ApiBlock {
  provider: string;
  api_key: string;
  base_url: string;
  api?: string;
}

interface CacheEntry {
  cached: ConfigObject & {
    api: ApiBlock;
    embedding_api: ApiBlock | null;
    utility_api: ApiBlock | null;
  };
  cachedRaw: unknown;
}

// 按路径缓存，防止跨 agent 污染
const _cache = new Map<string, CacheEntry>(); // configPath → { cached, cachedRaw }

function isRecord(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析一个 API 区块（仅返回 config.yaml 中的原始值）
 * @private
 */
function resolveApi(block: unknown): ApiBlock | null {
  if (!block) return null;
  const raw = isRecord(block) ? block : {};

  return {
    provider: typeof raw.provider === "string" ? raw.provider.trim() : "",
    api_key: typeof raw.api_key === "string" ? raw.api_key : "",
    base_url: typeof raw.base_url === "string" ? raw.base_url : "",
    api: typeof raw.api === "string" ? raw.api : "",
  };
}

/**
 * 加载并返回完整配置
 * @param {string} configPath - config.yaml 的路径
 * @returns {object} 解析后的配置对象，包含 api 和 embedding_api
 */
export function loadConfig(configPath: string): CacheEntry["cached"] {
  const entry = _cache.get(configPath);
  if (entry) return entry.cached;

  const loaded = YAML.load(fs.readFileSync(configPath, "utf-8"));
  const raw = isRecord(loaded) ? loaded : {};
  const cachedRaw = structuredClone(raw);  // 保存原始配置（resolve 前）

  // API 通道（仅提取 config.yaml 中的原始值，UI 展示用）
  const api = resolveApi(raw.api) || { provider: "", api_key: "", base_url: "" };

  // Embedding 专用通道（可选）
  const embeddingApi = resolveApi(raw.embedding_api);

  // Utility 通道（工具模型，可选）
  const utilityApi = resolveApi(raw.utility_api);

  const cached = {
    ...raw,
    api,
    embedding_api: embeddingApi,
    utility_api: utilityApi,
  };

  _cache.set(configPath, { cached, cachedRaw });
  return cached;
}

/** 清除缓存（指定路径或全部） */
export function clearConfigCache(configPath?: string): void {
  if (configPath) {
    _cache.delete(configPath);
  } else {
    _cache.clear();
  }
}

/** 返回原始配置（未经 resolveApi 处理）。需要传 configPath 来定位缓存 */
export function getRawConfig(configPath?: string): unknown {
  if (configPath) {
    return _cache.get(configPath)?.cachedRaw ?? null;
  }
  // 兼容：不传参时返回最近一个有 cachedRaw 的 entry
  for (const entry of _cache.values()) {
    if (entry.cachedRaw) return entry.cachedRaw;
  }
  return null;
}

/**
 * 深度合并：把 source 的非 undefined 值递归写入 target
 * 只合并 plain object，数组和原始值直接覆盖
 * source[key] === null 时删除 target[key]（用于供应商删除等场景）
 */
function deepMerge(target: ConfigObject, source: ConfigObject): ConfigObject {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    // null = 删除这个 key
    if (sv === null) {
      delete out[key];
      continue;
    }
    const tv = target[key];
    if (isRecord(sv) && isRecord(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

/**
 * 保存配置：读取当前 raw → 合并 partial → 写回 YAML → 清缓存
 * 使用 atomic write（tmp + rename），防止写到一半崩溃损坏配置文件
 * @param {string} configPath - config.yaml 路径
 * @param {object} partial - 要更新的字段（深度合并）
 */
export function saveConfig(configPath: string, partial: ConfigObject): void {
  // 始终从磁盘重新读取，防止并发编辑丢失
  const loaded = YAML.load(fs.readFileSync(configPath, "utf-8"));
  const current = isRecord(loaded) ? loaded : {};
  const merged = deepMerge(current, partial);

  const header =
    "# Lynn 系统配置\n" +
    "# 由设置页面管理，手动编辑也可以\n\n";
  const yamlStr = header + YAML.dump(merged, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    quotingType: "\"",
    forceQuotes: false,
  });

  // atomic write：先写临时文件再 rename，防止写到一半崩溃损坏配置
  const tmpPath = configPath + ".tmp";
  fs.writeFileSync(tmpPath, yamlStr, "utf-8");
  fs.renameSync(tmpPath, configPath);
  clearConfigCache();
}
