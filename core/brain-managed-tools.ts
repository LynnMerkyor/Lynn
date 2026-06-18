type ToolLike = { name?: unknown };

const BRAIN_MANAGED_CUSTOM_TOOL_NAMES = [
  "stock_market",
  "weather",
  "live_news",
  "sports_score",
  "web_search",
  "web_fetch",
  "exchange_rate",
  "calendar",
  "unit_convert",
  "express_tracking",
] as const;

export const BRAIN_MANAGED_CUSTOM_TOOLS = new Set<string>(BRAIN_MANAGED_CUSTOM_TOOL_NAMES);

export function normalizeBrainManagedToolName(name: unknown): string {
  return String(name || "").trim();
}

export function isBrainManagedCustomToolName(name: unknown): boolean {
  return BRAIN_MANAGED_CUSTOM_TOOLS.has(normalizeBrainManagedToolName(name));
}

export function filterOutBrainManagedCustomTools<T extends ToolLike>(tools: T[]): T[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools.filter((tool) => !isBrainManagedCustomToolName(tool?.name));
}
