/**
 * ModelManager -- 模型发现、切换、凭证解析
 *
 * 管理 Pi SDK AuthStorage / ModelRegistry 基础设施，
 * 以及模型选择、provider 凭证查找、utility 配置解析。
 * 从 Engine 提取，Engine 通过 manager 访问模型状态。
 *
 * _availableModels 是唯一的模型真理源。所有模型解析、enrichment
 * 都在这个数组上完成，不再经过中间层。
 */
import path from "path";
import {
  AuthStorage,
} from "./agent-runtime/auth-storage.js";
import {
  ModelRegistry,
} from "./agent-runtime/model-registry.js";
import { registerOAuthProvider } from "./agent-runtime/oauth.js";
import { minimaxOAuthProvider } from "../lib/oauth/minimax-portal.js";
import { t } from "../server/i18n.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ExecutionRouter } from "./execution-router.js";
import { findModel } from "../shared/model-ref.js";
import { isLocalBaseUrl } from "../shared/net-utils.js";
import { syncModels } from "./model-sync.js";
import { BRAIN_PROVIDER_ID } from "../shared/brain-provider.js";
import { lookupKnown } from "../shared/known-models.js";
import type {
  LLMApi,
  ModelId,
  ModelRef,
  ProviderConfig,
  ProviderCredentialsSnake,
  ProviderId,
  ResolvedModel,
  UtilityExecutionConfig,
} from "./types.js";

type AgentModelRefs = Partial<Record<"chat" | "utility" | "utility_large" | "summarizer" | "compiler", string>>;

interface AgentConfig {
  models?: AgentModelRefs;
  [key: string]: unknown;
}

type SharedUtilityModels = Partial<Record<"utility" | "utility_large" | "summarizer" | "compiler", string>>;
type RawModelEntry = NonNullable<ProviderConfig["models"]>[number];
type KnownModelMetadata = {
  context?: number;
  maxOutput?: number;
  vision?: boolean;
  reasoning?: boolean;
};

interface UtilityApiOverride {
  provider?: string;
  api_key?: string;
  base_url?: string;
}

interface ModelManagerOptions {
  lynnHome: string;
}

export class ModelManager {
  _lynnHome: string;
  _authStorage: AuthStorage | null;
  _modelRegistry: ModelRegistry | null;
  _defaultModel: ResolvedModel | null;
  _availableModels: ResolvedModel[];
  providerRegistry: ProviderRegistry;
  executionRouter: ExecutionRouter | null;

  constructor({ lynnHome }: ModelManagerOptions) {
    this._lynnHome = lynnHome;
    this._authStorage = null;
    this._modelRegistry = null;
    this._defaultModel = null;   // 设置页面选的，持久化，bridge 用这个
    this._availableModels = [];

    // 新架构模块（init() 后可用）
    this.providerRegistry = new ProviderRegistry(lynnHome);
    this.executionRouter = null;
  }

  /** 初始化 AuthStorage + ModelRegistry + 新架构模块 */
  init(): void {
    this._authStorage = AuthStorage.create(path.join(this._lynnHome, "auth.json"));
    registerOAuthProvider(minimaxOAuthProvider);
    this._modelRegistry = new ModelRegistry(
      this._authStorage,
      path.join(this._lynnHome, "models.json"),
    );

    this.providerRegistry.reload();
    this.executionRouter = new ExecutionRouter(
      (ref) => this._resolveFromAvailable(ref),
      this.providerRegistry,
    );
  }

  // ── Getters ──

  get authStorage(): AuthStorage | null { return this._authStorage; }
  get modelRegistry(): ModelRegistry | null { return this._modelRegistry; }
  get defaultModel(): ResolvedModel | null { return this._defaultModel; }
  set defaultModel(m: ResolvedModel | null) { this._defaultModel = m; }
  get currentModel(): ResolvedModel | null { return this._defaultModel; }
  get availableModels(): ResolvedModel[] { return this._availableModels; }
  get modelsJsonPath(): string { return path.join(this._lynnHome, "models.json"); }
  get authJsonPath(): string { return path.join(this._lynnHome, "auth.json"); }

  // ── 模型解析：_availableModels 唯一真理源 ──

