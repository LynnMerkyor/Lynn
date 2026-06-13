/**
 * update-settings-tool.js — 设置修改工具（渐进式披露）
 *
 * 两阶段调用：search 查找设置项 → apply 修改设置项。
 * description 不列举设置，由 search 按需返回匹配结果。
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { t } from "../../server/i18n.js";

/**
 * i18n key → 本地化标签 批量转换
 */
type SettingType = "list" | "text" | "toggle";
type SettingScope = "agent";
type SettingValue = string | boolean;

interface AgentConfigLike {
  models?: { chat?: string };
  [key: string]: unknown;
}

interface AgentLike {
  memoryMasterEnabled?: boolean;
  agentName?: string;
  userName?: string;
  config?: AgentConfigLike;
  updateConfig(config: Record<string, unknown>): void;
}

interface PreferencesLike {
  getLocale(): string | null | undefined;
  getTimezone(): string | null | undefined;
  getThinkingLevel(): string | null | undefined;
}

interface SettingsEngineLike {
  securityMode?: string;
  preferences: PreferencesLike;
  agent?: AgentLike | null;
  availableModels?: Array<{ id: string }>;
  getContentFilter?: () => { enabled?: boolean; byok?: string } | null | undefined;
  setContentFilter?: (partial: boolean | Record<string, unknown>) => void;
  setSecurityMode(value: string): void;
  setLocale(value: string): void;
  setTimezone(value: string): void;
  setThinkingLevel(value: string): void;
  getHomeFolder(): string | null | undefined;
  setHomeFolder(value: string): void;
}

interface SettingsRegistryEntry {
  type: SettingType;
  label: string;
  description?: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  searchTerms?: string[];
  scope?: SettingScope;
  frontend?: boolean;
  optionsFrom?: "availableModels";
  get(engine: SettingsEngineLike): string | null;
  apply?: ((engine: SettingsEngineLike, value: SettingValue) => void) | null;
}

interface SearchResult {
  key: string;
  reg: SettingsRegistryEntry;
  options: string[] | null;
}

interface SettingsToolParams {
  action: "search" | "apply" | string;
  query?: string;
  key?: string;
  value?: string;
}

interface ConfirmationResult {
  action: "confirmed" | "rejected" | string;
  value?: unknown;
}

interface ConfirmStoreLike {
  create(
    kind: "settings",
    payload: Record<string, unknown>,
    sessionPath?: string | null,
  ): { confirmId: string; promise: Promise<ConfirmationResult> };
}

type SettingsToolOptions = {
  getEngine?: () => SettingsEngineLike | null | undefined;
  getConfirmStore?: () => ConfirmStoreLike | null | undefined;
  getSessionPath?: () => string | null | undefined;
  emitEvent?: (event: Record<string, unknown>) => void;
};

type SettingsToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function settingString(value: SettingValue): string {
  return typeof value === "string" ? value : String(value);
}

function i18nLabels(keyMap: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(keyMap).map(([k, v]) => [k, t(v)]));
}

const THEME_I18N = {
  "warm-paper": "settings.appearance.warmPaper",
  "midnight": "settings.appearance.midnight",
  "high-contrast": "settings.appearance.highContrast",
  "grass-aroma": "settings.appearance.grassAroma",
  "contemplation": "settings.appearance.contemplation",
  "absolutely": "settings.appearance.absolutely",
  "delve": "settings.appearance.delve",
  "deep-think": "settings.appearance.deepThink",
  "auto": "settings.appearance.auto",
};

const THINKING_I18N = {
  "auto": "settings.agent.thinkingLevels.auto",
  "off": "settings.agent.thinkingLevels.off",
  "low": "settings.agent.thinkingLevels.low",
  "medium": "settings.agent.thinkingLevels.medium",
  "high": "settings.agent.thinkingLevels.high",
};

const LOCALE_LABELS = {
  "zh-CN": "简体中文", "zh-TW": "繁體中文", "ja": "日本語", "ko": "한국어", "en": "English",
};

/**
 * 设置注册表
 */
