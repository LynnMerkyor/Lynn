import type { ChatMessage } from "./brain-client.js";
import { RESUME_COMPACTION_NOTE } from "./code-resume.js";

const RUNTIME_COMPACTION_MAX_CHARS = 150_000;
const RUNTIME_COMPACTION_KEEP_GROUPS = 8;

export function compactRuntimeMessages(
  messages: ChatMessage[],
  maxChars = RUNTIME_COMPACTION_MAX_CHARS,
  keepGroups = RUNTIME_COMPACTION_KEEP_GROUPS,
  anchorCount = messages[0]?.role === "system" ? 1 : 0,
): number {
  if (messages.length < keepGroups * 2) return 0;
  const total = messages.reduce((sum, message) => sum + runtimeMessageCost(message), 0);
  if (total <= maxChars) return 0;
  const prefixCount = Math.max(0, Math.min(anchorCount, messages.length));
  const suffixGroups = buildRuntimeMessageGroups(messages.slice(prefixCount)).slice(-keepGroups);
  const keep = suffixGroups.flat();
  const keepSet = new Set(keep);
  const compactable = messages.slice(prefixCount).filter((message) => !keepSet.has(message));
  if (compactable.length < 2) return 0;
  const summary = summarizeRuntimeMessages(compactable);
  messages.splice(prefixCount, messages.length - prefixCount, {
    role: "user",
    content: `[Lynn CLI runtime compaction: ${RESUME_COMPACTION_NOTE}. Compacted ${compactable.length} older message(s) while preserving the active goal, recent tool results, and current plan. Summary:\n${summary}]`,
  }, ...keep);
  return compactable.length;
}

function buildRuntimeMessageGroups(turns: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role === "assistant" && turn.tool_calls?.length) {
      const required = new Set(turn.tool_calls.map((toolCall) => toolCall.id));
      const group = [turn];
      let j = i + 1;
      while (j < turns.length && required.size > 0) {
        const candidate = turns[j];
        if (candidate.role !== "tool" || !candidate.tool_call_id || !required.has(candidate.tool_call_id)) break;
        group.push(candidate);
        required.delete(candidate.tool_call_id);
        j += 1;
      }
      groups.push(group);
      i = Math.max(i, j - 1);
      continue;
    }
    if (turn.role === "tool") continue;
    groups.push([turn]);
  }
  return groups;
}

function summarizeRuntimeMessages(messages: readonly ChatMessage[]): string {
  return messages
    .map((message, index) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      const clean = content.replace(/\s+/g, " ").trim();
      const label = message.role === "assistant" && message.tool_calls?.length
        ? `assistant tool_calls=${message.tool_calls.map((toolCall) => toolCall.function.name).join(",")}`
        : message.role;
      return `${index + 1}. ${label}: ${clean.slice(0, 360)}${clean.length > 360 ? "..." : ""}`;
    })
    .join("\n")
    .slice(0, 12_000);
}

function runtimeMessageCost(message: ChatMessage): number {
  const contentCost = typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
  const toolCallCost = message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0;
  return contentCost + toolCallCost;
}