  /**
   * 从 _availableModels 解析模型引用
   * 支持两种输入：
   *   1. "provider/model" 格式（精确匹配 provider + id）
   *   2. 裸 model ID（匹配 id 或 name）
   * 不做模糊 fallback，避免静默绑到错误 provider。
   */
  _resolveFromAvailable(ref: ModelRef | string | null | undefined): ResolvedModel | null {
    if (!ref) return null;

    // 新格式：{id, provider} 对象 — 用复合键精确查找
    if (typeof ref === "object" && ref.id) {
      return findModel(this._availableModels, ref.id, ref.provider) || null;
    }

    if (typeof ref !== "string") return null;
    const str = ref.trim();
    if (!str) return null;

    // 层级 1：尝试 "provider/model" 分割匹配（首个 / 做切分）
    if (str.includes("/")) {
      const slashIdx = str.indexOf("/");
      const providerPart = str.slice(0, slashIdx);
      const modelPart = str.slice(slashIdx + 1);
      const match = this._availableModels.find(
        m => m.provider === providerPart && m.id === modelPart,
      );
      if (match) return match;
    }

    // 层级 2：完整字符串作为裸 model ID 匹配
    // 覆盖两种情况：
    //   a) 纯裸 ID（如 "qwen3.5-flash"）
    //   b) OpenRouter 风格 ID（如 "anthropic/claude-opus-4-6" 是 id 本身）
    return findModel(this._availableModels, str) || this._availableModels.find(m => m.name === str) || null;
  }

  // ── 刷新 ──

  /**
   * 刷新可用模型列表，用 added-models.yaml 过滤
   */
  async refreshAvailable(): Promise<ResolvedModel[]> {
    const allModels = await this._modelRegistry!.getAvailable() as unknown as ResolvedModel[];
    // Pi SDK 返回所有有 auth 的模型（包括 OAuth 内置模型），
    // 但用户只想看自己配置的模型。用 added-models.yaml 的模型列表过滤。
    const rawProviders = this.providerRegistry.getAllProvidersRaw();
    const userModelSets = new Map<string, Set<string>>();
    const rawModelEntries = new Map<string, RawModelEntry>();
    for (const [name, raw] of Object.entries(rawProviders)) {
      if (!raw.models?.length) continue;
      const ids = new Set(raw.models.map(m => typeof m === "object" ? m.id : m));
      userModelSets.set(name, ids);
      for (const model of raw.models) {
        const id = typeof model === "object" ? model.id : model;
        rawModelEntries.set(`${name}\u0000${id}`, model);
      }
      // OAuth provider 的 authJsonKey 可能不同于 provider ID
      const authKey = this.providerRegistry.getAuthJsonKey(name);
      if (authKey !== name) {
        userModelSets.set(authKey, ids);
        for (const model of raw.models) {
          const id = typeof model === "object" ? model.id : model;
          rawModelEntries.set(`${authKey}\u0000${id}`, model);
        }
      }
    }
    this._availableModels = allModels.filter((m) => {
      const allowed = userModelSets.get(m.provider);
      // 没有在 added-models.yaml 里的 provider → 全部放行（兼容未知来源）
      if (!allowed) return true;
      return allowed.has(m.id);
    }).map((m) => this._enrichModelMetadata(m, rawModelEntries.get(`${m.provider}\u0000${m.id}`)));
    return this._availableModels;
  }

  _enrichModelMetadata(model: ResolvedModel, rawEntry?: RawModelEntry): ResolvedModel {
    const raw = typeof rawEntry === "object" && rawEntry !== null ? rawEntry : null;
    const known = lookupKnown(model.provider, model.id) as KnownModelMetadata | null;
    const rawVision = typeof raw?.vision === "boolean" ? raw.vision : undefined;
    const rawReasoning = typeof raw?.reasoning === "boolean" ? raw.reasoning : undefined;
    const hasImageInput = Array.isArray((model as { input?: unknown }).input)
      && ((model as { input?: unknown[] }).input || []).includes("image");
    const vision = rawVision ?? (model.vision === true || hasImageInput || known?.vision === true);
    const reasoning = rawReasoning ?? (model.reasoning === true || known?.reasoning === true);
    const input = Array.isArray((model as { input?: unknown }).input)
      ? [...((model as { input?: Array<"text" | "image"> }).input || [])]
      : ["text" as const];
    if (vision && !input.includes("image")) input.push("image");
    if (!input.includes("text")) input.unshift("text");

    return {
      ...model,
      input,
      vision,
      reasoning,
      contextWindow: raw?.context || known?.context || model.contextWindow || undefined,
      maxTokens: raw?.maxOutput || known?.maxOutput || model.maxTokens || undefined,
    };
  }

  /**
   * 同步 added-models.yaml → models.json，然后刷新 ModelRegistry
   */
  async syncAndRefresh(): Promise<boolean> {
    const rawProviders = this.providerRegistry.getAllProvidersRaw();
    // 合并 plugin 默认值（base_url/api），YAML 里可能只存了 api_key + models
    const providers: Record<string, ProviderConfig> = {};
    for (const [name, raw] of Object.entries(rawProviders)) {
      const entry = this.providerRegistry.get(name);
      providers[name] = {
        ...raw,
        base_url: raw.base_url || entry?.baseUrl || "",
        api: (raw.api || entry?.api || "openai-completions") as LLMApi,
        auth_type: raw.auth_type || entry?.authType || "api-key",
      };
    }
    const changed = syncModels(providers, {
      modelsJsonPath: this.modelsJsonPath,
      authJsonPath: this.authJsonPath,
      lynnHome: this._lynnHome,
      oauthKeyMap: this._buildOAuthKeyMap(),
    });
    if (changed) {
      this._modelRegistry!.refresh();
      // refresh() 内部调 resetOAuthProviders()，需要重新注册
      registerOAuthProvider(minimaxOAuthProvider);
      await this.refreshAvailable();
    }
    return changed;
  }

