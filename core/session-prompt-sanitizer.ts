import { createModuleLogger } from "../lib/debug-log.js";

const log = createModuleLogger("session");

type AnyRecord = Record<string, any>;
type SessionLike = AnyRecord;

const BRAIN_MANAGED_TOOL_NAMES = new Set([
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
]);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

function messageContentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (!part) return "";
      if (typeof part === "string") return part;
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isRecoverableProviderErrorMessage(message: AnyRecord | null | undefined) {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "error") return false;
  const errorMessage = String(message.errorMessage || "");
  if (/all providers failed/i.test(errorMessage)) return true;
  return !messageContentText(message.content).trim();
}

function isInternalRetryPromptMessage(message: AnyRecord | null | undefined) {
  if (!message || message.role !== "user") return false;
  const text = messageContentText(message.content).trim();
  return text.startsWith("[系统提示] 这是空回复后的补救回答")
    || text.startsWith("[System] This is a recovery answer after an empty model turn");
}

function isTransientRecoveredToolPlaceholder(message: AnyRecord | null | undefined) {
  if (!message || message.role !== "assistant") return false;
  const text = messageContentText(message.content).trim();
  return text === "正在取回工具结果，稍后会整理成回答。";
}

function contentBlockToolName(block: AnyRecord | null | undefined): string {
  if (!block || typeof block !== "object") return "";
  if (typeof block.name === "string") return block.name;
  if (typeof block.toolName === "string") return block.toolName;
  if (typeof block.function?.name === "string") return block.function.name;
  return "";
}

function isBrainManagedToolName(name: unknown): boolean {
  return BRAIN_MANAGED_TOOL_NAMES.has(String(name || "").trim());
}

function isBrainManagedToolNotFoundToolResult(message: AnyRecord | null | undefined): boolean {
  if (!message || message.role !== "toolResult") return false;
  const toolName = String(message.toolName || "").trim();
  if (!isBrainManagedToolName(toolName)) return false;
  const text = messageContentText(message.content).trim();
  return Boolean(message.isError) && new RegExp(`\\bTool\\s+${toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+not\\s+found\\b`, "i").test(text);
}

function isEmptyAbortedAssistantMessage(message: AnyRecord | null | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (!/aborted|cancelled/i.test(String(message.stopReason || message.errorMessage || ""))) return false;
  const visibleText = messageContentText(message.content).trim();
  if (visibleText) return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.every((block: AnyRecord) => {
    const type = String(block?.type || "");
    return type === "thinking" || type === "toolCall" || type === "tool_use";
  });
}

function hasToolCallLikeContent(message: AnyRecord | null | undefined): boolean {
  if (!message) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return true;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.some((block: AnyRecord) => {
    const type = String(block?.type || "");
    return type === "toolCall" || type === "tool_use" || type === "function_call";
  });
}

function isEmptyAssistantContextPoison(message: AnyRecord | null | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (messageContentText(message.content).trim()) return false;
  if (hasToolCallLikeContent(message)) return false;
  return true;
}

function rewriteAssistantBrainManagedToolCalls(message: AnyRecord): AnyRecord | null {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const filtered = message.content.filter((block: AnyRecord) => {
    const type = String(block?.type || "");
    if (type !== "toolCall" && type !== "tool_use") return true;
    return !isBrainManagedToolName(contentBlockToolName(block));
  });
  if (filtered.length === message.content.length) return null;
  return { ...message, content: filtered };
}

function extractOriginalPromptFromPrefetchText(text: string): string {
  const source = String(text || "").trim();
  if (!source) return "";
  const looksLikePrefetch = /^财经\/行情快照/u.test(source)
    || /【系统已完成(?:行情|天气|体育比分|实时新闻|实时工具)?工具预取】/u.test(source)
    || /【(?:行情|天气|体育比分|实时新闻|实时工具)工具资料】/u.test(source)
    || /财经\/行情快照（via /u.test(source);
  if (!looksLikePrefetch) return "";

  const explicit = source.match(/【用户原始问题】\s*([\s\S]+)$/u)?.[1]?.trim();
  if (explicit) return explicit;

  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || "";
  if (!last || /^(?:来源|https?:\/\/|说明|类型|查询|后续建议|参考来源|[-*]|\d+[.)、])/u.test(last)) return "";
  return last.length <= 500 ? last : "";
}

