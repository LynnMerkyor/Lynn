import { randomUUID } from "node:crypto";
import { normalizeToolAliasName } from "../engine-tool-runtime.js";
import { filterOutBrainManagedCustomTools } from "../brain-managed-tools.js";
import { isBrainProvider } from "../../shared/brain-provider.js";
import type {
  AgentSessionEvent,
  ChatMessage,
  ImageContent,
  MessageContent,
  Model,
  PromptOptions,
  TextContent,
  ThinkingLevel,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./types.js";

export type RuntimeTool = ToolDefinition & {
  execute?: (toolCallId: string, params: unknown, runtime?: unknown) => Promise<ToolResult> | ToolResult;
};

export type StreamToolCallAccumulator = {
  id: string;
  index: number;
  name: string;
  arguments: string;
};

export type OpenAiChunk = {
  object?: string;
  type?: string;
  meta?: Record<string, unknown>;
  tool_progress?: Record<string, unknown>;
  error?: unknown;
  code?: unknown;
  choices?: Array<{
    delta?: Record<string, unknown>;
    message?: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
  usage?: unknown;
};

export type ModelFallbackReason = "empty_response" | "tool_round_limit" | "model_error";

export type ModelCallOptions = {
  model?: Model;
  tools?: RuntimeTool[];
  streamText?: boolean;
  timeoutMs?: number;
};

export const STEP_EXECUTE_TOOL_NAME = "step_execute";
export const STEP_DELEGATION_TOOL_KEYS = new Set([
  "web-search",
  "web-fetch",
  "fetch-web-content",
  "sports-score",
  "weather",
  "stock-market",
  "live-news",
  "search",
  "fetch",
]);

export class ModelCallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "ModelCallTimeoutError";
  }
}

export function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function defaultModelCallTimeoutMs(): number {
  return positiveEnvInt("LYNN_MODEL_CALL_TIMEOUT_MS", 45_000);
}

export function fallbackModelCallTimeoutMs(): number {
  return positiveEnvInt("LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS", 30_000);
}

export function beijingDateParts(date = new Date()): { year: number; month: number; day: number; serial: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return { year, month, day, serial: year * 10_000 + month * 100 + day };
}

export function dateSerial(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Math.floor(year) * 10_000 + Math.floor(month) * 100 + Math.floor(day);
}

export function extractExplicitDateSerials(text: string): number[] {
  const current = beijingDateParts();
  const serials: number[] = [];
  const push = (year: number, month: number, day: number) => {
    const serial = dateSerial(year, month, day);
    if (serial != null) serials.push(serial);
  };
  for (const match of text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  for (const match of text.matchAll(/(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3] || "1"));
  }
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    push(current.year, Number(match[1]), Number(match[2]));
  }
  return [...new Set(serials)];
}

export function containsPastDateFutureStartContradiction(text: string): boolean {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return false;
  const today = beijingDateParts().serial;
  if (!extractExplicitDateSerials(compact).some((serial) => serial <= today)) return false;
  const futureStart =
    /(?:要到|将在|将于|预计|计划|还要等到|才会|才)[^。；;!?！？]{0,50}(?:开幕|开赛|开始|举行|进行|打响|正赛)/.test(compact) ||
    /(?:开幕|开赛|开始|举行|进行|打响|正赛)[^。；;!?！？]{0,50}(?:尚未|还没|还未|未|暂无)/.test(compact);
  const noResult =
    /(?:没有|暂无|尚未|还没有|还未|未查到|未获取到|未找到|未产生|无法获取)[^。；;!?！？]{0,60}(?:比分|赛果|结果|比赛|赛程|正赛|数据|信息)/.test(compact) ||
    /(?:比分|赛果|结果|比赛|赛程|正赛|数据|信息)[^。；;!?！？]{0,60}(?:没有|暂无|尚未|还没有|还未|未查到|未获取到|未找到|未产生|无法获取)/.test(compact);
  return futureStart && noResult;
}

export function isUnsafeFinalAnswerText(text: string): boolean {
  return containsPastDateFutureStartContradiction(text);
}

export function createTimedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const abortFromParent = () => {
    const reason = (parent as AbortSignal & { reason?: unknown } | undefined)?.reason;
    try {
      controller.abort(reason);
    } catch {
      controller.abort();
    }
  };

  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort(new ModelCallTimeoutError(timeoutMs));
    } catch {
      controller.abort();
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (typeof record.text === "string") return record.text;
      return "";
    }).join("");
  }
  return content == null ? "" : String(content);
}

export function maybeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

export function normalizeToolResult(result: unknown): ToolResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { content: [{ type: "text", text: String(result ?? "") }] };
  }
  const record = result as ToolResult;
  if (Array.isArray(record.content)) return record;
  if (typeof record.text === "string") return { ...record, content: [{ type: "text", text: record.text }] };
  return record;
}

export function toolResultToMessageContent(result: ToolResult): string {
  if (Array.isArray(result.content) && result.content.length) {
    return result.content.map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.data === "string") return `[${part.type || "data"}:${part.mimeType || "unknown"}]`;
      return maybeJson(part);
    }).filter(Boolean).join("\n");
  }
  if (result.details !== undefined) return maybeJson(result.details);
  return maybeJson(result);
}