  /**
   * 构建 OAuth providerId → auth.json key 映射
   * @private
   */
  _buildOAuthKeyMap(): Record<string, ProviderId> {
    const map: Record<string, ProviderId> = {};
    for (const id of this.providerRegistry.getOAuthProviderIds()) {
      const authKey = this.providerRegistry.getAuthJsonKey(id);
      if (authKey !== id) map[id] = authKey;
    }
    return map;
  }

  /**
   * 设置 agent 默认模型
   */
  setDefaultModel(modelId: ModelId, provider: ProviderId): ResolvedModel {
    const model = findModel(this._availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    this._defaultModel = model;
    return model;
  }

  /**
   * auto -> medium by default; Brain keeps auto fast unless the user explicitly asks for deeper reasoning.
   */
  resolveThinkingLevel(level: string | null | undefined, model: ResolvedModel | null = null): string {
    const rawLevel = level || "auto";
    const provider = String(model?.provider || "").trim();
    const thinkingFormat = String((model as { compat?: { thinkingFormat?: unknown } } | null)?.compat?.thinkingFormat || "").trim();
    if (provider === BRAIN_PROVIDER_ID && rawLevel === "auto") return "off";
    if (thinkingFormat === "deepseek" && rawLevel === "auto") return "off";
    return rawLevel === "auto" ? "medium" : rawLevel;
  }

  /**
   * 将模型引用（id/name/object）解析成 SDK 可用的模型对象
   * 只查 _availableModels（唯一真理源）
   */
  resolveExecutionModel(modelRef: ModelRef | null | undefined): ResolvedModel | null {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef !== "string") return modelRef as ResolvedModel; // 对象直通（session-coordinator 路径）
    const ref = modelRef.trim();
    if (!ref) return this.currentModel;

    const model = this._resolveFromAvailable(ref);
    if (model) return model;

    throw new Error(t("error.modelNotFound", { id: ref }));
  }

  /**
   * 根据模型 ID 推断其所属 provider
   */
  inferModelProvider(modelId: ModelId | null | undefined): ProviderId | null {
    if (!modelId) return null;
    const model = this._resolveFromAvailable(modelId);
    return model?.provider || null;
  }

  /**
   * 根据 provider 名称查找凭证
   * 委托 ProviderRegistry，返回 snake_case 格式（兼容 callProviderText 消费方）
   */
  resolveProviderCredentials(provider: ProviderId | null | undefined): ProviderCredentialsSnake {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const cred = this.providerRegistry.getCredentials(provider);
    if (cred) {
      return { api_key: cred.apiKey || "", base_url: cred.baseUrl || "", api: cred.api || "" };
    }
    return { api_key: "", base_url: "", api: "" };
  }

  /**
   * 统一解析：模型引用 -> { model, provider, api, api_key, base_url }
   * 返回 snake_case 格式（兼容 callProviderText / diary-writer / compile 等消费方）
   */
  resolveModelWithCredentials(modelRef: ModelRef | null | undefined): {
    model: ModelId;
    provider: ProviderId;
    api: LLMApi;
    api_key: string;
    base_url: string;
  } {
    const entry = this.resolveExecutionModel(modelRef);
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(modelRef) }));
    }
    const creds = this.resolveProviderCredentials(provider);
    if (!creds.api) {
      throw new Error(t("error.providerMissingApi", { provider }));
    }
    const providerEntry = this.providerRegistry.get(provider);
    const allowMissingApiKey = providerEntry?.authType === "none";
    if (!creds.base_url || (!creds.api_key && !isLocalBaseUrl(creds.base_url) && !allowMissingApiKey)) {
      throw new Error(t("error.providerMissingCreds", { provider }));
    }
    return {
      model: entry.id,
      provider,
      api: creds.api,
      api_key: creds.api_key,
      base_url: creds.base_url,
    };
  }

  /**
   * 解析 utility 模型 + API 凭证完整配置
   * 委托 ExecutionRouter
   */
  resolveUtilityConfig(
    agentConfig?: AgentConfig | null,
    sharedModels?: SharedUtilityModels | null,
    utilApi?: UtilityApiOverride | null,
  ): UtilityExecutionConfig {
    if (!this.executionRouter) {
      throw new Error(t("error.noUtilityModel"));
    }
    return this.executionRouter.resolveUtilityConfig(agentConfig, sharedModels, utilApi);
  }
}
