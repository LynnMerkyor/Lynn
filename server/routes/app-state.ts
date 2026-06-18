import { Hono } from "hono";
import { buildReviewConfig } from "./review.js";
import { loadProjectInstructions } from "../../lib/project-instructions.js";

type ModelRef = {
  id: string;
  provider: string | null;
};

type CurrentModel = {
  id?: string | null;
  name?: string | null;
  provider?: string | null;
};

type ProviderConfig = {
  models?: string[];
};

type AppStateSkill = {
  enabled?: boolean;
  hidden?: boolean;
  source?: string;
};

type AppStateTask = {
  id: string;
  title: string;
  status: string;
  progress?: {
    currentLabel?: string | null;
  } | null;
  snapshot?: unknown;
};

type TaskRuntime = {
  listTasks?: () => AppStateTask[];
};

type SearchConfig = {
  provider?: string | null;
  base_url?: string | null;
  api_key?: string | null;
};

interface AppStateRouteEngine {
  currentAgentId?: string | null;
  agentName?: string | null;
  currentModel?: CurrentModel | null;
  config?: {
    api?: {
      provider?: string | null;
    };
    models?: {
      chat?: unknown;
    };
    providers?: Record<string, ProviderConfig | null | undefined>;
  };
  preferences?: {
    getPrimaryAgent?: () => string | null | undefined;
  };
  agent?: {
    config?: {
      agent?: {
        yuan?: string | null;
      };
    };
    yuan?: string | null;
  };
  getSharedModels?: () => {
    utility?: unknown;
    utility_large?: unknown;
  } | null | undefined;
  getSearchConfig?: () => SearchConfig | null | undefined;
  getSecurityMode?: () => string | null | undefined;
  securityMode?: string | null;
  planMode?: boolean;
  getHomeFolder?: () => string | null | undefined;
  getTrustedRoots?: () => string[];
  getAllSkills?: (agentId?: string | null) => AppStateSkill[];
  mcpManager?: {
    serverCount?: number;
    toolCount?: number;
  } | null;
  cwd?: string | null;
}

function toModelRef(value: unknown): ModelRef | null {
  if (!value) return null;
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, provider: null } : null;
  }
  if (typeof value === "object" && value !== null) {
    const model = value as { id?: unknown; provider?: unknown };
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) return null;
    const provider = typeof model.provider === "string" && model.provider.trim()
      ? model.provider.trim()
      : null;
    return { id, provider };
  }
  return null;
}

function resolvePreferredProviderId(
  engine: AppStateRouteEngine,
  currentModel: CurrentModel | null,
): string | null {
  if (currentModel?.provider) return currentModel.provider;

  const config = engine.config || {};
  const apiProvider = typeof config.api?.provider === "string" ? config.api.provider.trim() : "";
  if (apiProvider) return apiProvider;

  const chatModel = toModelRef(config.models?.chat);
  const chatModelId = chatModel?.id || "";
  if (!chatModelId) return null;

  const providers = config.providers || {};
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (Array.isArray(providerConfig?.models) && providerConfig.models.some((entry: unknown) => {
      if (typeof entry === "string") return entry === chatModelId;
      return !!entry && typeof entry === "object" && (entry as { id?: unknown }).id === chatModelId;
    })) {
      return providerId;
    }
  }

  return null;
}

function buildTaskSnapshot(taskRuntime?: TaskRuntime | null) {
  if (!taskRuntime || typeof taskRuntime.listTasks !== "function") return null;
  const tasks = taskRuntime.listTasks();
  const active = tasks.filter((task) => ["pending", "running", "waiting_approval"].includes(task.status));
  return {
    activeCount: active.length,
    waitingApprovalCount: active.filter((task) => task.status === "waiting_approval").length,
    runningCount: active.filter((task) => task.status === "running").length,
    pendingCount: active.filter((task) => task.status === "pending").length,
    recent: active
      .slice(0, 5)
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        currentLabel: task.progress?.currentLabel || null,
        snapshot: task.snapshot || null,
      })),
  };
}

function buildCapabilitySnapshot(engine: AppStateRouteEngine) {
  const allSkills = engine.getAllSkills?.(engine.currentAgentId) || [];
  const enabledSkills = allSkills.filter((skill) => skill.enabled && !skill.hidden);
  const learnedSkills = enabledSkills.filter((skill) => skill.source === "learned").length;
  const externalSkills = enabledSkills.filter((skill) => skill.source === "external").length;
  const mcpManager = engine.mcpManager || null;
  const cwd = engine.cwd || null;
  const instructions = cwd ? loadProjectInstructions(cwd) : { layers: [] };

  return {
    enabledSkills: enabledSkills.length,
    learnedSkills,
    externalSkills,
    mcp: {
      servers: mcpManager?.serverCount || 0,
      tools: mcpManager?.toolCount || 0,
    },
    projectInstructions: {
      layers: Array.isArray(instructions.layers) ? instructions.layers.length : 0,
      files: Array.isArray(instructions.layers)
        ? instructions.layers.map((layer) => layer.file)
        : [],
    },
  };
}

type AppStateRouteOptions = {
  taskRuntime?: TaskRuntime | null;
};

export function createAppStateRoute(
  engine: AppStateRouteEngine,
  { taskRuntime }: AppStateRouteOptions = {},
): Hono {
  const route = new Hono();

  route.get("/app-state", async (c) => {
    try {
      const currentModel = engine.currentModel
        ? {
            id: engine.currentModel.id || null,
            name: engine.currentModel.name || engine.currentModel.id || null,
            provider: engine.currentModel.provider || null,
          }
        : null;
      const sharedModels = engine.getSharedModels?.() || {};
      const search = engine.getSearchConfig?.() || {};
      const review = buildReviewConfig(engine);

      return c.json({
        agent: {
          currentAgentId: engine.currentAgentId || null,
          primaryAgentId: engine.preferences?.getPrimaryAgent?.() || null,
          name: engine.agentName || null,
          yuan: engine.agent?.config?.agent?.yuan || engine.agent?.yuan || null,
        },
        model: {
          current: currentModel,
          utility: toModelRef(sharedModels.utility),
          utilityLarge: toModelRef(sharedModels.utility_large),
          preferredProviderId: resolvePreferredProviderId(engine, currentModel),
        },
        review,
        security: {
          mode: engine.getSecurityMode?.() || engine.securityMode || "authorized",
          planMode: !!engine.planMode,
        },
        desk: {
          homeFolder: engine.getHomeFolder?.() || null,
          trustedRoots: engine.getTrustedRoots?.() || [],
        },
        search: {
          provider: search.provider || null,
          configured: !!(
            search.provider && (
              (search.provider === "searxng" && search.base_url)
              || search.api_key
            )
          ),
        },
        capabilities: buildCapabilitySnapshot(engine),
        tasks: buildTaskSnapshot(taskRuntime),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return route;
}
