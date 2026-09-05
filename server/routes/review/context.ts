/** Review context layer. Extracted without changing policy or routing. */
import fs from "fs";
import path from "path";
import { type ReviewRouteEngine, type SessionContextPack, type ReviewContextPack, type ToolUseBlock, type SessionMessageBlock, type SessionMessageRecord } from './types.js';
import { MAX_CONTEXT_PREVIEW_CHARS, MAX_SESSION_LINES, MAX_TOOL_ITEMS, asRecord, cleanPreviewText } from './policy.js';

export function summarizeToolUseBlocks(content: unknown): Array<{ name: string; argsPreview: string }> {
  if (!Array.isArray(content)) return [];
  const toolUses: Array<{ name: string; argsPreview: string }> = [];
  for (const block of content) {
    const record = asRecord(block) as ToolUseBlock | null;
    if (!record || (record.type !== "tool_use" && record.type !== "toolCall")) continue;
    const rawArgs = record.input || record.arguments;
    let argsPreview = "";
    if (rawArgs && typeof rawArgs === "object") {
      const entries = Object.entries(rawArgs)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .slice(0, 3)
        .map(([key, value]) => {
          const rendered = typeof value === "string" ? value : JSON.stringify(value);
          return `${key}=${String(rendered).slice(0, 80)}`;
        });
      argsPreview = entries.join(", ");
    }
    toolUses.push({
      name: typeof record.name === "string" ? record.name : "unknown_tool",
      argsPreview,
    });
    if (toolUses.length >= MAX_TOOL_ITEMS) break;
  }
  return toolUses;
}

export function buildSessionContextPack(sessionPath: string | null | undefined): SessionContextPack | null {
  if (!sessionPath || !fs.existsSync(sessionPath)) return null;
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean).slice(-MAX_SESSION_LINES);
    const entries: Array<{ role: string; text: string }> = [];
    let assistantText = "";
    let userText = "";
    let toolUses: Array<{ name: string; argsPreview: string }> = [];

    for (const line of lines) {
      if (entries.length >= MAX_SESSION_LINES) break;
      let parsed: SessionMessageRecord;
      try {
        parsed = JSON.parse(line) as SessionMessageRecord;
      } catch {
        continue;
      }
      if (parsed.type !== "message" || !parsed.message) continue;
      const msg = parsed.message;
      const role = typeof msg.role === "string" ? msg.role : "unknown";
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = content
        .filter((block): block is SessionMessageBlock & { text: string } => {
          const record = asRecord(block) as SessionMessageBlock | null;
          return record?.type === "text" && typeof record.text === "string";
        })
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (role === "user" && text) userText = cleanPreviewText(text, 1200);
      if (role === "assistant" && text) assistantText = cleanPreviewText(text, 1800);
      if (role === "assistant") {
        const summarizedTools = summarizeToolUseBlocks(content);
        if (summarizedTools.length) toolUses = summarizedTools;
      }
      entries.push({ role, text: cleanPreviewText(text, 600) });
    }

    return {
      userText,
      assistantText,
      toolUses,
      recentMessages: entries.slice(-8),
    };
  } catch {
    return null;
  }
}

export function buildReviewContextPack(context: string, engine: ReviewRouteEngine, sessionPathOverride: string | null = null): ReviewContextPack {
  const sessionPath = sessionPathOverride || engine.currentSessionPath || null;
  const gitContext = sessionPath
    ? {
        sessionPath,
        sessionFile: path.basename(sessionPath),
      }
    : null;

  const sessionContext = buildSessionContextPack(sessionPath);
  const workspacePath = engine.deskCwd || engine.homeCwd || null;

  return {
    request: cleanPreviewText(context, MAX_CONTEXT_PREVIEW_CHARS),
    gitContext,
    sessionContext,
    ...(workspacePath ? { workspacePath } : {}),
  };
}
