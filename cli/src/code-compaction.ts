/**
 * code-compaction.ts — LLM-backed context compaction for the coding loop.
 *
 * The old compactor summarized by slicing each message to 360 chars, which loses
 * exactly the information a long task needs (what changed, which errors were hit,
 * what the user asked for). This module follows Claude Code's shape:
 *
 *   transcript → one summarization call with a fixed 9-section prompt
 *              → boundary message + summary + refreshed files + recent turns
 *
 * Everything is injected so the loop owns the model call and tests can use a stub.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "./brain-client.js";
import { recentReadPaths } from "./tools/read-state.js";

export interface CompactionOptions {
  messages: ChatMessage[];
  /** Conversation groups to keep verbatim at the tail. */
  keepGroups?: number;
  /** Compact once the conversation exceeds this many characters. */
  maxChars?: number;
  /** Leading messages (system prompt) that must never be summarized. */
  anchorCount?: number;
  /** Per-message cap while rendering the transcript. */
  perMessageChars?: number;
  cwd: string;
  runId: string;
  /** Performs one no-tools completion. Supplied by the loop. */
  complete: (prompt: string) => Promise<string>;
  /** Re-read recently touched files after compaction (default true). */
  refreshFiles?: boolean;
}

export interface CompactionOutcome {
  messages: ChatMessage[];
  compactedCount: number;
  summary: string;
  boundary: ChatMessage;
  refreshMessage: ChatMessage | null;
}

const DEFAULT_KEEP_GROUPS = 6;
const DEFAULT_MAX_CHARS = 150_000;
const DEFAULT_PER_MESSAGE_CHARS = 2_000;
const TRANSCRIPT_LIMIT = 120_000;
const REFRESH_FILES = 5;
const REFRESH_PER_FILE_CHARS = 4_000;
const REFRESH_TOTAL_CHARS = 12_000;

export const COMPACTION_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary will be placed at the start of a continuing session; newer messages that build on it follow after it. Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.
Write the summary in the same language the user writes in.

Your summary must include these sections:
1. Primary Request and Intent: every explicit user request and constraint, in detail.
2. Key Technical Concepts: technologies, frameworks, commands, and conventions in play.
3. Files and Code Sections: files read, created, or modified, why each matters, and the important snippets.
4. Errors and fixes: what failed, what was tried, and what the user said about it.
5. Problem Solving: what is solved and what is still being investigated.
6. All user messages: list every non-tool user message. Preserve security-relevant instructions and constraints verbatim so they remain in effect after compaction.
7. Pending Tasks: work explicitly requested but not finished.
8. Current Work: precisely what was being worked on immediately before this summary, including file names and snippets.
9. Optional Next Step: the next step, quoting the most recent conversation verbatim so the task cannot drift. If the last task concluded, say so instead of inventing work.

