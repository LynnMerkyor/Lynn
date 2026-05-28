import path from "path";

export function resolveEditSnapshotPath(session: any, engine: any, rawPath: any) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);

  const cwd = session?.sessionManager?.getCwd?.() || engine.cwd || process.cwd();
  return path.resolve(cwd, trimmed);
}

export function isAssistantStreamScopedEvent(event: any) {
  return event?.type === "message_update"
    || event?.type === "tool_execution_start"
    || event?.type === "tool_execution_end"
    || event?.type === "turn_end"
    || event?.type === "provider_meta"
    || event?.type === "provider_update"
    || event?.type === "lynn.provider"
    || event?.object === "lynn.provider";
}
