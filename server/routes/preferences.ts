/**
 * 全局偏好设置路由（跨 agent 共享）
 *
 * GET  /api/preferences/models  — 读取全局模型 + 搜索配置
 * PUT  /api/preferences/models  — 更新全局模型 + 搜索配置
 */

import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { debugLog } from "../../lib/debug-log.js";
import { isValidModelCallTimeouts, normalizeModelCallTimeouts } from "../../shared/model-call-timeouts.js";
import { resolveModelCallTimeouts, modelTimeoutDiagnostics } from "../../core/agent-runtime/model-call-timeouts.js";

type ProviderSettings = {
  provider?: string | null;
  base_url?: string | null;
  api_key?: string | null;
};

type PreferencesBody = {
  models?: unknown;
  search?: unknown;
  utility_api?: unknown;
};

interface PreferencesRouteEngine {
  getPreferences(): Record<string, unknown>;
  savePreferences(preferences: Record<string, unknown>): unknown;
  getSharedModels(): unknown;
  getSearchConfig(): ProviderSettings;
  getUtilityApi(): ProviderSettings;
  setSharedModels(models: unknown): unknown;
  setSearchConfig(search: unknown): unknown;
  setUtilityApi(utilityApi: unknown): unknown;
  syncModelsAndRefresh(): Promise<unknown> | unknown;
}

export function createPreferencesRoute(engine: PreferencesRouteEngine): Hono {
  const route = new Hono();

  const timeoutSettings = () => {
    const configured = normalizeModelCallTimeouts(engine.getPreferences().model_call_timeouts);
    return { configured, effective: resolveModelCallTimeouts(configured), brainEffective: resolveModelCallTimeouts(configured, "brain"), diagnostics: modelTimeoutDiagnostics(engine.getPreferences().model_call_timeouts) };
  };

  route.get("/preferences/model-timeouts", (c) => c.json(timeoutSettings()));
  route.put("/preferences/model-timeouts", async (c) => {
    const body = await safeJson(c);
    if (!isValidModelCallTimeouts(body)) {
      return c.json({ error: "firstChunkMs / idleMs 必须为正整数毫秒；totalMs 可为 0（不限制）。最大值为 2147483647。" }, 400);
    }
    try {
      await engine.savePreferences({ ...engine.getPreferences(), model_call_timeouts: body });
      return c.json(timeoutSettings());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // 读取全局模型 + 搜索配置
  route.get("/preferences/models", async (c) => {
    try {
      const models = engine.getSharedModels();
      const search = engine.getSearchConfig();
      const utilityApi = engine.getUtilityApi();

      return c.json({
        models,
        search: {
          provider: search.provider || "",
          base_url: search.base_url || "",
          api_key: search.api_key || "",
        },
        utility_api: {
          provider: utilityApi.provider || "",
          base_url: utilityApi.base_url || "",
          api_key: utilityApi.api_key || "",
        },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // 更新全局模型 + 搜索配置
  route.put("/preferences/models", async (c) => {
    try {
      const body = await safeJson(c) as PreferencesBody | null;
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }

      const sections: string[] = [];
      let needsModelSync = false;
      // 共享模型（utility / utility_large）
      if (body.models) {
        engine.setSharedModels(body.models);
        sections.push("models");
        needsModelSync = true;
      }

      // 搜索配置
      if (body.search) {
        engine.setSearchConfig(body.search);
        sections.push("search");
      }

      // utility API 配置
      if (body.utility_api) {
        engine.setUtilityApi(body.utility_api);
        sections.push("utility_api");
      }

      if (needsModelSync) {
        try { await engine.syncModelsAndRefresh(); } catch (e) {
          debugLog()?.warn("api", `syncModelsAndRefresh after preferences change: ${(e as Error).message}`);
        }
      }

      debugLog()?.log("api", `PUT /api/preferences/models sections=[${sections.join(",")}]`);
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/preferences/models failed: ${(err as Error).message}`);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return route;
}
