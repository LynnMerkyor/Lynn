import { existsSync, readFileSync, writeFileSync } from "fs";

type AnyRecord = Record<string, any>;

export interface TruncateVisibleMessageResult {
  ok: boolean;
  reason?: string;
}

function asArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value as AnyRecord[] : [];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: AnyRecord) => block?.type === "text" && block.text)
    .map((block: AnyRecord) => String(block.text || ""))
    .join("");
}

function hasImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block: AnyRecord) => block?.type === "image" || block?.source?.type === "base64");
}

function hasToolUseContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block: AnyRecord) => block?.type === "tool_use" || block?.type === "tool-call" || block?.name);
}

function isVisibleHistoryMessage(message: AnyRecord | null | undefined): boolean {
  if (!message || (message.role !== "user" && message.role !== "assistant")) return false;
  const content = message.content;
  if (message.role === "user") {
    return !!textFromContent(content).trim() || hasImageContent(content);
  }
  return !!textFromContent(content).trim() || hasToolUseContent(content);
}

function readEntriesFromFile(sessionPath: string): AnyRecord[] {
  if (!sessionPath || !existsSync(sessionPath)) return [];
  const entries: AnyRecord[] = [];
  for (const line of readFileSync(sessionPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Preserve the safety posture of the history loader: malformed tail lines
      // should not make edit-resend crash the whole chat route.
    }
  }
  return entries;
}

function writeEntriesToFile(sessionPath: string, entries: AnyRecord[]): void {
  const content = entries.length ? `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n` : "";
  writeFileSync(sessionPath, content, "utf8");
}

function refreshSessionManager(manager: AnyRecord, entries: AnyRecord[]): void {
  manager.fileEntries = entries;
  if (typeof manager._buildIndex === "function") {
    manager._buildIndex();
  } else {
    manager.byId = new Map();
    manager.labelsById = new Map();
    manager.leafId = null;
    for (const entry of entries) {
      if (entry.type === "session") continue;
      manager.byId.set(entry.id, entry);
      manager.leafId = entry.id;
      if (entry.type === "label") {
        if (entry.label) manager.labelsById.set(entry.targetId, entry.label);
        else manager.labelsById.delete(entry.targetId);
      }
    }
  }
  manager.flushed = true;
}

export function truncateSessionBeforeVisibleMessage(
  session: AnyRecord | null | undefined,
  sessionPath: string,
  visibleMessageId: string,
): TruncateVisibleMessageResult {
  const targetVisibleIndex = Number.parseInt(String(visibleMessageId), 10);
  if (!Number.isFinite(targetVisibleIndex) || targetVisibleIndex < 0) {
    return { ok: false, reason: "invalid-message-id" };
  }

  const manager = session?.sessionManager;
  const sourceEntries = asArray(manager?.fileEntries);
  const entries = sourceEntries.length ? [...sourceEntries] : readEntriesFromFile(sessionPath);
  if (!entries.length) return { ok: false, reason: "empty-session" };

  let visibleIndex = 0;
  let truncateAt = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.type !== "message" || !isVisibleHistoryMessage(entry.message)) continue;
    if (visibleIndex === targetVisibleIndex) {
      if (entry.message?.role !== "user") return { ok: false, reason: "target-not-user-message" };
      truncateAt = i;
      break;
    }
    visibleIndex += 1;
  }
  if (truncateAt < 0) return { ok: false, reason: "message-not-found" };

  const nextEntries = entries.slice(0, truncateAt);
  writeEntriesToFile(sessionPath, nextEntries);

  if (manager) {
    refreshSessionManager(manager, nextEntries);
    try {
      const context = typeof manager.buildSessionContext === "function" ? manager.buildSessionContext() : null;
      const messages = Array.isArray(context?.messages) ? context.messages : [];
      session?.agent?.replaceMessages?.(messages);
      if (Array.isArray(session.messages)) {
        session.messages.splice(0, session.messages.length, ...messages);
      }
    } catch {
      // The file and manager entries are already authoritative; failing to refresh
      // the in-memory Agent here should not keep the old branch alive.
    }
  }

  return { ok: true };
}
