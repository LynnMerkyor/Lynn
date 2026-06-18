/**
 * migrate-providers.ts — 一次性迁移旧数据到 added-models.yaml
 *
 * 运行时机：engine.init() 启动时，model init 之前
 * 幂等：added-models.yaml 中 _migrated: true 存在则跳过
 *
 * 迁移源：
 *   1. per-agent config.yaml 的 providers 块
 *   2. per-agent config.yaml 的 api.api_key / api.base_url
 *   3. preferences.json 的 favorites 数组
 *   4. preferences.json 的 oauth_custom_models 对象
 *   5. providers.yaml 重命名（v0.69+ 文件改名迁移）
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { fromRoot } from "../shared/hana-root.js";
import {
  BRAIN_CHAT_MODEL_ID,
  BRAIN_COMPILER_MODEL_ID,
  BRAIN_PROVIDER_ID,
  BRAIN_SUMMARIZER_MODEL_ID,
  BRAIN_UTILITY_LARGE_MODEL_ID,
  BRAIN_UTILITY_MODEL_ID,
} from "../shared/brain-provider.js";
import type { LLMApi, ProviderConfig, ProviderConfigMap } from "./types.js";

type LogFn = (msg: string) => void;
type MutableRecord = Record<string, unknown>;
type DefaultModelsIndex = Record<string, string[] | string>;
type AddedModelsYaml = MutableRecord & {
  _migrated?: unknown;
  providers?: ProviderConfigMap;
};
type AgentApiConfig = MutableRecord & {
  api_key?: unknown;
  base_url?: unknown;
  provider?: unknown;
};
type AgentConfig = MutableRecord & {
  providers?: unknown;
  api?: unknown;
  models?: unknown;
};
type AgentConfigEntry = {
  id: string;
  path: string;
  config: AgentConfig;
};
type PreferencesJson = MutableRecord & {
  favorites?: unknown;
  oauth_custom_models?: unknown;
};
type ModelRefObject = MutableRecord & {
  id?: unknown;
  provider?: unknown;
};

const _defaultModels = JSON.parse(
  fs.readFileSync(fromRoot("lib", "default-models.json"), "utf-8"),
) as DefaultModelsIndex;

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAddedModelsYaml(value: unknown): AddedModelsYaml {
  return isRecord(value) ? value : {};
}

function getProvidersMap(raw: AddedModelsYaml): ProviderConfigMap {
  return isRecord(raw.providers) ? raw.providers as ProviderConfigMap : {};
}

function getAgentApi(config: AgentConfig): AgentApiConfig | null {
  return isRecord(config.api) ? config.api as AgentApiConfig : null;
}

function getAgentProviders(config: AgentConfig): MutableRecord | null {
  return isRecord(config.providers) ? config.providers : null;
}

function getAgentModels(config: AgentConfig): MutableRecord | null {
  return isRecord(config.models) ? config.models : null;
}

function ensureAgentModels(config: AgentConfig): MutableRecord {
  if (!isRecord(config.models)) config.models = {};
  return config.models as MutableRecord;
}

function ensureProvider(providers: ProviderConfigMap, providerName: string): ProviderConfig {
  if (!isRecord(providers[providerName])) providers[providerName] = {};
  return providers[providerName];
}

function modelEntryId(model: unknown): string | null {
  if (typeof model === "string") return model;
  if (isRecord(model) && typeof model.id === "string") return model.id;
  return null;
}

function hasModelId(models: unknown, modelId: string): boolean {
  return Array.isArray(models) && models.some((model) => modelEntryId(model) === modelId);
}

/** 反查 default-models.json：模型 ID → provider name */
function resolveProviderForModel(modelId: string): string | null {
  for (const [provider, models] of Object.entries(_defaultModels)) {
    if ((Array.isArray(models) || typeof models === "string") && models.includes(modelId)) return provider;
  }
  return null;
}

// ── 原子写入工具 ──────────────────────────────────────────────────────────────

function atomicWriteYAML(filePath: string, data: unknown, header = ""): void {
  const yamlStr = header + YAML.dump(data, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    quotingType: "\"",
    forceQuotes: false,
  });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, yamlStr, "utf-8");
  fs.renameSync(tmp, filePath);
}

function atomicWriteJSON(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
}

// ── 主迁移函数 ────────────────────────────────────────────────────────────────

/**
 * 将旧数据整合到 added-models.yaml（幂等，只跑一次）
 *
 */