Output only a <summary>…</summary> block. Do not call tools. Do not add commentary outside the block.`;

/** Group assistant tool_calls with their tool results so a group is never split. */
export function groupConversation(messages: readonly ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.tool_calls?.length) {
      const group: ChatMessage[] = [message];
      const pending = new Set(message.tool_calls.map((call) => call.id));
      let cursor = index + 1;
      while (cursor < messages.length && pending.size > 0) {
        const candidate = messages[cursor]!;
        if (candidate.role !== "tool" || !candidate.tool_call_id || !pending.has(candidate.tool_call_id)) break;
        group.push(candidate);
        pending.delete(candidate.tool_call_id);
        cursor += 1;
      }
      groups.push(group);
      index = Math.max(index, cursor - 1);
      continue;
    }
    if (message.role === "tool") continue;
    groups.push([message]);
  }
  return groups;
}

export function conversationCost(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageCost(message), 0);
}

export function shouldCompact(messages: readonly ChatMessage[], maxChars = DEFAULT_MAX_CHARS): boolean {
  return conversationCost(messages) > maxChars;
}

/**
 * Compact the conversation, or return null when it is too short to bother.
 * If the model call fails the caller should fall back to the deterministic
 * compactor; this function deliberately lets the error through.
 */
export async function compactConversation(options: CompactionOptions): Promise<CompactionOutcome | null> {
  const keepGroups = Math.max(1, options.keepGroups ?? DEFAULT_KEEP_GROUPS);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const anchorCount = Math.max(0, Math.min(options.anchorCount ?? (options.messages[0]?.role === "system" ? 1 : 0), options.messages.length));
  const messages = options.messages;
  if (messages.length < keepGroups * 2) return null;
  if (conversationCost(messages) <= maxChars) return null;

  const anchor = messages.slice(0, anchorCount);
  const groups = groupConversation(messages.slice(anchorCount));
  const keep = groups.slice(-keepGroups).flat();
  const compactable = groups.slice(0, -keepGroups).flat();
  if (compactable.length < 2) return null;

  const transcript = renderTranscript(compactable, options.perMessageChars ?? DEFAULT_PER_MESSAGE_CHARS);
  const summary = extractSummary(await options.complete(`${COMPACTION_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>`));
  if (!summary.trim()) return null;

  const boundary = buildBoundaryMessage({
    before: messages.length,
    after: anchor.length + keep.length + 1,
    summary,
    runId: options.runId,
  });
  const refreshMessage = options.refreshFiles === false ? null : await refreshRecentFilesMessage(options.cwd);
  const next: ChatMessage[] = [...anchor, boundary, ...(refreshMessage ? [refreshMessage] : []), ...keep];

  return {
    messages: next,
    compactedCount: compactable.length,
    summary,
    boundary,
    refreshMessage,
  };
}

export function renderTranscript(messages: readonly ChatMessage[], perMessageChars = DEFAULT_PER_MESSAGE_CHARS): string {
  const parts: string[] = [];
  let used = 0;
  for (const message of messages) {
    const label = message.role === "tool"
      ? `tool(${message.name || "result"})`
      : message.role;
    const text = renderContent(message.content);
    const trimmed = text.length > perMessageChars
      ? `${text.slice(0, perMessageChars)}\n…[${text.length - perMessageChars} chars omitted]`
      : text;
    const block = `<${label}>\n${trimmed}\n</${label}>`;
    if (used + block.length > TRANSCRIPT_LIMIT) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

export function extractSummary(text: string): string {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  return (match?.[1] ?? text).trim();
}

export interface BoundaryInput {
  before: number;
  after: number;
  summary: string;
  runId: string;
  at?: Date;
}

export function buildBoundaryMessage(input: BoundaryInput): ChatMessage {
  const at = (input.at ?? new Date()).toISOString();
  return {
    role: "user",
    content: [
      `<lynn-compaction-boundary at="${at}" run="${input.runId}" messages="${input.before}->${input.after}">`,
      "Earlier turns are no longer in the context. The summary below is authoritative for what happened; the original messages are gone.",
      "If you need exact file contents, read the file again — do not trust memory of code you can no longer see.",
      "",
      "<summary>",
      input.summary,
      "</summary>",
      "</lynn-compaction-boundary>",
    ].join("\n"),
  };
}

/**
 * Re-inject the handful of files most recently read, mirroring Claude Code's
 * post-compaction "refresh the files the model was just looking at" behaviour.
 */
export async function refreshRecentFilesMessage(cwd: string, limit = REFRESH_FILES): Promise<ChatMessage | null> {
  const paths = recentReadPaths(limit);
  if (!paths.length) return null;
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const sections: string[] = [];
  let used = 0;
  for (const file of paths) {
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const clipped = text.length > REFRESH_PER_FILE_CHARS
      ? `${text.slice(0, REFRESH_PER_FILE_CHARS)}\n…[truncated at ${REFRESH_PER_FILE_CHARS} chars]`
      : text;
    const block = `<file path="${relative}">\n${clipped}\n</file>`;
    if (used + block.length > REFRESH_TOTAL_CHARS) break;
    sections.push(block);
    used += block.length;
  }
  if (!sections.length) return null;
  return {
    role: "user",
    content: [
      "<lynn-refreshed-files>",
      "These files were read before compaction and are refreshed from disk so you can keep working. If one is not relevant anymore, ignore it.",
      ...sections,
      "</lynn-refreshed-files>",
    ].join("\n"),
  };
}

function messageCost(message: ChatMessage): number {
  const content = typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
  const calls = message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0;
  return content + calls;
}

function renderContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}