const SETTINGS_REGISTRY: Record<string, SettingsRegistryEntry> = {
  securityMode: {
    type: "list",
    get label() { return t("toolDef.updateSettings.securityMode") || "安全模式"; },
    get description() { return t("toolDef.updateSettings.securityModeDesc") || "三模式安全策略"; },
    options: ["authorized", "plan", "safe"],
    get optionLabels() {
      return {
        authorized: t("security.mode.authorized"),
        plan: t("security.mode.plan"),
        safe: t("security.mode.safe"),
      };
    },
    searchTerms: ["security", "mode", "安全", "模式", "セキュリティ", "보안"],
    get: (engine) => engine.securityMode || null,
    apply: (engine, v) => engine.setSecurityMode(settingString(v)),
  },
  locale: {
    type: "list",
    get label() { return t("toolDef.updateSettings.locale"); },
    options: ["zh-CN", "zh-TW", "ja", "ko", "en"],
    optionLabels: LOCALE_LABELS,
    searchTerms: ["language", "国际化", "言語", "언어"],
    get: (engine) => engine.preferences.getLocale() || "zh-CN",
    apply: (engine, v) => engine.setLocale(settingString(v)),
  },
  timezone: {
    type: "text",
    get label() { return t("toolDef.updateSettings.timezone"); },
    get description() { return t("toolDef.updateSettings.timezoneDesc"); },
    get: (engine) => engine.preferences.getTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    apply: (engine, v) => engine.setTimezone(settingString(v)),
  },
  thinking_level: {
    type: "list",
    get label() { return t("toolDef.updateSettings.thinkingBudget"); },
    options: ["auto", "off", "low", "medium", "high"],
    get optionLabels() { return i18nLabels(THINKING_I18N); },
    searchTerms: ["reasoning", "推理", "思考", "推論"],
    get: (engine) => engine.preferences.getThinkingLevel() || "auto",
    apply: (engine, v) => engine.setThinkingLevel(settingString(v)),
  },
  "content_filter.enabled": {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.contentFilter"); },
    get description() { return t("toolDef.updateSettings.contentFilterDesc"); },
    searchTerms: ["content filter", "safety filter", "安全过滤", "内容过滤", "过滤器", "誤判", "误杀", "誤殺", "コンテンツ", "필터"],
    get: (engine) => String(engine.getContentFilter?.()?.enabled !== false),
    apply: (engine, v) => {
      if (!engine.setContentFilter) throw new Error("content filter settings unavailable");
      engine.setContentFilter({ enabled: v === true || v === "true" });
    },
  },
  "content_filter.byok": {
    type: "list",
    get label() { return t("toolDef.updateSettings.contentFilterByok"); },
    get description() { return t("toolDef.updateSettings.contentFilterByokDesc"); },
    options: ["warn", "block"],
    optionLabels: { warn: "warn", block: "block" },
    searchTerms: ["BYOK", "local model", "content filter", "safety filter", "安全过滤", "内容过滤", "过滤策略", "api key", "本地模型"],
    get: (engine) => engine.getContentFilter?.()?.byok || "warn",
    apply: (engine, v) => {
      if (!engine.setContentFilter) throw new Error("content filter settings unavailable");
      engine.setContentFilter({ byok: settingString(v) });
    },
  },
  "memory.enabled": {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.memory"); },
    get description() { return t("toolDef.updateSettings.memoryDesc"); },
    scope: "agent",
    get: (engine) => engine.agent ? String(engine.agent.memoryMasterEnabled !== false) : null,
    apply: (engine, v) => {
      if (!engine.agent) throw new Error("no active agent");
      engine.agent.updateConfig({ memory: { enabled: v === true || v === "true" } });
    },
  },
  "agent.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.agentName"); },
    scope: "agent",
    get: (engine) => engine.agent?.agentName || null,
    apply: (engine, v) => {
      if (!engine.agent) throw new Error("no active agent");
      engine.agent.updateConfig({ agent: { name: settingString(v) } });
    },
  },
  "user.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.userName"); },
    scope: "agent",
    get: (engine) => engine.agent?.userName || null,
    apply: (engine, v) => {
      if (!engine.agent) throw new Error("no active agent");
      engine.agent.updateConfig({ user: { name: settingString(v) } });
    },
  },
  home_folder: {
    type: "text",
    get label() { return t("toolDef.updateSettings.workingDir"); },
    get description() { return t("toolDef.updateSettings.workingDirDesc"); },
    get: (engine) => engine.getHomeFolder() || "",
    apply: (engine, v) => engine.setHomeFolder(settingString(v)),
  },
  theme: {
    type: "list",
    get label() { return t("toolDef.updateSettings.theme"); },
    options: ["warm-paper", "midnight", "high-contrast", "grass-aroma", "contemplation", "absolutely", "delve", "deep-think", "auto"],
    get optionLabels() { return i18nLabels(THEME_I18N); },
    searchTerms: ["dark", "light", "暗色", "亮色", "外观", "appearance", "夜间", "ダーク", "다크"],
    frontend: true,
    get: () => "warm-paper",
    apply: null,
  },
  "models.chat": {
    type: "list",
    get label() { return t("toolDef.updateSettings.chatModel"); },
    scope: "agent",
    optionsFrom: "availableModels",
    searchTerms: ["model", "模型", "モデル", "모델"],
    get: (engine) => engine.agent?.config?.models?.chat || null,
    apply: (engine, v) => {
      if (!engine.agent) throw new Error("no active agent");
      engine.agent.updateConfig({ models: { chat: v } });
    },
  },
};