export function migrateToProvidersYaml(lynnHome: string, agentsDir: string, log: LogFn = () => {}): void {
  const providersPath = path.join(lynnHome, "added-models.yaml");
  const prefsPath = path.join(lynnHome, "user", "preferences.json");

  // ── 文件改名迁移：providers.yaml → added-models.yaml ──
  const oldPath = path.join(lynnHome, "providers.yaml");
  if (fs.existsSync(oldPath) && !fs.existsSync(providersPath)) {
    fs.renameSync(oldPath, providersPath);
    log("[migrate-providers] providers.yaml → added-models.yaml 重命名完成");
  }

  // ── 快速路径：已迁移则立即返回 ──
  const existingRaw = toAddedModelsYaml(safeReadYAMLSync(providersPath, null, YAML));
  if (existingRaw?._migrated) return;

  // ── 检测是否有任何需要迁移的数据 ──
  const agentConfigs = _collectAgentConfigs(agentsDir);
  const prefs = _readPrefs(prefsPath);

  const favorites = Array.isArray(prefs.favorites) ? prefs.favorites : [];
  const oauthCustomModels = isRecord(prefs.oauth_custom_models) ? prefs.oauth_custom_models : null;
  const hasAgentProviders = agentConfigs.some(ac => Boolean(getAgentProviders(ac.config)));
  const hasAgentApiKey = agentConfigs.some(ac => Boolean(getAgentApi(ac.config)?.api_key));
  const hasFavorites = favorites.length > 0;
  const hasOAuthCustom = oauthCustomModels !== null && Object.keys(oauthCustomModels).length > 0;

  if (!hasAgentProviders && !hasAgentApiKey && !hasFavorites && !hasOAuthCustom) {
    // 没有需要迁移的数据，写标记后返回
    const data = existingRaw;
    data._migrated = true;
    const header =
      "# Lynn 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    atomicWriteYAML(providersPath, data, header);
    log("[migrate-providers] 无旧数据需要迁移，已标记完成");
    return;
  }

  log("[migrate-providers] 检测到旧配置数据，开始迁移...");

  // ── 读取 added-models.yaml 当前内容 ──
  const raw = existingRaw;
  const providers = getProvidersMap(raw);

  // ── Source 1: per-agent config.yaml providers 块 ──
  for (const ac of agentConfigs) {
    const agentProviders = getAgentProviders(ac.config);
    if (!agentProviders) continue;

    for (const [name, block] of Object.entries(agentProviders)) {
      if (!isRecord(block)) continue;
      const providerConfig = ensureProvider(providers, name);

      // 合并凭证：不覆盖已有值
      if (typeof block.api_key === "string" && block.api_key && !providerConfig.api_key) {
        providerConfig.api_key = block.api_key;
      }
      if (typeof block.base_url === "string" && block.base_url && !providerConfig.base_url) {
        providerConfig.base_url = block.base_url;
      }
      if (typeof block.api === "string" && block.api && !providerConfig.api) {
        providerConfig.api = block.api as LLMApi;
      }

      log(`[migrate-providers] agent "${ac.id}": providers.${name} → added-models.yaml`);
    }
  }

  // ── Source 2: per-agent config.yaml inline api credentials ──
  for (const ac of agentConfigs) {
    const api = getAgentApi(ac.config);
    if (!api?.api_key) continue;

    const providerName = api.provider;
    if (typeof providerName !== "string" || !providerName) continue;

    const providerConfig = ensureProvider(providers, providerName);

    if (typeof api.api_key === "string" && !providerConfig.api_key) {
      providerConfig.api_key = api.api_key;
    }
    if (typeof api.base_url === "string" && api.base_url && !providerConfig.base_url) {
      providerConfig.base_url = api.base_url;
    }

    log(`[migrate-providers] agent "${ac.id}": api.api_key (${providerName}) → added-models.yaml`);
  }

  // ── Source 3: preferences.json favorites ──
  if (hasFavorites) {
    for (const fav of favorites) {
      const favorite = normalizeFavorite(fav);
      if (!favorite) continue;

      const { modelId } = favorite;
      let provider = favorite.provider;

      // 尝试从 added-models.yaml 中已有的模型列表找 provider
      if (!provider) {
        for (const [pName, pConf] of Object.entries(providers)) {
          if (isRecord(pConf) && hasModelId(pConf.models, modelId)) {
            provider = pName;
            break;
          }
        }
      }

      // 从 default-models.json 反查
      if (!provider) {
        provider = resolveProviderForModel(modelId);
      }

      if (!provider) {
        log(`[migrate-providers] favorites: 无法确定 "${modelId}" 的 provider，跳过`);
        continue;
      }

      _addModelToProvider(providers, provider, modelId);
      log(`[migrate-providers] favorites: "${modelId}" → added-models.yaml (${provider})`);
    }
  }

  // ── Source 4: preferences.json oauth_custom_models ──
  if (hasOAuthCustom) {
    for (const [provider, modelIds] of Object.entries(oauthCustomModels)) {
      if (!Array.isArray(modelIds)) continue;
      for (const modelId of modelIds) {
        if (typeof modelId !== "string" || !modelId) continue;
        _addModelToProvider(providers, provider, modelId);
        log(`[migrate-providers] oauth_custom_models: "${modelId}" → added-models.yaml (${provider})`);
      }
    }
  }

  // ── 写入 added-models.yaml ──
  raw.providers = providers;
  raw._migrated = true;
  const header =
    "# Lynn 供应商配置（全局，跨 agent 共享）\n" +
    "# 由设置页面管理\n\n";
  atomicWriteYAML(providersPath, raw, header);
  log("[migrate-providers] added-models.yaml 已更新");

  // ── 清理旧数据 ──

  // 清理 agent config.yaml
  for (const ac of agentConfigs) {
    let changed = false;

    // 删除 providers 块
    if (getAgentProviders(ac.config)) {
      delete ac.config.providers;
      changed = true;
    }

    // 删除 api.api_key（保留 api.provider）
    const api = getAgentApi(ac.config);
    if (api?.api_key) {
      delete api.api_key;
      // 如果同时有 base_url，也清理（已迁移到 added-models.yaml）
      if (api.base_url) {
        delete api.base_url;
      }
      changed = true;
    }

    if (changed) {
      atomicWriteYAML(ac.path, ac.config);
      log(`[migrate-providers] 已清理 ${ac.id}/config.yaml`);
    }
  }

  // 清理 preferences.json
  if (hasFavorites || hasOAuthCustom) {
    if (hasFavorites) delete prefs.favorites;
    if (hasOAuthCustom) delete prefs.oauth_custom_models;
    atomicWriteJSON(prefsPath, prefs);
    log("[migrate-providers] 已清理 preferences.json (favorites, oauth_custom_models)");
  }

  log("[migrate-providers] 迁移完成");
}