export function eventTextDelta(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "text_delta", text, delta: text } as any,
  };
}

export function eventThinkingDelta(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "thinking_delta", text, delta: text } as any,
  };
}

export function eventError(error: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "error", error },
  };
}

export function normalizeTools(tools: ToolDefinition[] | undefined): RuntimeTool[] {
  return (tools || [])
    .filter((tool): tool is RuntimeTool => !!tool && typeof tool.name === "string" && !!tool.name)
    .map((tool) => ({ ...tool }));
}

export function normalizeRuntimeToolsForModel(tools: ToolDefinition[] | undefined, model: Model): RuntimeTool[] {
  const normalized = normalizeTools(tools);
  if (!isBrainProvider(model?.provider)) return normalized;
  return filterOutBrainManagedCustomTools(normalized);
}

export function toolToOpenAi(tool: RuntimeTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  };
}

export function isImagePart(part: unknown): part is ImageContent {
  const record = asRecord(part);
  return record.type === "image" || record.type === "image_url" || Boolean(record.source);
}

export function imagePartToOpenAi(part: ImageContent | Record<string, unknown>): Record<string, unknown> {
  const record = asRecord(part);
  if (record.type === "image_url") return record;
  const source = asRecord(record.source);
  const mediaType = String(record.mediaType || record.mimeType || source.media_type || source.mimeType || "image/png");
  const data = String(record.data || source.data || "");
  if (data.startsWith("data:")) return { type: "image_url", image_url: { url: data } };
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
}

export function contentToOpenAi(content: MessageContent | undefined): string | Array<Record<string, unknown>> {
  if (typeof content === "string" || content === undefined) return content || "";
  if (!Array.isArray(content)) return String(content);
  return content.map((part) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (isImagePart(part)) return imagePartToOpenAi(part as ImageContent);
    const record = asRecord(part);
    if (record.type === "text") return { type: "text", text: String(record.text || "") };
    if (typeof record.text === "string") return { type: "text", text: record.text };
    return { type: "text", text: maybeJson(record) };
  });
}

export function sanitizeMessagesForProvider(messages: ChatMessage[], model: Model): ChatMessage[] {
  const provider = String(model.provider || "").toLowerCase();
  const isDeepSeek = provider.includes("deepseek") || /^deepseek-/i.test(model.id || "");
  const next: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = contentToText(message.content).trim();
      const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      if (!text && !hasToolCalls) continue;
      if (isDeepSeek) {
        const { reasoning_content: _drop, ...rest } = message;
        next.push(rest);
        continue;
      }
    }
    next.push({ ...message });
  }
  return next;
}

export function toOpenAiMessages(messages: ChatMessage[], model: Model): Record<string, unknown>[] {
  return sanitizeMessagesForProvider(messages, model).map((message) => {
    const record: Record<string, unknown> = {
      role: message.role,
      content: contentToOpenAi(message.content),
    };
    if (message.name) record.name = message.name;
    if (message.tool_call_id) record.tool_call_id = message.tool_call_id;
    if (message.tool_calls?.length) record.tool_calls = message.tool_calls;
    return record;
  });
}

export function baseUrlFor(model: Model): string {
  const raw = String(model.baseUrl || model.baseURL || "").replace(/\/+$/, "");
  if (!raw) throw new Error(`Model ${model.provider}/${model.id} has no baseUrl`);
  return raw;
}

export function chatCompletionsUrl(model: Model): string {
  const base = baseUrlFor(model);
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

export function thinkingPayload(model: Model, level: ThinkingLevel | undefined): Record<string, unknown> {
  const raw = String(level || "auto").toLowerCase();
  if (!raw || raw === "none" || raw === "off" || raw === "false" || raw === "disabled") return {};
  const provider = String(model.provider || "").toLowerCase();
  const format = String((model.compat as any)?.thinkingFormat || "");
  if (format === "qwen" || model.quirks?.includes("enable_thinking")) return { enable_thinking: true };
  if (format === "zai" || provider.includes("glm") || provider.includes("zai")) {
    return { thinking: { type: raw === "auto" ? "auto" : "enabled" } };
  }
  if (format === "deepseek" || provider.includes("deepseek")) return { reasoning_effort: raw === "auto" ? "low" : raw };
  return { reasoning_effort: raw === "auto" ? "low" : raw };
}

export function buildRequestBody(
  model: Model,
  messages: ChatMessage[],
  tools: RuntimeTool[],
  thinkingLevel: ThinkingLevel | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    messages: toOpenAiMessages(messages, model),
    stream: true,
  };
  const maxTokens = Number(model.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.min(maxTokens, 64_000);
  if (tools.length) {
    body.tools = tools.map(toolToOpenAi);
    body.tool_choice = "auto";
  }
  Object.assign(body, thinkingPayload(model, thinkingLevel));
  return body;
}

export function parseSseBlocks(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let cursor = 0;
  while (true) {
    const idx = buffer.indexOf("\n\n", cursor);
    if (idx < 0) break;
    const block = buffer.slice(cursor, idx);
    cursor = idx + 2;
    const data = block
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) payloads.push(data);
  }
  return { payloads, rest: buffer.slice(cursor) };
}

