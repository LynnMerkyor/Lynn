import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clearConfigCache = vi.fn();

vi.mock("../lib/memory/config-loader.js", () => ({
  clearConfigCache,
  getRawConfig: () => ({}),
}));

describe("model sync related routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("provider-only config updates trigger model registry sync", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const saveProvider = vi.fn();
    const reload = vi.fn();
    const engine = {
      config: {},
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      providerRegistry: { saveProvider, removeProvider: vi.fn(), reload },
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          dashscope: {
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api: "openai-completions",
            api_key: "sk-test",
            models: ["qwen-plus"],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledTimes(1);
    expect(saveProvider).toHaveBeenCalledWith("dashscope", {
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api: "openai-completions",
      api_key: "sk-test",
      models: ["qwen-plus"],
    });
    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(engine.updateConfig).toHaveBeenCalledWith({});
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("shared model preference updates trigger model registry sync", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          utility: "test-model",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.setSharedModels).toHaveBeenCalledWith({ utility: "test-model" });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("inline 凭证缺少显式 provider 时返回 400", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      getHomeFolder: vi.fn(() => null),
      getThinkingLevel: vi.fn(() => "medium"),
      getSandbox: vi.fn(() => "workspace-write"),
      getLocale: vi.fn(() => "zh-CN"),
      getTimezone: vi.fn(() => "Asia/Shanghai"),
      getLearnSkills: vi.fn(() => false),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          api_key: "sk-test",
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("api.provider is required");
  });

  it("model routes expose stable ids and readable display names", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
    const engine = {
      availableModels: [
        {
          id: "gpt-5.4",
          name: "Gpt 5.4",
          provider: "openai-codex",
          reasoning: true,
        },
      ],
      currentModel: { id: "gpt-5.4", name: "Gpt 5.4" },
      config: {},
      providerRegistry: { get: () => ({}) },
      resolveModelOverrides(model) {
        if (!model) return null;
        const ov = this.config?.models?.overrides?.[model.id];
        if (!ov) return model;
        return { ...model, ...ov };
      },
    };

    app.route("/api", createModelsRoute(engine));

    const allRes = await app.request("/api/models");
    const allData = await allRes.json();
    expect(allRes.status).toBe(200);
    expect(allData.models[0].id).toBe("gpt-5.4");
    expect(allData.models[0].name).toBe("Gpt 5.4");
  });

  it("model set refreshes the registry before applying the current model", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const calls = [];
    const app = new Hono();
    const engine = {
      availableModels: [],
      currentModel: { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" },
      config: {},
      refreshAvailableModels: vi.fn(async () => { calls.push("refresh"); }),
      setPendingModel: vi.fn(async () => { calls.push("set"); }),
      resolveModelOverrides: vi.fn((model) => model),
      resolveProviderCredentials: vi.fn(() => ({})),
      authStorage: { get: vi.fn(), getApiKey: vi.fn() },
      providerRegistry: { get: vi.fn() },
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", modelId: "deepseek-v4-flash" }),
    });

    expect(res.status).toBe(200);
    expect(engine.refreshAvailableModels).toHaveBeenCalledTimes(1);
    expect(engine.setPendingModel).toHaveBeenCalledWith("deepseek-v4-flash", "deepseek");
    expect(calls).toEqual(["refresh", "set"]);
  });

  it("provider fetch prefers Pi registry models for oauth providers", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = {
      availableModels: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          provider: "openai-codex",
          contextWindow: 272000,
          maxOutputTokens: 128000,
        },
      ],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        getApiKey: vi.fn(),
      },
      providerRegistry: { getCredentials: () => null, isOAuth: (id) => id === "openai-codex", getAuthJsonKey: (id) => id },
      configPath: "/tmp/test-config.yaml",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "openai-codex",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.refreshAvailableModels).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data).toEqual({
      source: "registry",
      models: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          context: 272000,
          maxOutput: 128000,
        },
      ],
    });
  });

  it("provider summary exposes OAuth login entries before the user logs in", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const oauthEntry = {
      id: "openai-codex-oauth",
      displayName: "OpenAI Codex (OAuth)",
      authType: "oauth",
      baseUrl: "",
      api: "openai-codex-responses",
      authJsonKey: "openai-codex",
    };
    const registryEntries = new Map([["openai-codex-oauth", oauthEntry]]);
    const engine = {
      availableModels: [],
      authStorage: {
        getOAuthProviders: () => [],
      },
      preferences: {
        getOAuthCustomModels: () => ({}),
      },
      providerRegistry: {
        getAllProvidersRaw: () => ({}),
        getAll: () => registryEntries,
        get: (id) => (id === "openai-codex-oauth" || id === "openai-codex" ? oauthEntry : null),
        isOAuth: (id) => id === "openai-codex-oauth",
        getAuthJsonKey: (id) => (id === "openai-codex-oauth" ? "openai-codex" : id),
        getDefaultModels: (id) => (id === "openai-codex-oauth" ? ["gpt-5.4"] : []),
        getOAuthProviderIds: () => ["openai-codex-oauth"],
      },
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.providers["openai-codex-oauth"]).toMatchObject({
      type: "oauth",
      display_name: "OpenAI Codex (OAuth)",
      api: "openai-codex-responses",
      has_credentials: false,
      logged_in: false,
      supports_oauth: true,
      models: [],
      custom_models: ["gpt-5.4"],
    });
  });

  it("provider summary attaches safe canonical state snapshots", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const rawProviders = {
      "api-missing": {
        auth_type: "api-key",
        base_url: "https://api.example.com/v1",
        api: "openai-completions",
        api_key: "",
        models: ["demo-model"],
      },
      "local-ready": {
        auth_type: "none",
        base_url: "http://127.0.0.1:18099/v1",
        api: "openai-completions",
        models: ["local-model"],
      },
      "disabled-provider": {
        auth_type: "api-key",
        base_url: "https://disabled.example/v1",
        api: "openai-completions",
        api_key: "sk-disabled-secret",
        disabled: true,
        health: { status: "healthy" },
      },
      "cooldown-provider": {
        auth_type: "api-key",
        base_url: "https://cooldown.example/v1",
        api: "openai-completions",
        api_key: "sk-cooldown-secret",
        cooldown: { active: true, reason: "429", safeReason: "token=tp-cooldown-secret" },
      },
      "error-provider": {
        auth_type: "none",
        base_url: "http://127.0.0.1:18100/v1",
        api: "openai-completions",
        error: { active: true, code: "upstream_500", safeReason: "api_key=sk-error-secret" },
      },
    };
    const registryEntries = new Map([
      ["api-missing", { displayName: "API Missing", authType: "api-key", baseUrl: "https://api.example.com/v1", api: "openai-completions" }],
      ["local-ready", { displayName: "Local Ready", authType: "none", baseUrl: "http://127.0.0.1:18099/v1", api: "openai-completions" }],
      ["local-unconfigured", { displayName: "Local Unconfigured", authType: "none", baseUrl: "", api: "openai-completions" }],
      ["disabled-provider", { displayName: "Disabled Provider", authType: "api-key", baseUrl: "https://disabled.example/v1", api: "openai-completions" }],
      ["cooldown-provider", { displayName: "Cooldown Provider", authType: "api-key", baseUrl: "https://cooldown.example/v1", api: "openai-completions" }],
      ["error-provider", { displayName: "Error Provider", authType: "none", baseUrl: "http://127.0.0.1:18100/v1", api: "openai-completions" }],
    ]);
    const engine = {
      availableModels: [],
      authStorage: {
        getOAuthProviders: () => [],
      },
      preferences: {
        getOAuthCustomModels: () => ({}),
      },
      providerRegistry: {
        getAllProvidersRaw: () => rawProviders,
        getAll: () => registryEntries,
        get: (id) => registryEntries.get(id) || null,
        isOAuth: () => false,
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => (id === "local-unconfigured" ? ["local-default"] : []),
        getOAuthProviderIds: () => [],
      },
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.providers["api-missing"].stateSnapshot).toMatchObject({
      state: "needs_auth",
      auth: { required: true, status: "missing" },
    });
    expect(data.providers["api-missing"].api_key).toBe("");
    expect(data.providers["disabled-provider"].api_key).toBe("__saved__");
    expect(data.providers["local-ready"].stateSnapshot).toMatchObject({
      state: "ready",
      auth: { required: false, status: "not_required" },
      selectedModel: { id: "local-model" },
    });
    expect(data.providers["local-unconfigured"].stateSnapshot).toMatchObject({
      state: "unconfigured",
      auth: { required: false, status: "not_required" },
    });
    expect(data.providers["disabled-provider"].stateSnapshot.state).toBe("disabled");
    expect(data.providers["cooldown-provider"].stateSnapshot).toMatchObject({
      state: "cooldown",
      cooldown: { active: true, reason: "429", safeReason: "token=[redacted]" },
    });
    expect(data.providers["error-provider"].stateSnapshot).toMatchObject({
      state: "error",
      safeReason: "api_key=[redacted]",
    });

    expect(JSON.stringify(data.providers["disabled-provider"].stateSnapshot)).not.toContain("sk-disabled-secret");
    expect(JSON.stringify(data.providers["cooldown-provider"].stateSnapshot)).not.toContain("sk-cooldown-secret");
    expect(JSON.stringify(data.providers["error-provider"].stateSnapshot)).not.toContain("sk-error-secret");
  });

  it("provider summary preserves user model metadata and dedupes by model id", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const rawProviders = {
      deepseek: {
        auth_type: "api-key",
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        removed_models: ["deepseek-chat"],
        models: [
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro Custom", context: 262144, maxOutput: 32768, vision: true, reasoning: true },
        ],
      },
    };
    const registryEntries = new Map([
      ["deepseek", { displayName: "DeepSeek", authType: "api-key", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" }],
    ]);
    const engine = {
      availableModels: [{ id: "deepseek-v4-pro", provider: "deepseek" }],
      authStorage: { getOAuthProviders: () => [] },
      preferences: { getOAuthCustomModels: () => ({}) },
      providerRegistry: {
        getAllProvidersRaw: () => rawProviders,
        getAll: () => registryEntries,
        get: (id) => registryEntries.get(id) || null,
        isOAuth: () => false,
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => (id === "deepseek" ? ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"] : []),
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" }),
        getOAuthProviderIds: () => [],
      },
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.providers.deepseek.models).toEqual([
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro Custom", context: 262144, maxOutput: 32768, vision: true, reasoning: true },
    ]);
    expect(data.providers.deepseek.custom_models).toEqual(["deepseek-v4-flash"]);
    expect(data.providers.deepseek.removed_models).toEqual(["deepseek-chat"]);
  });

  it("oauth provider fetch reports registry issue instead of remote /models fallback", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = {
      availableModels: [],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        getApiKey: vi.fn(),
      },
      providerRegistry: { getCredentials: () => null, isOAuth: (id) => id === "openai-codex", getAuthJsonKey: (id) => id },
      configPath: "/tmp/test-config.yaml",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "openai-codex",
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toContain('Pi registry has no available models for provider "openai-codex"');
  });

  it("oauth-named provider with explicit api config uses remote catalog", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "MiniMax-M2.5", context_length: 1000000, max_output_tokens: 80000 },
          { id: "MiniMax-M2", context_length: 1000000, max_output_tokens: 80000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      availableModels: [],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "minimax", name: "MiniMax" }],
        getApiKey: vi.fn(),
      },
      providerRegistry: { getCredentials: () => null, isOAuth: (id) => id === "openai-codex", getAuthJsonKey: (id) => id },
      configPath: "/tmp/test-config.yaml",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "minimax",
        base_url: "https://api.minimaxi.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.refreshAvailableModels).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data).toEqual({
      models: [
        { id: "MiniMax-M2.5", name: "MiniMax-M2.5", context: 1000000, maxOutput: 80000 },
        { id: "MiniMax-M2", name: "MiniMax-M2", context: 1000000, maxOutput: 80000 },
      ],
    });
  });

  it("non-oauth provider fetch uses remote catalog instead of Pi runtime subset", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "qwen3.5-flash", context_length: 131072, max_output_tokens: 16384 },
          { id: "qwen3.5-plus", context_length: 1048576, max_output_tokens: 65536 },
          { id: "qwen3-max", context_length: 262144, max_output_tokens: 32768 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      availableModels: [
        {
          id: "qwen3.5-flash",
          name: "Qwen3.5 Flash",
          provider: "dashscope",
          contextWindow: 131072,
          maxOutputTokens: 16384,
        },
        {
          id: "qwen3.5-plus",
          name: "Qwen3.5 Plus",
          provider: "dashscope",
          contextWindow: 1048576,
          maxOutputTokens: 65536,
        },
      ],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        getApiKey: vi.fn(),
      },
      providerRegistry: { getCredentials: () => null, isOAuth: (id) => id === "openai-codex", getAuthJsonKey: (id) => id },
      configPath: "/tmp/test-config.yaml",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dashscope",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.refreshAvailableModels).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data).toEqual({
      models: [
        { id: "qwen3.5-flash", name: "qwen3.5-flash", context: 131072, maxOutput: 16384 },
        { id: "qwen3.5-plus", name: "qwen3.5-plus", context: 1048576, maxOutput: 65536 },
        { id: "qwen3-max", name: "qwen3-max", context: 262144, maxOutput: 32768 },
      ],
    });
  });

  it("provider chat smoke uses a larger token budget for OpenAI-compatible probes", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "OK" } }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      lynnHome: "/tmp/lynn-provider-smoke-openai",
      authStorage: {
        getApiKey: vi.fn(),
      },
      providerRegistry: {
        get: () => null,
        getAll: () => new Map(),
        getAllProvidersRaw: () => ({}),
        getCredentials: () => null,
        getDefaultModels: () => [],
        isOAuth: () => false,
        getAuthJsonKey: (id) => id,
      },
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: "https://api.example.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        model_id: "demo-reasoner",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, smokeInit] = fetchMock.mock.calls[1];
    const smokeBody = JSON.parse(smokeInit.body);
    expect(smokeBody.max_tokens).toBe(128);
    expect(smokeBody.temperature).toBe(0);
    expect(smokeBody.messages).toEqual([{ role: "user", content: "Reply with OK only." }]);
    const data = await res.json();
    expect(data).toEqual({ ok: true, status: 200, model: "demo-reasoner" });
  });

  it("provider chat smoke uses the larger token budget for anthropic probes too", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "OK" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      lynnHome: "/tmp/lynn-provider-smoke-anthropic",
      authStorage: {
        getApiKey: vi.fn(),
      },
      providerRegistry: {
        get: () => null,
        getAll: () => new Map(),
        getAllProvidersRaw: () => ({}),
        getCredentials: () => null,
        getDefaultModels: () => [],
        isOAuth: () => false,
        getAuthJsonKey: (id) => id,
      },
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: "https://api.anthropic.example",
        api: "anthropic-messages",
        api_key: "sk-test",
        model_id: "claude-demo",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, smokeInit] = fetchMock.mock.calls[0];
    const smokeBody = JSON.parse(smokeInit.body);
    expect(smokeBody.max_tokens).toBe(128);
    expect(smokeBody.temperature).toBe(0);
    expect(smokeBody.messages).toEqual([{ role: "user", content: "Reply with OK only." }]);
    const data = await res.json();
    expect(data).toEqual({ ok: true, status: 200, model: "claude-demo" });
  });
});