// ── Local Qwen 默认模型迁移 ───────────────────────────────────────────────────

const LOCAL_QWEN_9B_MTP_DEFAULT_FLAG = "local_qwen_default_9b_mtp_default_v2";
// 2026-05-25: 默认本地模型回到 Qwen3.5-9B Q4_K_M imatrix MTP。
// 4B imatrix 只保留为低配降级档,因为 thinking-on 会空正文长思考。
const OLD_LOCAL_QWEN_PROVIDER = "local-qwen3-4b-thinking-2507-q4km-imatrix";
const OLD_LOCAL_QWEN_MODEL = "qwen3-4b-thinking-2507-q4km-imatrix";
const LOCAL_QWEN_4B_PROVIDER = "local-qwen35-4b-q4km";
const LOCAL_QWEN_4B_MODEL = "qwen35-4b-q4km";
const NEW_LOCAL_QWEN_PROVIDER = "local-qwen35-9b-q4km-imatrix";
const NEW_LOCAL_QWEN_MODEL = "qwen35-9b-q4km-imatrix";

function _localQwen9BProviderSeed(oldProvider: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    display_name: "本地 Qwen3.5-9B",
    base_url: oldProvider.base_url || "http://127.0.0.1:18099/v1",
    api: oldProvider.api || "openai-completions",
    auth_type: "none",
    models: [
      {
        id: NEW_LOCAL_QWEN_MODEL,
        name: "Qwen3.5-9B Q4_K_M imatrix MTP",
        context: 32768,
        maxOutput: 32768,
      },
    ],
  };
}

function _migrateChatRef(chat: unknown): unknown {
  if (typeof chat === "string") {
    return (chat === OLD_LOCAL_QWEN_MODEL || chat === LOCAL_QWEN_4B_MODEL) ? NEW_LOCAL_QWEN_MODEL : chat;
  }
  if (!isRecord(chat)) return chat;
  const isOldLocal =
    chat.id === OLD_LOCAL_QWEN_MODEL
    || chat.provider === OLD_LOCAL_QWEN_PROVIDER
    || chat.id === LOCAL_QWEN_4B_MODEL
    || chat.provider === LOCAL_QWEN_4B_PROVIDER;
  return isOldLocal
    ? { ...chat, id: NEW_LOCAL_QWEN_MODEL, provider: NEW_LOCAL_QWEN_PROVIDER }
    : chat;
}