export function parsePayload(payload: string): OpenAiChunk | null {
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as OpenAiChunk;
  } catch {
    return null;
  }
}

export function appendToolDelta(map: Map<number, StreamToolCallAccumulator>, raw: unknown, fallbackIndex: number): void {
  const record = asRecord(raw);
  const index = typeof record.index === "number" ? record.index : fallbackIndex;
  const current = map.get(index) || {
    id: typeof record.id === "string" && record.id ? record.id : `call_${index}_${randomUUID().slice(0, 8)}`,
    index,
    name: "",
    arguments: "",
  };
  if (typeof record.id === "string" && record.id) current.id = record.id;
  const fn = asRecord(record.function || record.functionCall);
  if (typeof fn.name === "string" && fn.name) current.name = fn.name;
  if (typeof fn.arguments === "string") current.arguments += fn.arguments;
  map.set(index, current);
}

export function finalizeToolCalls(map: Map<number, StreamToolCallAccumulator>): ToolCall[] {
  return [...map.values()]
    .sort((a, b) => a.index - b.index)
    .filter((entry) => entry.name.trim())
    .map((entry) => ({
      id: entry.id,
      type: "function",
      function: {
        name: entry.name.trim(),
        arguments: entry.arguments || "{}",
      },
    }));
}

export function isExecutableToolCall(toolCall: ToolCall | null | undefined): toolCall is ToolCall {
  return Boolean(toolCall?.id && toolCall.function?.name?.trim());
}

export function safeJsonParse(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    const recovered = parseConcatenatedJsonObjects(value);
    if (recovered) return recovered;
    return { _raw: value };
  }
}

export function parseConcatenatedJsonObjectParts(value: string): Record<string, unknown>[] | null {
  const text = String(value || "").trim();
  if (!text) return [];
  const parts: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let consumedUntil = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== "}") continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    const before = text.slice(consumedUntil, start).trim();
    if (before) return null;
    try {
      const parsed = JSON.parse(text.slice(start, i + 1));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      parts.push(parsed as Record<string, unknown>);
      consumedUntil = i + 1;
      start = -1;
    } catch {
      return null;
    }
  }

  if (text.slice(consumedUntil).trim()) return null;
  return parts;
}

export function parseConcatenatedJsonObjects(value: string): Record<string, unknown> | null {
  const parts = parseConcatenatedJsonObjectParts(value);
  if (!parts) return null;
  if (parts.length === 0) return {};
  if (parts.length <= 1) return null;
  return Object.assign({}, ...parts);
}

export function toolNameKey(name: string): string {
  return String(normalizeToolAliasName(name) || name || "")
    .replace(/_/g, "-")
    .trim()
    .toLowerCase();
}

export function resolveRuntimeToolName(nameOrKey: string, tools: RuntimeTool[]): string | null {
  const key = toolNameKey(nameOrKey);
  const match = tools.find((tool) => toolNameKey(tool.name) === key);
  return match?.name || null;
}

export function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function lastStringField(parts: Record<string, unknown>[], keys: string[]): string {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const value = stringField(parts[i], keys);
    if (value) return value;
  }
  return "";
}

export function firstPresentField(parts: Record<string, unknown>[], keys: string[]): unknown {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    for (const key of keys) {
      if (parts[i][key] !== undefined) return parts[i][key];
    }
  }
  return undefined;
}

export function normalizeToolCallForExecution(
  toolName: string,
  rawArguments: string,
  tools: RuntimeTool[],
): { name: string; args: unknown } {
  const parts = parseConcatenatedJsonObjectParts(rawArguments);
  const parsed = safeJsonParse(rawArguments);
  const records = parts && parts.length > 0
    ? parts
    : [asRecord(parsed)];
  const key = toolNameKey(toolName);
  const canonicalName = resolveRuntimeToolName(toolName, tools) || normalizeToolAliasName(toolName) || toolName;

  if (key === "web-fetch" || key === "fetch-web-content") {
    const url = lastStringField(records, ["url", "href", "link"]);
    if (url) {
      const latest = records.at(-1) || {};
      return {
        name: canonicalName,
        args: {
          ...latest,
          url,
        },
      };
    }

    const query = lastStringField(records, ["query", "q", "keyword"]);
    const searchToolName = resolveRuntimeToolName("web-search", tools);
    if (query && searchToolName) {
      const maxResults = firstPresentField(records, ["maxResults", "max_results", "limit", "topK", "numResults"]);
      const args: Record<string, unknown> = { query };
      if (maxResults !== undefined) args.maxResults = maxResults;
      return { name: searchToolName, args };
    }
  }

  if (key === "web-search") {
    const query = lastStringField(records, ["query", "q", "keyword"]);
    if (query) {
      const args = asRecord(parsed);
      args.query = query;
      return { name: canonicalName, args };
    }
  }

  return { name: canonicalName, args: parsed };
}

export function roleMessage(role: ChatMessage["role"], content: MessageContent): ChatMessage {
  return { role, content };
}
