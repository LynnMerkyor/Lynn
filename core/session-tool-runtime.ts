import { createModuleLogger } from "../lib/debug-log.js";
import { lookupToolTier } from "../shared/known-models.js";
import { isNativeToolCallingDisabled } from "../shared/model-tool-capabilities.js";
import type { ResolvedModel } from "./types.js";

const log = createModuleLogger("session");

type AnyRecord = Record<string, any>;
export type ToolLike = AnyRecord & { name: string };
export type ModelLike = ResolvedModel | AnyRecord | null;

const MINIMAL_CUSTOM_TOOLS = new Set([
  "web_search", "web_fetch", "stock_market", "weather", "live_news", "sports_score",
  "knowledge_query",
]);

const STANDARD_CUSTOM_TOOLS = new Set([
  "web_search", "web_fetch", "stock_market", "weather", "live_news", "sports_score", "todo", "present_files", "create_docx", "create_report", "notify",
  "search_memory", "pin_memory", "unpin_memory",
  "recall_experience", "record_experience",
  "knowledge_index", "knowledge_query",
  "tts_speak",
  "generate_image",
]);

const OPENAI_RESPONSES_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function filterCustomToolsByTier(customTools: ToolLike[], tier: string | null | undefined) {
  if (!tier || tier === "full") return customTools;
  if (tier === "none") return [];
  const allowed = tier === "minimal" ? MINIMAL_CUSTOM_TOOLS : STANDARD_CUSTOM_TOOLS;
  return customTools.filter((tool: ToolLike) => allowed.has(tool.name));
}

function isStrictToolNameModel(model: ModelLike) {
  const provider = String(model?.provider || "").toLowerCase();
  const api = String(model?.api || "").toLowerCase();
  return provider === "openai"
    || provider === "openai-codex"
    || provider === "openai-codex-oauth"
    || api === "openai-responses"
    || api === "openai-codex-responses";
}

function sanitizeToolName(name: unknown) {
  const sanitized = String(name || "tool")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return sanitized || "tool";
}

export function normalizeCustomToolsForModel(customTools: ToolLike[], model: ModelLike) {
  if (!Array.isArray(customTools) || customTools.length === 0) return [];
  if (!isStrictToolNameModel(model)) return customTools;

  const seen = new Set<string>();
  let changed = 0;
  const normalized = customTools.map((tool) => {
    const originalName = String(tool?.name || "");
    let nextName = sanitizeToolName(originalName);
    let suffix = 2;
    while (seen.has(nextName)) {
      const base = nextName.slice(0, Math.max(1, 64 - String(suffix).length - 1));
      nextName = `${base}_${suffix}`;
      suffix += 1;
    }
    seen.add(nextName);
    if (OPENAI_RESPONSES_TOOL_NAME_RE.test(originalName) && originalName === nextName) return tool;
    changed += 1;
    return { ...tool, name: nextName, _aliasOf: originalName };
  });

  if (changed > 0) {
    log.warn(`[model-tools] normalized ${changed}/${customTools.length} tool name(s) for ${model?.provider || "?"}/${model?.id || model?.name || "?"}`);
  }
  return normalized;
}

export function shouldSuppressClientToolSchema(_model: ModelLike) {
  return false;
}

export function resolveToolTier(model: ModelLike) {
  if (!model) return null;
  if (isNativeToolCallingDisabled(model)) return "none";
  const tier = lookupToolTier(model.provider, model.id);
  if (tier) return tier;
  const contextWindow = model.contextWindow;
  if (contextWindow && contextWindow < 32_000) return "minimal";
  return null;
}

export function getBuiltinToolNames(tools: ToolLike[]) {
  return tools.map((tool: ToolLike) => tool.name);
}
