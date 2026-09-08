export type AutomationExecutor =
  | { kind: "agent_session" }
  | { kind: "reminder" }
  | { kind: "plugin_action"; pluginId: string; toolName: string; input: Record<string, unknown> };

export function normalizeAutomationExecutor(value: unknown): AutomationExecutor {
  if (value === undefined || value === null) return { kind: "agent_session" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid automation executor");
  const executor = value as Record<string, unknown>;
  if (executor.kind === "agent_session" || executor.kind === "reminder") return { kind: executor.kind };
  if (executor.kind !== "plugin_action" || typeof executor.pluginId !== "string" || typeof executor.toolName !== "string"
    || !/^[\w-]{1,100}$/.test(executor.pluginId) || !executor.toolName.startsWith(`${executor.pluginId}.`)
    || !executor.input || typeof executor.input !== "object" || Array.isArray(executor.input)) throw new Error("Choose a plugin tool and provide a JSON object as input");
  if (JSON.stringify(executor.input).length > 65536) throw new Error("Automation input exceeds 64 KB");
  return { kind: "plugin_action", pluginId: executor.pluginId, toolName: executor.toolName, input: structuredClone(executor.input as Record<string, unknown>) };
}
