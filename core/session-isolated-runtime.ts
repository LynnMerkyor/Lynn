import { findModel } from "../shared/model-ref.js";
import { resolveRoleDefaultModel } from "../shared/assistant-role-models.js";
import {
  normalizeCustomToolsForModel,
  shouldSuppressClientToolSchema,
  type ToolLike,
} from "./session-tool-runtime.js";
import type { ResolvedModel } from "./types.js";

type AnyRecord = Record<string, any>;
type AgentLike = AnyRecord;
type AvailableModelLike = AnyRecord & { id: string; provider?: string | null };
type ModelLike = ResolvedModel | AnyRecord | null;

/** 巡检/定时任务默认工具白名单 */
export const PATROL_TOOLS_DEFAULT = [
  "search_memory", "pin_memory", "unpin_memory",
  "recall_experience", "record_experience",
  "web_search", "web_fetch",
  "todo", "notify",
  "present_files", "message_agent",
];

export function resolveIsolatedExecutionModel(opts: {
  explicitModel?: ModelLike;
  targetAgent: AgentLike;
  availableModels: AvailableModelLike[];
  defaultModel?: ModelLike;
}) {
  if (opts.explicitModel) {
    return {
      model: opts.explicitModel,
      requestedModelId: null,
      usedFallback: false,
    };
  }

  const agentPreferredRef = opts.targetAgent.config?.models?.chat;
  const requestedModelId = typeof agentPreferredRef === "object"
    ? agentPreferredRef?.id
    : agentPreferredRef;
  const requestedModelProvider = typeof agentPreferredRef === "object"
    ? agentPreferredRef?.provider
    : undefined;
  const targetRole = opts.targetAgent.config?.agent?.yuan || opts.targetAgent.yuan || null;

  let model = requestedModelId
    ? findModel(opts.availableModels, requestedModelId, requestedModelProvider) as ModelLike
    : null;
  if (!model) {
    model = resolveRoleDefaultModel(opts.availableModels, targetRole) as ModelLike;
  }
  if (!model) {
    model = opts.defaultModel || null;
  }

  return {
    model,
    requestedModelId: requestedModelId || null,
    usedFallback: !!(requestedModelId && model && model.id !== requestedModelId),
  };
}

export function prepareIsolatedToolRuntime(opts: {
  execCwd: string;
  targetAgent: AgentLike;
  execModel: ModelLike;
  buildTools: (cwd: string, customTools?: unknown, buildOpts?: AnyRecord) => { tools: ToolLike[]; customTools: ToolLike[] };
  getSessionPath: () => string | null;
  toolFilter?: string[];
  builtinFilter?: string[];
}) {
  const { tools: allBuiltinTools, customTools: allCustomTools } = opts.buildTools(
    opts.execCwd,
    opts.targetAgent.tools,
    {
      agentDir: opts.targetAgent.agentDir,
      workspace: opts.execCwd,
      getSessionPath: opts.getSessionPath,
    },
  );

  const patrolAllowed = opts.toolFilter
    || opts.targetAgent.config?.desk?.patrol_tools
    || PATROL_TOOLS_DEFAULT;
  const allowSet = new Set(patrolAllowed);
  const suppressClientTools = shouldSuppressClientToolSchema(opts.execModel);
  const actCustomTools = suppressClientTools
    ? []
    : normalizeCustomToolsForModel(
        allCustomTools.filter((tool: ToolLike) => allowSet.has(tool.name)),
        opts.execModel,
      );

  const actTools = suppressClientTools
    ? []
    : (opts.builtinFilter
        ? allBuiltinTools.filter((tool: ToolLike) => opts.builtinFilter?.includes(tool.name))
        : allBuiltinTools);

  return {
    tools: actTools,
    customTools: actCustomTools,
    suppressClientTools,
  };
}
