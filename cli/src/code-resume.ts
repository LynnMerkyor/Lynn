import { hasFlag, type ParsedArgs } from "./args.js";
import type { ChatAssistantToolCall, ChatMessage } from "./brain-client.js";
import { normalizePlanItems, type CodePlanItem } from "./plan-tool.js";
import { latestSessionPath, readSessionLinesResult } from "./session/store.js";
import type { ClientToolResult } from "./tools/types.js";

/** Marker embedded in a synthesized tool result when a tool call was interrupted before resume. */
export const RESUME_REPAIR_NOTE = "this tool did not finish — the task was interrupted before resume";
/** Marker embedded in the resume prefix when older transcript turns were dropped to fit the budget. */
export const RESUME_COMPACTION_NOTE = "Earlier transcript turns were compacted to keep the continuation stable";
/** Marker embedded when the JSONL reader skipped crash-torn lines while loading the session. */
export const RESUME_TORN_NOTE = "some transcript lines were unreadable (likely a crash mid-write) and were skipped";

export interface ResumeDiagnostics {
  messages: number;
  repairedTools: number;
  compacted: boolean;
  tornLines: number;
}

export interface ResumeSessionInfo {
  cwd: string | null;
  gitSnapshot: string | null;
  firstPrompt: string | null;
}

export function resumeCommandForSession(sessionPath: string): string {
  return `Lynn code --resume ${shellQuote(sessionPath)} --long "继续这个任务"`;
}

export async function resolveCodeResumePath(raw: string | null, dataDir: string): Promise<string | null> {
  if (!raw) return null;
  const value = raw.trim();
  if (value === "last" || value === "latest") {
    const latest = await latestSessionPath(dataDir);
    if (!latest) throw new Error("No CLI session found to resume. Run a human code task or pass --save-session first.");
    return latest;
  }
  return value;
}

export function shouldSaveCodeSession(args: ParsedArgs, inputData: { json: boolean; mockBrain: boolean; resumePath: string | null }): boolean {
  if (hasFlag(args.flags, "no-save-session", "no-session")) return false;
  if (hasFlag(args.flags, "save-session", "session")) return true;
  const env = process.env.LYNN_CLI_SAVE_SESSION?.trim().toLowerCase();
  if (env === "0" || env === "false" || env === "off" || env === "no") return false;
  if (env) return true;
  if (inputData.resumePath) return true;
  // Human code turns should be recoverable by default, like Codex/Claude Code.
  // JSON/scripted and mock smoke paths stay side-effect-light unless explicitly opted in.
  return !inputData.json && !inputData.mockBrain;
}

export function summarizeResumeMessages(messages: ChatMessage[]): ResumeDiagnostics {
  let repairedTools = 0;
  let compacted = false;
  let tornLines = 0;
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    if (message.role === "tool" && message.content.includes(RESUME_REPAIR_NOTE)) {
      repairedTools += 1;
    } else if (message.role === "user") {
      if (message.content.includes(RESUME_COMPACTION_NOTE)) compacted = true;
      const torn = /torn-lines=(\d+)/.exec(message.content);
      if (torn) tornLines = Number(torn[1]);
    }
  }
  return { messages: messages.length, repairedTools, compacted, tornLines };
}

export function extractLatestPlan(messages: ChatMessage[]): CodePlanItem[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    for (let j = message.tool_calls.length - 1; j >= 0; j -= 1) {
      const call = message.tool_calls[j];
      if (call.function?.name !== "update_plan") continue;
      try {
        const items = normalizePlanItems(JSON.parse(call.function.arguments || "{}"));
        if (items.length) return items;
      } catch {
        // malformed plan args — keep scanning older calls
      }
    }
  }
  return [];
}

