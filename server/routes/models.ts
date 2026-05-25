/**
 * 模型管理 REST 路由
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { BRAIN_DEFAULT_MODEL_ID, isBrainProvider } from "../../shared/brain-provider.js";
import { findModel, modelRefEquals, parseModelRef } from "../../shared/model-ref.js";
import type { ModelRef, ModelRefInput } from "../../shared/model-ref.js";
import { lookupKnown } from "../../shared/known-models.js";

type ModelOverride = {
  displayName?: string;
};

type ModelOverrides = Record<string, ModelOverride | undefined>;

type RouteModel = ModelRef & {
  id: string;
  name?: string;
  provider: string;
  baseUrl?: string;
  api?: string;
  vision?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

type CurrentModel = ModelRef & {
  name?: string;
};

type ProviderCredentials = {
  base_url?: string;
  api_key?: string | null;
  api?: string;
};

type OAuthCredential = {
  type?: string;
  resourceUrl?: string;
};

type ProviderRegistryEntry = {
  authType?: string;
};

type SharedModels = {
  utility?: ModelRefInput;
  utility_large?: ModelRefInput;
};

interface ModelsRouteEngine {
  refreshAvailableModels?: () => Promise<unknown> | unknown;
  config?: {
    models?: {
      overrides?: ModelOverrides;
    };
  };
  currentModel?: CurrentModel | null;
  availableModels: RouteModel[];
  resolveModelOverrides(model: RouteModel): RouteModel;
  getSharedModels?: () => SharedModels | null | undefined;
  resolveProviderCredentials(provider: string): ProviderCredentials;
  authStorage: {
    get(provider: string): OAuthCredential | null | undefined;
    getApiKey(provider: string): Promise<string | null | undefined> | string | null | undefined;
  };
  providerRegistry?: {
    get(provider: string): ProviderRegistryEntry | null | undefined;
  };
  setPendingModel(modelId: ModelRefInput, provider?: string): Promise<unknown> | unknown;
}

function toModelRef(value: ModelRefInput): ModelRef | null {
  const ref = parseModelRef(value);
  return ref.id ? ref : null;
}

/** 查询模型显示名：overrides > SDK name > known-models > id */
function resolveModelName(
  id: string,
  sdkName: string | undefined,
  overrides: ModelOverrides | undefined,
  provider: string,
): string {
  if (overrides?.[id]?.displayName) return overrides[id].displayName;
  if (sdkName && sdkName !== id) return sdkName;
  const known = lookupKnown(provider, id) as { name?: string } | null;
  if (known?.name) return known.name;
  return sdkName || id;
}