// ── OpenHanako 污染数据自愈 ───────────────────────────────────────────────────

const RETIRED_HANAKO_MODEL_REPAIR_VERSION = "retired_hanako_model_refs_repaired_v1";
const RETIRED_MODEL_ROLE_KEYS = ["chat", "utility", "utility_large", "utilityLarge", "summarizer", "compiler"] as const;
const RETIRED_SHARED_MODEL_PREFS = [
  ["utility", "utility_model"],
  ["utility_large", "utility_large_model"],
  ["summarizer", "summarizer_model"],
  ["compiler", "compiler_model"],
] as const;

function normalizeModelId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function getModelRefId(ref: unknown): string | null {
  if (typeof ref === "string") return ref.trim() || null;
  if (isRecord(ref) && typeof ref.id === "string") return ref.id.trim() || null;
  return null;
}

function isRetiredHanakoModelId(modelId: unknown): boolean {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return false;
  const tail = normalized.includes("/") ? normalized.split("/").pop() || normalized : normalized;

  if (tail === "token-plan-cn") return true;
  return false;
}

function isRetiredModelRef(ref: unknown): boolean {
  const id = getModelRefId(ref);
  return Boolean(id && isRetiredHanakoModelId(id));
}

function brainModelRefForRole(role: string): ModelRefObject {
  if (role === "utility_large" || role === "utilityLarge") {
    return { id: BRAIN_UTILITY_LARGE_MODEL_ID, provider: BRAIN_PROVIDER_ID };
  }
  if (role === "summarizer") return { id: BRAIN_SUMMARIZER_MODEL_ID, provider: BRAIN_PROVIDER_ID };
  if (role === "compiler") return { id: BRAIN_COMPILER_MODEL_ID, provider: BRAIN_PROVIDER_ID };
  if (role === "utility") return { id: BRAIN_UTILITY_MODEL_ID, provider: BRAIN_PROVIDER_ID };
  return { id: BRAIN_CHAT_MODEL_ID, provider: BRAIN_PROVIDER_ID };
}

function compactRetiredModelList(models: unknown): { models: unknown; removed: number } {
  if (!Array.isArray(models)) return { models, removed: 0 };
  const next = models.filter((model) => !isRetiredHanakoModelId(modelEntryId(model)));
  return { models: next, removed: models.length - next.length };
}

function repairAgentModelRefs(ac: AgentConfigEntry): boolean {
  const models = getAgentModels(ac.config);
  if (!models) return false;

  let changed = false;
  let repairedChat = false;
  for (const key of RETIRED_MODEL_ROLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(models, key)) continue;
    const current = models[key];
    if (!isRetiredModelRef(current)) continue;
    models[key] = brainModelRefForRole(key);
    changed = true;
    if (key === "chat") repairedChat = true;
  }

  const api = getAgentApi(ac.config);
  if (repairedChat && api && api.provider !== BRAIN_PROVIDER_ID) {
    api.provider = BRAIN_PROVIDER_ID;
    changed = true;
  }

  return changed;
}

function repairSharedModelPrefs(prefs: PreferencesJson): boolean {
  let changed = false;
  for (const [role, prefKey] of RETIRED_SHARED_MODEL_PREFS) {
    if (!Object.prototype.hasOwnProperty.call(prefs, prefKey)) continue;
    if (!isRetiredModelRef(prefs[prefKey])) continue;
    prefs[prefKey] = brainModelRefForRole(role);
    changed = true;
  }
  return changed;
}

function repairFavoritePrefs(prefs: PreferencesJson): boolean {
  let changed = false;
  if (Array.isArray(prefs.favorites)) {
    const next = prefs.favorites.filter((favorite) => {
      const normalized = normalizeFavorite(favorite);
      return !normalized || !isRetiredHanakoModelId(normalized.modelId);
    });
    if (next.length !== prefs.favorites.length) {
      if (next.length) prefs.favorites = next;
      else delete prefs.favorites;
      changed = true;
    }
  }

  if (isRecord(prefs.oauth_custom_models)) {
    const nextCustom: Record<string, string[]> = {};
    let removed = 0;
    for (const [provider, value] of Object.entries(prefs.oauth_custom_models)) {
      if (!Array.isArray(value)) continue;
      const next = value.filter((modelId) => !isRetiredHanakoModelId(modelId));
      removed += value.length - next.length;
      if (next.length) nextCustom[provider] = next.map(String);
    }
    if (removed > 0) {
      if (Object.keys(nextCustom).length) prefs.oauth_custom_models = nextCustom;
      else delete prefs.oauth_custom_models;
      changed = true;
    }
  }
  return changed;
}

