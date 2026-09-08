import { normalizeAutomationExecutor } from "../../shared/automation-executor.js";
export interface AutomationPluginTool { name: string; _pluginId?: string; description?: string; parameters?: unknown; execute(input: unknown): unknown | Promise<unknown> }

export async function executeLightweightAutomation(job: { executor?: unknown; prompt: string }, options: {
  tools: AutomationPluginTool[]; signal: AbortSignal;
}): Promise<string | null> {
  const executor = normalizeAutomationExecutor(job.executor);
  if (executor.kind === "agent_session") return null;
  options.signal.throwIfAborted();
  if (executor.kind === "reminder") return job.prompt;
  const tool = options.tools.find(item => item._pluginId === executor.pluginId && item.name === executor.toolName);
  if (!tool) throw new Error(`Plugin action unavailable: ${executor.toolName}`);
  const result = await tool.execute(executor.input);
  options.signal.throwIfAborted();
  if (result && typeof result === "object" && (result as { isError?: boolean }).isError) throw new Error(`Plugin action failed: ${executor.toolName}`);
  return (typeof result === "string" ? result : JSON.stringify(result) || executor.toolName).slice(0, 16000);
}
