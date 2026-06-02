import type { ChatMessage } from "./brain-client.js";

export const CHAT_COMPACTION_NOTE = "Earlier chat turns were compacted to keep this conversation stable";
export const CHAT_COMPACTION_MAX_CHARS = 120_000;
export const CHAT_COMPACTION_KEEP_GROUPS = 8;

export interface ChatCompactionResult {
  compactedMessages: number;
  summary: string | null;
}

export function compactChatMessages(
  messages: ChatMessage[],
  maxChars = CHAT_COMPACTION_MAX_CHARS,
  keepGroups = CHAT_COMPACTION_KEEP_GROUPS,
): ChatCompactionResult {
  const total = messages.reduce((sum, message) => sum + chatMessageCost(message), 0);
  if (total <= maxChars) return { compactedMessages: 0, summary: null };
  const prefixCount = leadingSystemCount(messages);
  const groups = buildChatGroups(messages.slice(prefixCount));
  if (groups.length <= keepGroups + 1) return { compactedMessages: 0, summary: null };
  const anchor = groups[0];
  const suffix = groups.slice(-keepGroups);
  const suffixSet = new Set(suffix.flat());
  const compactable = groups.slice(1).filter((group) => group.some((message) => !suffixSet.has(message)));
  const compacted = compactable.flat();
  if (compacted.length < 2) return { compactedMessages: 0, summary: null };
  const summary = summarizeChatMessages(compacted);
  messages.splice(prefixCount, messages.length - prefixCount, ...anchor, {
    role: "user",
    content: `[Lynn CLI chat compaction: ${CHAT_COMPACTION_NOTE}. Compacted ${compacted.length} older message(s) while preserving the original request and recent turns. Summary:\n${summary}]`,
  }, ...suffix.flat());
  return { compactedMessages: compacted.length, summary };
}

function leadingSystemCount(messages: readonly ChatMessage[]): number {
  let count = 0;
  while (messages[count]?.role === "system") count += 1;
  return count;
}

function buildChatGroups(turns: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const current = turns[i];
    if (current.role === "user" && turns[i + 1]?.role === "assistant") {
      groups.push([current, turns[i + 1]]);
      i += 1;
      continue;
    }
    groups.push([current]);
  }
  return groups;
}

function summarizeChatMessages(messages: readonly ChatMessage[]): string {
  const lines = messages.map((message, index) => {
    const text = chatContentText(message.content).replace(/\s+/g, " ").trim();
    const clipped = text.slice(0, 360);
    return `${index + 1}. ${message.role}: ${clipped}${text.length > 360 ? "..." : ""}`;
  });
  const sources = extractUrls(messages).slice(0, 12);
  if (sources.length) {
    lines.push(`Sources kept: ${sources.join(" · ")}`);
  }
  return lines.join("\n").slice(0, 12_000);
}

function extractUrls(messages: readonly ChatMessage[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const message of messages) {
    const text = chatContentText(message.content);
    for (const match of text.matchAll(/https?:\/\/[^\s)\]'"<>]+/g)) {
      const url = match[0].replace(/[.,;:]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function chatMessageCost(message: ChatMessage): number {
  return JSON.stringify(message).length;
}

function chatContentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "image_url") return `[image:${part.image_url?.url || "attached"}]`;
    if (part.type === "input_audio") return `[audio:${part.input_audio?.format || "attached"}]`;
    if (part.type === "video_url") return `[video:${part.video_url?.url || "attached"}]`;
    return JSON.stringify(part);
  }).join("\n");
}