function repairSessionMetaFile(metaPath: string): boolean {
  let meta: unknown;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return false;
  }
  if (!isRecord(meta)) return false;

  let changed = false;
  for (const entry of Object.values(meta)) {
    if (!isRecord(entry)) continue;
    const rawRef = isRecord(entry.model)
      ? entry.model
      : (typeof entry.modelId === "string" ? { id: entry.modelId, provider: entry.modelProvider } : null);
    if (!isRetiredModelRef(rawRef)) continue;
    const next = brainModelRefForRole("chat");
    entry.model = next;
    entry.modelId = next.id;
    entry.modelProvider = next.provider;
    changed = true;
  }

  if (changed) atomicWriteJSON(metaPath, meta);
  return changed;
}

function repairSessionMetaFiles(agentsDir: string): number {
  let changed = 0;
  for (const ac of _collectAgentConfigs(agentsDir)) {
    const metaPath = path.join(path.dirname(ac.path), "sessions", "session-meta.json");
    if (!fs.existsSync(metaPath)) continue;
    if (repairSessionMetaFile(metaPath)) changed += 1;
  }
  return changed;
}

/**
 * 旧版自动复制 OpenHanako 数据后, ~/.lynn 里可能残留指向已下线 MiMo/Token Plan
 * 模型的 agent/shared/session/provider 引用。这里只修明确失效的模型 ID,保留用户
 * provider 凭证与其他模型,并回到免 Key 的 Brain 默认路由。
 */
export function repairRetiredModelReferences(lynnHome: string, agentsDir: string, log: LogFn = () => {}): void {
  const providersPath = path.join(lynnHome, "added-models.yaml");
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  let changedAgents = 0;
  let removedProviderModels = 0;
  let changedProviders = false;

  for (const ac of _collectAgentConfigs(agentsDir)) {
    if (!repairAgentModelRefs(ac)) continue;
    atomicWriteYAML(ac.path, ac.config);
    changedAgents += 1;
  }

  const raw = toAddedModelsYaml(safeReadYAMLSync(providersPath, {}, YAML));
  const providers = getProvidersMap(raw);
  for (const providerConfig of Object.values(providers)) {
    if (!isRecord(providerConfig)) continue;
    const compacted = compactRetiredModelList(providerConfig.models);
    if (compacted.removed <= 0) continue;
    providerConfig.models = compacted.models as ProviderConfig["models"];
    removedProviderModels += compacted.removed;
    changedProviders = true;
  }
  if (changedProviders) {
    raw.providers = providers;
    const header =
      "# Lynn 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    atomicWriteYAML(providersPath, raw, header);
  }

  const prefs = _readPrefs(prefsPath);
  const sharedPrefsChanged = repairSharedModelPrefs(prefs);
  const favoritePrefsChanged = repairFavoritePrefs(prefs);
  const prefsChanged = sharedPrefsChanged || favoritePrefsChanged;
  if (prefsChanged) {
    prefs[RETIRED_HANAKO_MODEL_REPAIR_VERSION] = true;
    atomicWriteJSON(prefsPath, prefs);
  }

  const changedSessionMetaFiles = repairSessionMetaFiles(agentsDir);
  if (changedAgents || removedProviderModels || prefsChanged || changedSessionMetaFiles) {
    log(`[migrate-providers] repaired retired OpenHanako model references: agents=${changedAgents}, providerModels=${removedProviderModels}, prefs=${prefsChanged ? 1 : 0}, sessionMeta=${changedSessionMetaFiles}`);
  }
}

/**
 * V0.79.1 → 2026-05-25 切换默认本地模型回 Qwen3.5-9B Q4_K_M imatrix MTP。
 *
 * 4B imatrix 的 thinking-on 路径会空正文长思考,所以它只能作为低配降级选项。
 * 旧 4B(qwen3-4b-thinking-2507 / qwen35-4b-q4km)或缺失 provider 的配置都会 seed 到 9B。
 */