export function truncateForResume(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export async function readResumeSessionInfo(sessionPath: string): Promise<ResumeSessionInfo> {
  const { lines } = await readSessionLinesResult(sessionPath);
  let cwd: string | null = null;
  let gitSnapshot: string | null = null;
  let firstPrompt: string | null = null;
  for (const line of lines) {
    if (line.type === "metadata" && line.data) {
      if (typeof line.data.cwd === "string") cwd = line.data.cwd;
      if (typeof line.data.gitSnapshot === "string") gitSnapshot = line.data.gitSnapshot;
    } else if (!firstPrompt && line.type === "user" && typeof line.content === "string" && line.content.trim()) {
      firstPrompt = line.content.trim();
    }
  }
  return { cwd, gitSnapshot, firstPrompt };
}

export async function loadResumeMessages(sessionPath: string, maxChars = 24_000): Promise<ChatMessage[]> {
  const { lines, skipped } = await readSessionLinesResult(sessionPath);
  const turns = lines
    .flatMap((line): ChatMessage[] => {
      if (line.type === "user" && typeof line.content === "string" && line.content.trim()) {
        return [{ role: "user", content: line.content }];
      }
      if (line.type === "assistant") {
        const toolCalls = sessionToolCalls(line.data?.tool_calls);
        const content = typeof line.content === "string" ? line.content : "";
        if (!content.trim() && !toolCalls.length) return [];
        return [{
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        }];
      }
      if (line.type === "tool" && typeof line.content === "string" && line.content.trim()) {
        const toolCallId = typeof line.data?.tool_call_id === "string" ? line.data.tool_call_id : "";
        const name = typeof line.data?.name === "string" ? line.data.name : undefined;
        if (!toolCallId) return [];
        return [{ role: "tool", tool_call_id: toolCallId, name, content: line.content }];
      }
      return [];
    });
  const groups = buildResumableMessageGroups(turns);
  const selected: ChatMessage[] = [];
  let chars = 0;
  let firstIncluded = groups.length;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    const len = group.reduce((sum, turn) => sum + resumeMessageCost(turn), 0);
    if (selected.length && chars + len > maxChars) break;
    selected.unshift(...group);
    chars += len;
    firstIncluded = i;
  }
  const droppedGroups = firstIncluded;
  if (droppedGroups > 0) {
    selected.unshift({
      role: "user",
      content: `[Lynn CLI resumed this coding task from ${sessionPath}. ${RESUME_COMPACTION_NOTE}: ${droppedGroups} earlier turn group(s) dropped — the original task above is pinned. Ask the user or inspect files if missing details matter.]`,
    });
    if (groups.length > 0) selected.unshift(...groups[0]);
  }
  if (skipped > 0) {
    selected.unshift({
      role: "user",
      content: `[Lynn CLI torn-lines=${skipped}: ${RESUME_TORN_NOTE}. Earlier history may have gaps — inspect files or ask the user if a detail seems missing.]`,
    });
  }
  return selected;
}

export function buildResumableMessageGroups(turns: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role === "assistant" && turn.tool_calls?.length) {
      const required = new Set(turn.tool_calls.map((toolCall) => toolCall.id));
      const found = new Set<string>();
      const tools: ChatMessage[] = [];
      let j = i + 1;
      while (j < turns.length) {
        const candidate = turns[j];
        if (candidate.role !== "tool" || !candidate.tool_call_id || !required.has(candidate.tool_call_id)) break;
        tools.push(candidate);
        found.add(candidate.tool_call_id);
        j += 1;
        if (found.size === required.size) break;
      }
      if (found.size === required.size) {
        groups.push([turn, ...tools]);
      } else {
        const missing: ChatMessage[] = (turn.tool_calls || [])
          .filter((toolCall) => !found.has(toolCall.id))
          .map((toolCall) => ({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function?.name,
            content: `Tool result for ${toolCall.function?.name || "tool"}:\n[Lynn CLI: ${RESUME_REPAIR_NOTE}. Re-run it if its result is needed.]`,
          }));
        groups.push([turn, ...tools, ...missing]);
      }
      i = Math.max(i, j - 1);
      continue;
    }
    if (turn.role === "tool") continue;
    groups.push([turn]);
  }
  return groups;
}

export function formatToolResultForLoop(result: ClientToolResult, maxChars = 12_000): string {
  const json = JSON.stringify(result, null, 2);
  if (json.length <= maxChars) return json;
  return [
    json.slice(0, maxChars),
    "",
    `[Lynn CLI truncated this tool result from ${json.length} chars to ${maxChars} chars to keep the long-running coding loop stable. Use a narrower grep/read_file request if more detail is needed.]`,
  ].join("\n");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resumeMessageCost(message: ChatMessage): number {
  const contentCost = typeof message.content === "string"
    ? message.content.length
    : JSON.stringify(message.content).length;
  const toolCallCost = message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0;
  return contentCost + toolCallCost;
}

function sessionToolCalls(value: unknown): ChatAssistantToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ChatAssistantToolCall => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    const fn = record.function;
    return typeof record.id === "string"
      && record.type === "function"
      && !!fn
      && typeof fn === "object"
      && !Array.isArray(fn)
      && typeof (fn as Record<string, unknown>).name === "string"
      && typeof (fn as Record<string, unknown>).arguments === "string";
  });
}