export function createModelsRoute(engine: ModelsRouteEngine): Hono {
  const route = new Hono();

  // 列出可用模型
  route.get("/models", async (c) => {
    try {
      await engine.refreshAvailableModels?.();
      const overrides = engine.config?.models?.overrides;
      const cur = engine.currentModel;
      const models = engine.availableModels.map(m => {
        const resolved = engine.resolveModelOverrides(m);
        return {
          id: m.id,
          name: resolveModelName(m.id, m.name, overrides, m.provider),
          provider: m.provider,
          isCurrent: modelRefEquals(m, cur),
          vision: resolved.vision,
          reasoning: resolved.reasoning,
          contextWindow: resolved.contextWindow,
          maxTokens: resolved.maxTokens,
        };
      });
      const sharedModels = engine.getSharedModels?.() || {};
      return c.json({
        models,
        current: cur?.id || null,
        utilityModel: toModelRef(sharedModels.utility),
        utilityLargeModel: toModelRef(sharedModels.utility_large),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // 健康检测：发一个最小请求测试模型连通性
  route.post("/models/health", async (c) => {
    try {
      const body = await safeJson(c) as { modelId?: ModelRefInput; provider?: string };
      const raw = body.modelId;
      if (!raw) return c.json({ error: "modelId required" }, 400);

      // 统一解析：接受 {id,provider} 对象、裸字符串、或 body.provider 补充
      const parsed = parseModelRef(raw);
      const modelId = parsed.id;
      const provider = body.provider || parsed.provider || "";
      if (!modelId) return c.json({ error: "modelId required" }, 400);

      const model = findModel(engine.availableModels, modelId, provider);
      if (!model) return c.json({ error: `model "${modelId}" not found` }, 404);

      // 凭证解析：added-models.yaml → auth.json OAuth（含 resourceUrl）→ 模型对象自带 baseUrl
      const creds = engine.resolveProviderCredentials(model.provider);

      // OAuth provider 可能有 resourceUrl（实际使用的域名，可能和内置不同）
      const oauthCred = engine.authStorage.get(model.provider);
      const oauthBaseUrl = oauthCred?.type === "oauth" ? oauthCred.resourceUrl : "";

      const baseUrl = creds.base_url || oauthBaseUrl || model.baseUrl || "";
      if (!baseUrl) return c.json({ ok: false, error: "no base_url" });

      let apiKey = creds.api_key;
      if (!apiKey) {
        try { apiKey = await engine.authStorage.getApiKey(model.provider); } catch { /* provider can still allow missing keys */ }
      }
      const providerEntry = engine.providerRegistry?.get(model.provider);
      const allowMissingApiKey = providerEntry?.authType === "none";
      if (!apiKey && !allowMissingApiKey) return c.json({ ok: false, error: "no api_key" });

      const { buildProviderAuthHeaders, buildProbeUrl } = await import("../../lib/llm/provider-client.js");
      const api = creds.api || model.api || "openai-completions";

      // OpenAI Codex Responses API：无法通过简单请求检测（Cloudflare 反爬），跳过
      if (api === "openai-codex-responses") {
        return c.json({ ok: true, status: 0, provider: model.provider, skipped: t("error.codexNoHealthCheck") });
      }

      if (isBrainProvider(model.provider)) {
        const { buildProviderAuthHeaders } = await import("../../lib/llm/provider-client.js");
        const headers = buildProviderAuthHeaders(api, apiKey, {
          allowMissingApiKey,
          method: "POST",
          pathname: "/chat/completions",
        }) as Record<string, string>;
        const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: BRAIN_DEFAULT_MODEL_ID,
            temperature: 0,
            max_tokens: 1,
            messages: [{ role: "user", content: "." }],
          }),
          signal: AbortSignal.timeout(15000),
        });
        return c.json({ ok: res.ok, status: res.status, provider: model.provider });
      }

      const probe = buildProbeUrl(baseUrl, api);
      const pathname = (() => {
        try {
          return new URL(probe.url).pathname || "/models";
        } catch {
          return probe.method === "POST" ? "/v1/messages" : "/models";
        }
      })();
      const headers = buildProviderAuthHeaders(api, apiKey, {
        allowMissingApiKey,
        method: probe.method,
        pathname,
      }) as Record<string, string>;

      if (api === "anthropic-messages") {
        const res = await fetch(probe.url, {
          method: probe.method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
          signal: AbortSignal.timeout(10000),
        });
        return c.json({ ok: res.ok || res.status === 400, status: res.status, provider: model.provider });
      }

      const res = await fetch(probe.url, { headers, signal: AbortSignal.timeout(10000) });
      return c.json({ ok: res.ok, status: res.status, provider: model.provider });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

  // 切换模型
  route.post("/models/set", async (c) => {
    try {
      const body = await safeJson(c) as { modelId?: ModelRefInput; provider?: string };
      const { modelId, provider } = body;
      if (!modelId) {
        return c.json({ error: t("error.missingParam", { param: "modelId" }) }, 400);
      }
      await engine.setPendingModel(modelId, provider);
      return c.json({ ok: true, model: engine.currentModel?.name, pendingModel: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return route;
}