// ── 搜索 ──

function resolveOptions(reg: SettingsRegistryEntry, engine: SettingsEngineLike): string[] | null {
  if (reg.optionsFrom === "availableModels") {
    return (engine.availableModels || []).map(m => m.id);
  }
  return reg.options || null;
}

function searchSettings(query: string, engine: SettingsEngineLike): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: SearchResult[] = [];
  for (const [key, reg] of Object.entries(SETTINGS_REGISTRY)) {
    const options = resolveOptions(reg, engine);
    const haystack = [
      key, reg.label, reg.description || "",
      ...(reg.searchTerms || []),
      ...(options || []),
      ...Object.values(reg.optionLabels || {}),
    ].join(" ").toLowerCase();
    if (haystack.includes(q)) {
      results.push({ key, reg, options });
    }
  }
  return results;
}

// ── 格式化 ──

function formatOptionList(options: string[] | null | undefined, labels?: Record<string, string>, maxShow = 10): string {
  if (!options?.length) return "";
  const shown = options.slice(0, maxShow);
  const rest = options.length - shown.length;
  const parts = shown.map(o => labels?.[o] ? `${o}(${labels[o]})` : o);
  if (rest > 0) parts.push(`...+${rest}`);
  return parts.join(" / ");
}

function formatSearchResults(results: SearchResult[], engine: SettingsEngineLike): string {
  return results.map((r, i) => {
    const { key, reg, options } = r;
    const ol = reg.optionLabels;
    const lines = [`[${i + 1}] ${key} — ${reg.label} (${reg.type})`];

    // 当前值：frontend 设置标注不可读
    if (reg.frontend) {
      lines.push(`    ${t("toolDef.updateSettings.frontendOnly")}`);
    } else {
      const cv = reg.get(engine);
      if (cv === null) {
        lines.push(`    → (N/A)`);
      } else {
        const cvLabel = ol?.[cv] ? `${cv} (${ol[cv]})` : cv;
        lines.push(`    → ${cvLabel}`);
      }
    }

    // 选项列表
    if (options?.length) {
      lines.push(`    ${formatOptionList(options, ol)}`);
    }
    if (reg.description) {
      lines.push(`    ${reg.description}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

// ── 工具 ──

export function createUpdateSettingsTool(deps: SettingsToolOptions = {}) {
  const {
    getEngine,
    getConfirmStore,
    getSessionPath,
    emitEvent,
  } = deps;

  return {
    name: "update_settings",
    userFacingName: t("toolDef.updateSettings.label"),
    description: t("toolDef.updateSettings.description"),
    parameters: Type.Object({
      action: StringEnum(
        ["search", "apply"],
        { description: t("toolDef.updateSettings.actionDesc") },
      ),
      query: Type.Optional(Type.String({ description: t("toolDef.updateSettings.queryDesc") })),
      key: Type.Optional(Type.String({ description: t("toolDef.updateSettings.keyDesc") })),
      value: Type.Optional(Type.String({ description: t("toolDef.updateSettings.valueDesc") })),
    }),
    isUserFacing: true,
    execute: async (_toolCallId: string, params: SettingsToolParams): Promise<SettingsToolResult> => {
      const engine = getEngine?.();

      switch (params.action) {
        // ── search ──
        case "search": {
          const query = params.query?.trim();
          if (!query) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.searchMissingQuery") }] };
          }
          if (!engine) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }
          const results = searchSettings(query, engine);
          if (results.length === 0) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.searchNoResults", { query }) }] };
          }
          const body = formatSearchResults(results, engine);
          return { content: [{ type: "text", text: t("toolDef.updateSettings.searchResult", { count: String(results.length), results: body }) }] };
        }

        // ── apply ──
        case "apply": {
          const { key, value } = params;
          if (!key || !value) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.applyMissingParams") }] };
          }
          const reg = SETTINGS_REGISTRY[key];
          if (!reg) {
            return { content: [{ type: "text", text: t("error.settingsUnknownKey", { key }) }] };
          }

          const confirmStore = getConfirmStore?.();
          const sessionPath = getSessionPath?.();
          if (!engine || !confirmStore) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }

          // scope: "agent" 的设置在无 agent 时拒绝操作
          if (reg.scope === "agent" && !engine.agent) {
            return { content: [{ type: "text", text: t("error.settingsNoAgent") }] };
          }

          // 读取当前值
          const currentValue = reg.get(engine);

          // 动态选项
          const options = resolveOptions(reg, engine);

          // toggle 校验
          if (reg.type === "toggle" && value !== "true" && value !== "false") {
            return { content: [{ type: "text", text: t("error.settingsInvalidToggle") }] };
          }

          // list 校验
          if (reg.type === "list" && options?.length && !options.includes(value)) {
            const ol = reg.optionLabels;
            const optList = formatOptionList(options, ol);
            return { content: [{ type: "text", text: t("error.settingsInvalidValue", { value, options: optList }) }] };
          }

          // 选项本地化标签
          const optionLabels = reg.optionLabels || null;

          // 创建阻塞确认
          const { confirmId, promise } = confirmStore.create(
            "settings",
            { key, label: reg.label, description: reg.description, type: reg.type, currentValue, proposedValue: value, options, optionLabels, frontend: reg.frontend },
            sessionPath,
          );

          // 广播确认事件
          emitEvent?.({
            type: "settings_confirmation",
            confirmId,
            settingKey: key,
            cardType: reg.type,
            currentValue,
            proposedValue: value,
            options: options || null,
            optionLabels,
            label: reg.label,
            description: reg.description || null,
            frontend: !!reg.frontend,
          });

          // 阻塞等待用户确认
          const result = await promise;

          if (result.action === "confirmed") {
            const finalValue = result.value !== undefined ? String(result.value) : value;
            try {
              if (reg.frontend) {
                emitEvent?.({ type: "apply_frontend_setting", key, value: finalValue });
              } else {
                if (typeof reg.apply === "function") {
                  const parsed = reg.type === "toggle" ? (finalValue === "true") : finalValue;
                  reg.apply(engine, parsed);
                }
              }
              return { content: [{ type: "text", text: t("error.settingsApplied", { label: reg.label, value: finalValue }) }] };
            } catch (err) {
              return { content: [{ type: "text", text: t("error.settingsApplyFailed", { msg: errorMessage(err) }) }] };
            }
          } else if (result.action === "rejected") {
            return { content: [{ type: "text", text: t("error.settingsCancelled", { label: reg.label }) }] };
          } else {
            return { content: [{ type: "text", text: t("error.settingsTimeout", { label: reg.label }) }] };
          }
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
      }
    },
  };
}