function rewritePrefetchUserMessage(message: AnyRecord): AnyRecord | null {
  if (!message || message.role !== "user") return null;
  const text = messageContentText(message.content).trim();
  const original = extractOriginalPromptFromPrefetchText(text);
  if (!original || original === text) return null;
  return {
    ...message,
    content: [{ type: "text", text: original }],
  };
}

export function sanitizeMessagesBeforePrompt(messages: unknown) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: Array.isArray(messages) ? messages : [], removed: 0, rewritten: 0 };
  }
  const cleaned = [];
  let removed = 0;
  let rewritten = 0;
  for (const message of messages) {
    if (
      isRecoverableProviderErrorMessage(message) ||
      isInternalRetryPromptMessage(message) ||
      isTransientRecoveredToolPlaceholder(message) ||
      isBrainManagedToolNotFoundToolResult(message) ||
      isEmptyAbortedAssistantMessage(message) ||
      isEmptyAssistantContextPoison(message)
    ) {
      removed += 1;
      continue;
    }
    const rewrittenMessage = rewritePrefetchUserMessage(message);
    if (rewrittenMessage) {
      rewritten += 1;
      cleaned.push(rewrittenMessage);
      continue;
    }
    const assistantWithoutBrainToolCalls = rewriteAssistantBrainManagedToolCalls(message);
    if (assistantWithoutBrainToolCalls) {
      rewritten += 1;
      if (isEmptyAssistantContextPoison(assistantWithoutBrainToolCalls)) {
        removed += 1;
        continue;
      }
      cleaned.push(assistantWithoutBrainToolCalls);
      continue;
    }
    cleaned.push(message);
  }
  return { messages: cleaned, removed, rewritten };
}

export function sanitizeActiveSessionContextForPrompt(session: SessionLike | null | undefined, sessionPath: string | null | undefined) {
  const manager = session?.sessionManager;
  const replaceMessages = session?.agent?.replaceMessages;
  if (!manager?.buildSessionContext || typeof replaceMessages !== "function") return 0;
  try {
    const context = manager.buildSessionContext();
    const currentMessages = Array.isArray(context?.messages) ? context.messages : [];
    const { messages, removed, rewritten } = sanitizeMessagesBeforePrompt(currentMessages);
    if ((removed > 0 || rewritten > 0) && messages.length > 0) {
      replaceMessages.call(session?.agent, messages);
      log.warn(`[prompt] scrubbed ${removed} transient and rewrote ${rewritten} prefetch context message(s) · session=${sessionPath || "unknown"}`);
    }
    return removed + rewritten;
  } catch (err) {
    log.warn(`[prompt] active context scrub failed · session=${sessionPath || "unknown"} · ${errMessage(err)}`);
    return 0;
  }
}

export function createReplyIntegrityTracker() {
  return {
    replyText: "",
    sawToolCall: false,
    handle(event: AnyRecord) {
      if (event?.type === "message_update") {
        const sub = event.assistantMessageEvent;
        if (sub?.type === "text_delta") {
          this.replyText += sub.delta || "";
        } else if (sub?.type === "toolcall_start" || sub?.type === "toolcall_end") {
          this.sawToolCall = true;
        }
        return;
      }

      if (event?.type === "tool_execution_start" || event?.type === "tool_execution_end") {
        this.sawToolCall = true;
      }
    },
  };
}

export function ensureValidReplyExecution(_tracker: ReturnType<typeof createReplyIntegrityTracker>) {
  return;
}

export async function runPromptWithIntegrity(
  session: SessionLike,
  text: string,
  promptOptions?: unknown,
  opts: { passOptionsArgument?: boolean } = {},
) {
  const tracker = createReplyIntegrityTracker();
  const unsub = session.subscribe((event: AnyRecord) => {
    tracker.handle(event);
  });
  try {
    if (opts.passOptionsArgument || promptOptions !== undefined) {
      await session.prompt(text, promptOptions);
    } else {
      await session.prompt(text);
    }
    ensureValidReplyExecution(tracker);
    return tracker.replyText;
  } finally {
    unsub?.();
  }
}