export function migrateLocalQwenDefaultTo9B(lynnHome: string, agentsDir: string, log: LogFn = () => {}): void {
  const providersPath = path.join(lynnHome, "added-models.yaml");
  const prefsPath = path.join(lynnHome, "user", "preferences.json");
  const raw = toAddedModelsYaml(safeReadYAMLSync(providersPath, {}, YAML));
  raw.providers = getProvidersMap(raw);

  const oldProvider = isRecord(raw.providers[OLD_LOCAL_QWEN_PROVIDER])
    ? raw.providers[OLD_LOCAL_QWEN_PROVIDER]
    : {};
  const existingNewProvider = isRecord(raw.providers[NEW_LOCAL_QWEN_PROVIDER])
    ? raw.providers[NEW_LOCAL_QWEN_PROVIDER]
    : {};
  const hasNewModel = Array.isArray(existingNewProvider.models)
    && existingNewProvider.models.some((model) => isRecord(model) && model.id === NEW_LOCAL_QWEN_MODEL);
  if (!raw.providers[NEW_LOCAL_QWEN_PROVIDER] || !hasNewModel) {
    raw.providers[NEW_LOCAL_QWEN_PROVIDER] = _localQwen9BProviderSeed(existingNewProvider.base_url ? existingNewProvider : oldProvider);
    const header =
      "# Lynn 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    atomicWriteYAML(providersPath, raw, header);
    log("[migrate-providers] seeded default local Qwen3.5-9B provider");
  }

  const prefs = _readPrefs(prefsPath);
  if (prefs[LOCAL_QWEN_9B_MTP_DEFAULT_FLAG]) return;

  let changedAgents = 0;
  for (const ac of _collectAgentConfigs(agentsDir)) {
    const cfg = ac.config || {};
    let changed = false;
    const api = getAgentApi(cfg);

    if (api && (api.provider === OLD_LOCAL_QWEN_PROVIDER || api.provider === LOCAL_QWEN_4B_PROVIDER)) {
      api.provider = NEW_LOCAL_QWEN_PROVIDER;
      changed = true;
    }

    const models = getAgentModels(cfg);
    const currentChat = models?.chat;
    const nextChat = _migrateChatRef(currentChat);
    if (nextChat !== currentChat) {
      ensureAgentModels(cfg).chat = nextChat;
      changed = true;
    }
    for (const key of ["utility", "utility_large", "utilityLarge"]) {
      const current = getAgentModels(cfg)?.[key];
      const migrated = _migrateChatRef(current);
      if (migrated !== current) {
        ensureAgentModels(cfg)[key] = migrated;
        changed = true;
      }
    }

    if (changed) {
      atomicWriteYAML(ac.path, cfg);
      changedAgents += 1;
    }
  }

  prefs[LOCAL_QWEN_9B_MTP_DEFAULT_FLAG] = true;
  atomicWriteJSON(prefsPath, prefs);
  if (changedAgents > 0) {
    log(`[migrate-providers] migrated ${changedAgents} agent local Qwen default(s) → Qwen3.5-9B`);
  } else {
    log("[migrate-providers] local Qwen 3.5-9B default migration marked");
  }
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

/**
 * 收集所有 agent 的 config.yaml
 */
function _collectAgentConfigs(agentsDir: string): AgentConfigEntry[] {
  const result: AgentConfigEntry[] = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;
      const config = safeReadYAMLSync(cfgPath, null, YAML);
      if (!isRecord(config)) continue;
      result.push({ id: entry.name, path: cfgPath, config });
    }
  } catch {
    // agentsDir 不存在是合法的（全新安装）
  }
  return result;
}

/** 安全读取 preferences.json */
function _readPrefs(prefsPath: string): PreferencesJson {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeFavorite(fav: unknown): { modelId: string; provider: string | null } | null {
  if (typeof fav === "string") {
    return fav ? { modelId: fav, provider: null } : null;
  }
  if (!isRecord(fav) || typeof fav.id !== "string" || !fav.id) return null;
  return {
    modelId: fav.id,
    provider: typeof fav.provider === "string" && fav.provider ? fav.provider : null,
  };
}

/** 向 provider 的 models 列表添加模型（去重） */
function _addModelToProvider(providers: ProviderConfigMap, providerName: string, modelId: string): void {
  const providerConfig = ensureProvider(providers, providerName);
  if (!Array.isArray(providerConfig.models)) {
    providerConfig.models = [];
  }
  const exists = providerConfig.models.some(
    m => modelEntryId(m) === modelId,
  );
  if (!exists) {
    providerConfig.models.push(modelId);
  }
}
