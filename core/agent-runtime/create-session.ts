import { randomUUID } from "node:crypto";
import path from "node:path";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { sanitizeMessagesBeforePrompt } from "../session-prompt-sanitizer.js";
import { normalizeToolAliasName } from "../engine-tool-runtime.js";
import {
  filterOutBrainManagedCustomTools,
  isBrainManagedCustomToolName,
} from "../brain-managed-tools.js";
import { isBrainProvider } from "../../shared/brain-provider.js";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  Api,
  ChatAssistantToolCall,
  ChatMessage,
  ImageContent,
  LoadExtensionsResult,
  MessageContent,
  Model,
  PromptOptions,
  ResourceLoader,
  TextContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./types.js";

export interface LynnCreateAgentSessionOptions {
  cwd?: string;
  agentDir?: string;
  authStorage?: unknown;
  modelRegistry?: ModelRegistry;
  model?: Model | null;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Record<string, unknown>;
  tools?: ToolDefinition[];
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  requestHeaders?: Record<string, string>;
  requestMetadata?: Record<string, unknown>;
  [key: string]: unknown;
}

type RuntimeTool = ToolDefinition & {
  execute?: (toolCallId: string, params: unknown, runtime?: unknown) => Promise<ToolResult> | ToolResult;
};

type StreamToolCallAccumulator = {
  id: string;
  index: number;
  name: string;
  arguments: string;
};

type OpenAiChunk = {
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

type ModelFallbackReason = "empty_response" | "tool_round_limit" | "model_error";

type ModelCallOptions = {
  model?: Model;
  tools?: RuntimeTool[];
  streamText?: boolean;
  timeoutMs?: number;
};

const STEP_EXECUTE_TOOL_NAME = "step_execute";
const STEP_DELEGATION_TOOL_KEYS = new Set([
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

class ModelCallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "ModelCallTimeoutError";
  }
}

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function defaultModelCallTimeoutMs(): number {
  return positiveEnvInt("LYNN_MODEL_CALL_TIMEOUT_MS", 45_000);
}

function fallbackModelCallTimeoutMs(): number {
  return positiveEnvInt("LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS", 30_000);
}

function beijingDateParts(date = new Date()): { year: number; month: number; day: number; serial: number } {
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

function dateSerial(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Math.floor(year) * 10_000 + Math.floor(month) * 100 + Math.floor(day);
}

function extractExplicitDateSerials(text: string): number[] {
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

function containsPastDateFutureStartContradiction(text: string): boolean {
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

function isUnsafeFinalAnswerText(text: string): boolean {
  return containsPastDateFutureStartContradiction(text);
}

function createTimedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentToText(content: unknown): string {
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

function maybeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function normalizeToolResult(result: unknown): ToolResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { content: [{ type: "text", text: String(result ?? "") }] };
  }
  const record = result as ToolResult;
  if (Array.isArray(record.content)) return record;
  if (typeof record.text === "string") return { ...record, content: [{ type: "text", text: record.text }] };
  return record;
}

function toolResultToMessageContent(result: ToolResult): string {
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

function eventTextDelta(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "text_delta", text, delta: text } as any,
  };
}

function eventThinkingDelta(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "thinking_delta", text, delta: text } as any,
  };
}

function eventError(error: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "error", error },
  };
}

function normalizeTools(tools: ToolDefinition[] | undefined): RuntimeTool[] {
  return (tools || [])
    .filter((tool): tool is RuntimeTool => !!tool && typeof tool.name === "string" && !!tool.name)
    .map((tool) => ({ ...tool }));
}

function normalizeRuntimeToolsForModel(tools: ToolDefinition[] | undefined, model: Model): RuntimeTool[] {
  const normalized = normalizeTools(tools);
  if (!isBrainProvider(model?.provider)) return normalized;
  return filterOutBrainManagedCustomTools(normalized);
}

function toolToOpenAi(tool: RuntimeTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  };
}

function isImagePart(part: unknown): part is ImageContent {
  const record = asRecord(part);
  return record.type === "image" || record.type === "image_url" || Boolean(record.source);
}

function imagePartToOpenAi(part: ImageContent | Record<string, unknown>): Record<string, unknown> {
  const record = asRecord(part);
  if (record.type === "image_url") return record;
  const source = asRecord(record.source);
  const mediaType = String(record.mediaType || record.mimeType || source.media_type || source.mimeType || "image/png");
  const data = String(record.data || source.data || "");
  if (data.startsWith("data:")) return { type: "image_url", image_url: { url: data } };
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
}

function contentToOpenAi(content: MessageContent | undefined): string | Array<Record<string, unknown>> {
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

function sanitizeMessagesForProvider(messages: ChatMessage[], model: Model): ChatMessage[] {
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

function toOpenAiMessages(messages: ChatMessage[], model: Model): Record<string, unknown>[] {
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

function baseUrlFor(model: Model): string {
  const raw = String(model.baseUrl || model.baseURL || "").replace(/\/+$/, "");
  if (!raw) throw new Error(`Model ${model.provider}/${model.id} has no baseUrl`);
  return raw;
}

function chatCompletionsUrl(model: Model): string {
  const base = baseUrlFor(model);
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function thinkingPayload(model: Model, level: ThinkingLevel | undefined): Record<string, unknown> {
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

function buildRequestBody(
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

function parseSseBlocks(buffer: string): { payloads: string[]; rest: string } {
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

function parsePayload(payload: string): OpenAiChunk | null {
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as OpenAiChunk;
  } catch {
    return null;
  }
}

function appendToolDelta(map: Map<number, StreamToolCallAccumulator>, raw: unknown, fallbackIndex: number): void {
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

function finalizeToolCalls(map: Map<number, StreamToolCallAccumulator>): ToolCall[] {
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

function isExecutableToolCall(toolCall: ToolCall | null | undefined): toolCall is ToolCall {
  return Boolean(toolCall?.id && toolCall.function?.name?.trim());
}

function safeJsonParse(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    const recovered = parseConcatenatedJsonObjects(value);
    if (recovered) return recovered;
    return { _raw: value };
  }
}

function parseConcatenatedJsonObjectParts(value: string): Record<string, unknown>[] | null {
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

function parseConcatenatedJsonObjects(value: string): Record<string, unknown> | null {
  const parts = parseConcatenatedJsonObjectParts(value);
  if (!parts) return null;
  if (parts.length === 0) return {};
  if (parts.length <= 1) return null;
  return Object.assign({}, ...parts);
}

function toolNameKey(name: string): string {
  return String(normalizeToolAliasName(name) || name || "")
    .replace(/_/g, "-")
    .trim()
    .toLowerCase();
}

function resolveRuntimeToolName(nameOrKey: string, tools: RuntimeTool[]): string | null {
  const key = toolNameKey(nameOrKey);
  const match = tools.find((tool) => toolNameKey(tool.name) === key);
  return match?.name || null;
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function lastStringField(parts: Record<string, unknown>[], keys: string[]): string {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const value = stringField(parts[i], keys);
    if (value) return value;
  }
  return "";
}

function firstPresentField(parts: Record<string, unknown>[], keys: string[]): unknown {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    for (const key of keys) {
      if (parts[i][key] !== undefined) return parts[i][key];
    }
  }
  return undefined;
}

function normalizeToolCallForExecution(
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

function roleMessage(role: ChatMessage["role"], content: MessageContent): ChatMessage {
  return { role, content };
}

function modelSearchText(model: Model): string {
  return [model.provider, model.id, model.name, model.api]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function modelIdentity(model: Model): string {
  return `${model.provider || ""}/${model.id || model.name || ""}`.toLowerCase();
}

function fallbackRank(model: Model): number {
  const provider = String(model.provider || "").trim().toLowerCase();
  const id = String(model.id || "").trim().toLowerCase();
  const base = String(model.baseUrl || model.baseURL || "").trim().toLowerCase();
  const text = modelSearchText(model);
  if (
    id === "step-3.7-flash"
    || id === "step-3.7-flash-q3km-mtp-local"
    || (text.includes("step-3.7-flash") && base.includes("/step37/"))
  ) {
    return 0;
  }
  if (
    (id.includes("mimo") || text.includes("mimo") || base.includes("xiaomimimo"))
    && !/(?:asr|tts|voice)/i.test([id, text].join(" "))
  ) {
    return 10;
  }
  if (
    id === "glm-5-turbo"
    && (
      provider.includes("zhipu")
      || text.includes("glm-5-turbo")
      || base.includes("zhipu")
      || base.includes("bigmodel")
    )
  ) {
    return 20;
  }
  return Number.POSITIVE_INFINITY;
}

function isStepExecutorModel(model: Model): boolean {
  return fallbackRank(model) === 0;
}

function fallbackInstruction(reason: ModelFallbackReason): string {
  if (reason === "tool_round_limit") {
    return "上一模型已经完成多轮工具调用但没有形成最终回复。请只基于上面的用户问题和工具结果直接给出简明最终答案，不要再调用工具。";
  }
  if (reason === "model_error") {
    return "上一模型请求失败。请直接回答用户最后的问题；如果已有工具结果，请优先基于工具结果作答，不要再调用工具。";
  }
  return "上一模型没有返回可见正文。请直接回答用户最后的问题；如果已有工具结果，请优先基于工具结果作答，不要再调用工具。";
}

function fallbackInstructionWithToolUse(reason: ModelFallbackReason): string {
  if (reason === "tool_round_limit") {
    return "上一模型多轮尝试后没有形成最终回复。请接管这个任务：必要时调用一次最相关工具获取证据，然后直接给出简明最终答案。";
  }
  if (reason === "model_error") {
    return "上一模型请求失败。请接管用户最后的问题：必要时调用一次最相关工具获取证据，然后直接给出简明最终答案。";
  }
  return "上一模型没有返回可见正文。请接管用户最后的问题：必要时调用一次最相关工具获取证据，然后直接给出简明最终答案。";
}

function sanitizeToolEvidenceText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^error\.[A-Za-z0-9_.-]+$/i.test(line)) return false;
      if (/\bTool not found\s*:/i.test(line)) return false;
      if (/工具(?:当前)?不可用[:：]/.test(line)) return false;
      if (/providerQuery is not defined/i.test(line)) return false;
      if (/\b(?:fetch failed|LLM request failed|aborted)\b/i.test(line)) return false;
      if (/^(?:抓取出错|访问页面失败|模型请求超时|模型请求失败)[:：]/.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function hasAnyToolEvidence(messages: ChatMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== "tool") return false;
    return sanitizeToolEvidenceText(contentToText(message.content)).length > 0;
  });
}

function isStepDelegationEvidenceToolName(name: string | undefined): boolean {
  if (!name) return false;
  return STEP_DELEGATION_TOOL_KEYS.has(toolNameKey(name));
}

function hasUsableToolEvidence(messages: ChatMessage[]): boolean {
  const evidence = collectToolEvidence(messages, 2600);
  return evidence ? evidenceToReadableLines(evidence).length > 0 : false;
}

function toolMessageHasUsableEvidence(message: ChatMessage): boolean {
  if (message.role !== "tool") return false;
  const text = sanitizeToolEvidenceText(contentToText(message.content));
  if (!text) return false;
  const name = message.name ? ` (${message.name})` : "";
  return evidenceToReadableLines(`#1${name}\n${text}`).length > 0;
}

function countUsableStepDelegationEvidenceToolMessages(messages: ChatMessage[]): number {
  return messages.filter((message) => {
    if (message.role !== "tool") return false;
    if (!isStepDelegationEvidenceToolName(message.name)) return false;
    return toolMessageHasUsableEvidence(message);
  }).length;
}

function countAnyStepDelegationEvidenceToolMessages(messages: ChatMessage[]): number {
  return messages.filter((message) => {
    if (message.role !== "tool") return false;
    if (!isStepDelegationEvidenceToolName(message.name)) return false;
    return sanitizeToolEvidenceText(contentToText(message.content)).length > 0;
  }).length;
}

function latestUserQuestion(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = contentToText(message.content).trim();
    if (text) return text;
  }
  return "";
}

function collectToolEvidence(messages: ChatMessage[], maxChars = 5000): string {
  const entries = messages
    .filter((message) => message.role === "tool")
    .map((message, index) => {
      const text = sanitizeToolEvidenceText(contentToText(message.content).replace(/\s+\n/g, "\n"));
      if (!text) return "";
      const name = message.name ? ` (${message.name})` : "";
      return `#${index + 1}${name}\n${text}`;
    })
    .filter(Boolean)
    .slice(-6);
  const joined = entries.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}\n...[已截断过长工具证据]`;
}

function evidenceToReadableLines(raw: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const normalized = raw
    .replace(/\r/g, "\n")
    .replace(/error\.[A-Za-z0-9_.-]+/g, "")
    .replace(/📋\s*综合答案[:：]?/g, "")
    .replace(/\n{3,}/g, "\n\n");
  const chunks = normalized
    .replace(/(?<=[。！？!?])\s+(?=[^\s#])/g, "\n")
    .split(/\n+|(?=[^。\n]{4,90}\(\d{4}-\d{2}-\d{2}\)[:：])/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    let line = chunk
      .replace(/^#\d+(?:\s+\([^)]+\))?\s*/g, "")
      .replace(/^[-•]\s*/g, "")
      .replace(/^搜索提示[:：].*$/g, "")
      .replace(/^sources?:.*$/i, "")
      .replace(/^details?:.*$/i, "")
      .replace(/^摘要[:：]\s*/g, "")
      .replace(/\.\.\.\[已截断过长工具证据\]$/g, "")
      .replace(/\bhttps?:\/\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line || line.length < 8) continue;
    if (/^(搜索提示|工具证据|用户问题|已截断|#\d+)/.test(line)) continue;
    if (/^error\./i.test(line)) continue;
    if (/\bTool not found\s*:/i.test(line) || /工具(?:当前)?不可用[:：]/.test(line)) continue;
    if (/^\(?没有可用工具证据\)?$/.test(line)) continue;
    if (isLowValueToolEvidenceLine(line)) continue;
    if (!hasEnoughFactDensity(line)) continue;
    if (line.length > 220) line = `${line.slice(0, 218)}…`;
    const key = line.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
    if (lines.length >= 6) break;
  }
  return lines;
}

function isLowValueToolEvidenceLine(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  if (!compact) return true;
  if (containsPastDateFutureStartContradiction(line)) return true;
  if (/javascript\s*:|void\(0\)|szqbl\.chscht\.run/i.test(line)) return true;
  if (/您的?浏览器版本过低|请升级到|急速模式|无障碍阅读|手机版|热门搜|点击播放|视频加载|Skip to content|Previous\s+Next/i.test(line)) return true;
  if (/^\W*(?:来源|链接|URL|网站支持|数据开放|English|繁體)(?:\s|[:：]|$)/i.test(line)) return true;
  if (/^[\s\W]*(?:html|text|json|xml)\s*[→-]\s*(?:html|text|json|xml)/i.test(line)) return true;
  const urlLikeCount = (line.match(/\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|cn|org|net|gov)\b)/gi) || []).length;
  if (urlLikeCount >= 2 && compact.length < 180) return true;
  const alphaNum = compact.replace(/[^\p{L}\p{N}]/gu, "");
  return alphaNum.length < Math.max(6, compact.length * 0.35);
}

function hasEnoughFactDensity(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, "");
  const hasEntityText = /[\p{L}\p{Script=Han}]{2,}/u.test(text);
  const hasNumber = /\d|[一二三四五六七八九十百千万]/.test(text);
  if (!hasEntityText || !hasNumber) return false;

  const hasScoreLike =
    /[\p{L}\p{Script=Han}][^。\n]{0,80}(?:\d+|[一二三四五六七八九十]+)\s*(?:[-:：比]\s*|比)(?:\d+|[一二三四五六七八九十]+)[^。\n]{0,80}[\p{L}\p{Script=Han}]/u.test(text);
  const hasDateLike =
    /\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?|\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}|UTC|GMT|北京时间|发布(?:时间)?[:：]?\s*\d{4}/i.test(text);
  const hasMeasuredValue =
    /\d+(?:\.\d+)?\s*(?:%|℃|CNY|USD|RMB|CNH|HKD|EUR|JPY|元|美元|人民币|港元|欧元|日元|克|盎司|分|场|次|点|日|月|年|mm|毫米|km\/h|公里\/小时|AQI|级|倍|万|亿)/i.test(text);
  const hasRangeOrEquation =
    /\d+(?:\.\d+)?\s*(?:[-–—~至到]\s*)\d+(?:\.\d+)?/.test(text) ||
    /\b[A-Z]{2,6}\s*[=/]\s*\d+(?:\.\d+)?\b/i.test(text);
  const hasAttributionDate = /\(\d{4}-\d{2}-\d{2}\)|发布(?:时间)?[:：]?\s*\d{4}-\d{2}-\d{2}/.test(text);
  const hasStructuredSeparator = /[：:，,；;。]/.test(text);

  if (hasScoreLike) return true;
  if ((hasMeasuredValue || hasRangeOrEquation) && (hasDateLike || hasAttributionDate || compact.length <= 180)) return true;
  if (hasDateLike && hasStructuredSeparator && compact.length <= 180) return true;
  return false;
}

function buildInsufficientEvidenceAnswer(question: string): string {
  return [
    question ? `针对“${question}”，工具已经返回内容，但没有提取到足够可靠的事实来直接回答。` : "工具已经返回内容，但没有提取到足够可靠的事实来直接回答。",
    "",
    "我不会把网页导航、搜索摘要或抓取噪声当成结论。建议换一个更明确的数据源/时间范围再查，或继续让我重新检索并交叉验证。",
  ].join("\n");
}

function hasAssistantProcessChatter(text: string): boolean {
  return /(?:我(?:先|再|来|已经)?(?:帮你|为你)?(?:查|搜索|检索|获取|拿到|确认|核对|整理|看看)|让我(?:先|再|来)?(?:查|搜索|检索|获取|拿到|确认|核对|整理|看看)|好[，,][^。\n]{0,100}(?:查|搜|获取|拿到|确认|整理)|看起来[^。\n]{0,100}(?:了|！|。)|(?:尚未|还没有|没有)[^。\n]{0,120}(?:我(?:再|来|帮你|为你)|让我))/u.test(text);
}

function answerBoundaryOffset(matchText: string): number {
  const firstVisible = matchText.search(/[^\n\s]/);
  return firstVisible < 0 ? 0 : firstVisible;
}

function collectAnswerBoundaryIndexes(text: string): number[] {
  const indexes: number[] = [];
  const patterns = [
    /(?:^|\n)\s*#{1,6}\s+\S/gu,
    /(?:^|\n)\s*(?:[-*]\s*)?(?:以下是|结果如下|整理如下|汇总如下|最终答案|答案如下|直接结论|结论)[：:]?/gu,
    /\n\s*\|[^\n|]+(?:\|[^\n|]+)+\|\s*\n\s*\|?[\s:：\-|]+\|/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      indexes.push(match.index + answerBoundaryOffset(match[0]));
    }
  }
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function looksLikeSubstantiveAnswer(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 30) return false;
  const hasWords = /[\p{L}\p{Script=Han}]{2,}/u.test(text);
  const hasStructure = /\n|[：:。；;，,]|\|[^|\n]+\||(?:^|\n)\s*[-*]\s+/u.test(text);
  return hasWords && hasStructure;
}

function stripAssistantProcessChatter(text: string): string {
  if (!text.trim() || /```/.test(text)) return text;
  if (!hasAssistantProcessChatter(text)) return text;
  for (const boundary of collectAnswerBoundaryIndexes(text)) {
    if (boundary <= 0) continue;
    const prefix = text.slice(0, boundary);
    const suffix = text.slice(boundary).trimStart();
    if (prefix.trim().length < 16) continue;
    if (!hasAssistantProcessChatter(prefix)) continue;
    if (!looksLikeSubstantiveAnswer(suffix)) continue;
    return suffix;
  }
  return text;
}

function normalizeFinalAnswerText(content: string): string {
  let text = String(content || "").replace(/\r/g, "\n");
  if (!text.trim()) return text;
  const hasCodeFence = /```/.test(text);
  text = stripAssistantProcessChatter(text);
  const blocks = text.split(/\n{2,}/);
  const dedupedBlocks: string[] = [];
  let previousBlockKey = "";
  for (const block of blocks) {
    const key = block.replace(/\s+/g, "");
    if (key && key === previousBlockKey) continue;
    dedupedBlocks.push(block);
    previousBlockKey = key;
  }
  text = dedupedBlocks.join("\n\n");
  if (hasCodeFence || /\n\|.+\|\n/.test(text)) return text;

  const parts = text.split(/(?<=[。！？!?])\s*/u).filter((part) => part.length > 0);
  if (parts.length <= 1) return text;
  const recent: string[] = [];
  const out: string[] = [];
  for (const part of parts) {
    const key = part.replace(/\s+/g, "");
    if (key.length >= 14 && recent.includes(key)) continue;
    out.push(part);
    if (key.length >= 14) {
      recent.push(key);
      if (recent.length > 4) recent.shift();
    }
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").trimEnd();
}

function buildFallbackSynthesisMessages(messages: ChatMessage[], reason: ModelFallbackReason): ChatMessage[] {
  const question = latestUserQuestion(messages);
  const rawEvidence = collectToolEvidence(messages);
  const evidenceLines = evidenceToReadableLines(rawEvidence);
  const evidence = evidenceLines.map((line) => `- ${line}`).join("\n");
  const reasonText = reason === "tool_round_limit"
    ? "上一个模型已经多轮调用工具但没有产出最终答案。"
    : reason === "model_error"
      ? "上一个模型请求失败。"
      : "上一个模型没有返回可见正文。";
  return [
    roleMessage("system", [
      "你是接管总结模型。只根据用户问题和工具证据给出最终答案。",
      "不要再调用工具，不要复述内部错误，不要声称没有证据，除非工具证据确实为空。",
      "如果证据不足，明确列出已知信息和不确定点。",
    ].join("\n")),
    roleMessage("user", [
      reasonText,
      "",
      `用户问题：${question || "（未找到用户问题）"}`,
      "",
      "工具证据：",
      evidence || "（没有可用工具证据）",
      "",
      "请直接给出面向用户的简明最终答案。",
    ].join("\n")),
  ];
}

function buildStepExecutorPolicyPrompt(): string {
  return [
    "你可以使用工具 step_execute，把明确子任务交给 Step 3.7 Flash 高速执行器。",
    "当任务已经足够明确、需要快速执行/整理/总结时，优先调用 step_execute，而不是自己继续重复搜索、抓取或长时间推理。",
    "推荐调用场景：搜索/行情/赛程/天气等工具结果已有证据后需要总结；表格/列表/代码/文档整理；长任务中的明确子步骤；你可能空答、超时或过度思考时。",
    "不要在闲聊、澄清问题、复查结论，或会修改/删除文件、执行命令、付款等有副作用的任务里自动调用 step_execute。",
    "调用时只传一个清晰可执行的 task，并把必要证据压缩进 context。",
  ].join("\n");
}

function buildEvidenceSafetyAnswer(messages: ChatMessage[]): string {
  const question = latestUserQuestion(messages);
  const evidence = collectToolEvidence(messages, 2600);
  if (!evidence) return "";
  const lines = evidenceToReadableLines(evidence);
  if (!lines.length) return buildInsufficientEvidenceAnswer(question);
  return [
    question ? `针对“${question}”，我能从工具证据中确认：` : "我能从工具证据中确认：",
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    "如果需要更精确的实时结论，建议继续用官方或专业数据源交叉验证。",
  ].filter(Boolean).join("\n");
}

function buildPromptUserContent(prompt: string, options?: PromptOptions): MessageContent {
  const images = Array.isArray(options?.images) ? options.images as ImageContent[] : [];
  if (!images.length) return prompt;
  const parts: Array<TextContent | ImageContent> = [{ type: "text", text: prompt }];
  for (const image of images) parts.push(image);
  return parts;
}

async function maybeString(value: unknown): Promise<string> {
  const resolved = await value;
  return typeof resolved === "string" ? resolved : "";
}

export class LynnAgentSession {
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly resourceLoader: ResourceLoader;
  readonly modelRegistry?: ModelRegistry;
  readonly scopedModels?: Record<string, unknown>;
  readonly requestHeaders: Record<string, string>;
  readonly requestMetadata?: Record<string, unknown>;
  readonly messages: ChatMessage[] = [];
  readonly agent: { state: { messages: ChatMessage[] }; replaceMessages: (messages: ChatMessage[]) => void };
  retryAttempt = 0;
  isStreaming = false;
  model: Model;
  thinkingLevel: ThinkingLevel;
  _customTools: RuntimeTool[];
  _baseToolsOverride: RuntimeTool[] | Record<string, RuntimeTool> | null = null;

  private readonly fallbackBaseTools: RuntimeTool[];
  private readonly fallbackCustomTools: RuntimeTool[];
  private tools: RuntimeTool[];
  private listeners = new Set<AgentSessionEventListener>();
  private abortController: AbortController | null = null;
  private pendingPrompts: Array<{ prompt: string; options?: PromptOptions }> = [];
  private disposed = false;
  private stepExecuteDepth = 0;

  constructor(options: LynnCreateAgentSessionOptions = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.sessionManager = options.sessionManager || SessionManager.create(this.cwd);
    this.settingsManager = options.settingsManager || SettingsManager.inMemory();
    this.resourceLoader = options.resourceLoader || new DefaultResourceLoader({ cwd: this.cwd, agentDir: options.agentDir });
    this.modelRegistry = options.modelRegistry;
    const fallbackModel = this.modelRegistry?.getAll?.()[0] || {
      provider: "brain",
      id: "default",
      api: "openai-completions" as Api,
      baseUrl: "",
      apiKey: "local",
    };
    this.model = (options.model || fallbackModel) as Model;
    this.thinkingLevel = options.thinkingLevel || "auto";
    this.scopedModels = options.scopedModels as Record<string, unknown> | undefined;
    this.requestHeaders = options.requestHeaders || {};
    this.requestMetadata = options.requestMetadata;
    this.fallbackBaseTools = normalizeTools(options.tools);
    this.fallbackCustomTools = normalizeTools(options.customTools);
    this.tools = isBrainProvider(this.model?.provider)
      ? filterOutBrainManagedCustomTools(this.fallbackBaseTools)
      : [...this.fallbackBaseTools];
    this._customTools = isBrainProvider(this.model?.provider)
      ? filterOutBrainManagedCustomTools(this.fallbackCustomTools)
      : [...this.fallbackCustomTools];
    this.agent = {
      state: { messages: this.messages },
      replaceMessages: (messages: ChatMessage[]) => {
        this.messages.splice(0, this.messages.length, ...messages);
        this.agent.state.messages = this.messages;
      },
    };
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
    this.listeners.clear();
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.isStreaming = false;
  }

  clearQueue(): void {
    this.pendingPrompts = [];
  }

  async prompt(prompt: string, options?: PromptOptions): Promise<void> {
    if (this.isStreaming) {
      const behavior = String(options?.streamingBehavior || "");
      if (behavior === "steer" || behavior === "followUp") {
        this.pendingPrompts.push({
          prompt,
          options: { ...options, streamingBehavior: undefined },
        });
        return;
      }
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    const userMessage = roleMessage("user", buildPromptUserContent(prompt, options));
    this.sessionManager.appendMessage(userMessage);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
    await this.runTurn();
  }

  async steer(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, { ...options, streamingBehavior: "steer" });
  }

  async followUp(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, { ...options, streamingBehavior: "followUp" });
  }

  async sendUserMessage(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, options);
  }

  async sendCustomMessage(message: ChatMessage): Promise<void> {
    this.sessionManager.appendMessage(message);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
  }

  async compact(): Promise<void> {
    this.emit({ type: "auto_compaction_end" });
  }

  async newSession(): Promise<void> {
    this.agent.replaceMessages([]);
  }

  setModel(model: Model): void {
    this.model = model;
    const isBrain = isBrainProvider(model?.provider);
    this.tools = isBrain ? filterOutBrainManagedCustomTools(this.fallbackBaseTools) : [...this.fallbackBaseTools];
    this._customTools = isBrain ? filterOutBrainManagedCustomTools(this.fallbackCustomTools) : [...this.fallbackCustomTools];
    if (isBrain && Array.isArray(this._baseToolsOverride)) {
      this._baseToolsOverride = filterOutBrainManagedCustomTools(this._baseToolsOverride);
    } else if (isBrain && this._baseToolsOverride && typeof this._baseToolsOverride === "object") {
      this._baseToolsOverride = Object.fromEntries(
        Object.entries(this._baseToolsOverride)
          .filter(([, tool]) => !isBrainManagedCustomToolName(tool?.name)),
      );
    }
    this.sessionManager.appendModelChange(model.provider, model.id);
  }

  cycleModel(): Model {
    const models = this.modelRegistry?.getAll?.() || [];
    if (!models.length) return this.model;
    const index = Math.max(0, models.findIndex((candidate) => candidate.provider === this.model.provider && candidate.id === this.model.id));
    this.setModel(models[(index + 1) % models.length]);
    return this.model;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
    this.sessionManager.appendThinkingLevelChange(String(level));
  }

  cycleThinkingLevel(): ThinkingLevel {
    const levels = this.getAvailableThinkingLevels();
    const index = Math.max(0, levels.indexOf(this.thinkingLevel));
    const next = levels[(index + 1) % levels.length];
    this.setThinkingLevel(next);
    return next;
  }

  getAvailableThinkingLevels(): ThinkingLevel[] {
    return ["none", "low", "medium", "high", "auto"];
  }

  supportsThinking(): boolean {
    return this.model.reasoning === true;
  }

  supportsXhighThinking(): boolean {
    return false;
  }

  setSteeringMode(): void {}
  setFollowUpMode(): void {}

  getAllTools(): RuntimeTool[] {
    const override = this._baseToolsOverride;
    const base = Array.isArray(override)
      ? override
      : override && typeof override === "object"
        ? Object.values(override)
        : this.tools;
    const tools = [...base, ...this._customTools];
    const stepExecute = this.createStepExecuteTool();
    if (stepExecute && !tools.some((tool) => toolNameKey(tool.name) === toolNameKey(STEP_EXECUTE_TOOL_NAME))) {
      tools.push(stepExecute);
    }
    return tools;
  }

  private getFallbackTools(): RuntimeTool[] {
    return [...this.fallbackBaseTools, ...this.fallbackCustomTools];
  }

  private findStepExecutorModel(): Model | null {
    if (isStepExecutorModel(this.model)) return null;
    const models = this.modelRegistry?.getAll?.() || [];
    return models.find((candidate) => {
      if (!candidate || isBrainProvider(candidate.provider)) return false;
      if (!isStepExecutorModel(candidate)) return false;
      if (modelIdentity(candidate) === modelIdentity(this.model)) return false;
      return Boolean(candidate.baseUrl || candidate.baseURL);
    }) || null;
  }

  private createStepExecuteTool(): RuntimeTool | null {
    const stepModel = this.findStepExecutorModel();
    if (!stepModel) return null;
    return {
      name: STEP_EXECUTE_TOOL_NAME,
      description: [
        "Step 3.7 Flash 是高速执行/总结器；把一个明确子任务交给它完成。",
        "当已有搜索/行情/赛程/天气等工具证据、需要整理表格/列表/代码/文档，或工具调用已超过 1 次仍需形成答案时优先调用。",
        "只传一个清晰可执行的 task 和必要 context；闲聊、澄清、复查、文件修改/删除、命令执行、付款等有副作用任务不要调用。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "要交给 Step 3.7 Flash 执行的明确子任务。",
          },
          context: {
            type: "string",
            description: "必要上下文或已知事实，保持精简。",
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
      execute: async (_toolCallId, params) => this.executeStepTask(stepModel, params),
    };
  }

  private shouldAutoDelegateToStep(messages: ChatMessage[], round: number): boolean {
    if (isStepExecutorModel(this.model)) return false;
    if (!this.findStepExecutorModel()) return false;
    const anyEvidenceToolCount = countAnyStepDelegationEvidenceToolMessages(messages);
    const evidenceToolCount = countUsableStepDelegationEvidenceToolMessages(messages);
    if (anyEvidenceToolCount > 0 && evidenceToolCount === 0) return true;
    if (evidenceToolCount >= 2) return true;
    return round >= 2 && evidenceToolCount >= 1;
  }

  private async executeStepTask(stepModel: Model, params: unknown): Promise<ToolResult> {
    if (this.stepExecuteDepth > 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "step_execute 已在执行中，避免递归调用。" }],
      };
    }
    const record = asRecord(params);
    const task = stringField(record, ["task", "prompt", "instruction", "query"]) || latestUserQuestion(this.messages);
    const context = stringField(record, ["context", "evidence", "background", "notes"]);
    if (!task) {
      return {
        isError: true,
        content: [{ type: "text", text: "step_execute 缺少可执行的 task。" }],
      };
    }
    const messages: ChatMessage[] = [
      roleMessage("system", [
        "你是 Step 3.7 Flash 执行器。",
        "你的职责是完成调用方交给你的一个明确子任务，并返回可直接使用的结果。",
        "不要调用工具，不要解释内部路由；如果信息不足，列出已知内容和缺口。",
      ].join("\n")),
      roleMessage("user", [
        `任务：${task}`,
        context ? `\n上下文：\n${context}` : "",
        "\n请输出简明、可执行、可直接交回主模型使用的结果。",
      ].filter(Boolean).join("\n")),
    ];
    this.stepExecuteDepth += 1;
    try {
      const result = await this.callModel(messages, {
        model: stepModel,
        tools: [],
        streamText: false,
        timeoutMs: fallbackModelCallTimeoutMs(),
      });
      const text = contentToText(result.assistant.content).trim();
      if (!text) {
        return {
          isError: true,
          content: [{ type: "text", text: "Step 3.7 Flash 执行器没有返回可见内容。" }],
        };
      }
      return {
        content: [{ type: "text", text: `Step 3.7 Flash 执行结果：\n${text}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Step 3.7 Flash 执行器失败：${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    } finally {
      this.stepExecuteDepth -= 1;
    }
  }

  getActiveToolNames(): string[] {
    return this.getAllTools().map((tool) => tool.name);
  }

  private resolveToolByName(name: string, tools = this.getAllTools()): RuntimeTool | undefined {
    const exact = tools.find((candidate) => candidate.name === name);
    if (exact) return exact;
    const normalized = normalizeToolAliasName(name);
    if (!normalized) return undefined;
    return tools.find((candidate) => normalizeToolAliasName(candidate.name) === normalized);
  }

  setActiveToolsByName(names: string[]): void {
    const allow = new Set(names);
    this._baseToolsOverride = Object.fromEntries(this.tools.filter((tool) => allow.has(tool.name)).map((tool) => [tool.name, tool]));
  }

  getSessionStats(): Record<string, unknown> {
    return { messages: this.messages.length, model: `${this.model.provider}/${this.model.id}` };
  }

  getContextUsage(): Record<string, unknown> {
    return { usedTokens: 0, maxTokens: this.model.contextWindow || 0 };
  }

  _buildRuntime(opts?: { activeToolNames?: string[] }): Record<string, unknown> {
    if (Array.isArray(opts?.activeToolNames) && this._baseToolsOverride == null) this.setActiveToolsByName(opts.activeToolNames);
    return { cwd: this.cwd, session: this, sessionManager: this.sessionManager };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener failures should not break the turn.
      }
    }
  }

  private finishAssistantAnswer(
    content: string,
    reasoning: string | undefined,
    opts: { streamedText?: boolean; contentDeltas?: string[] } = {},
  ): void {
    const finalContent = normalizeFinalAnswerText(content);
    if (!opts.streamedText) {
      const deltas = opts.contentDeltas?.length ? opts.contentDeltas : [finalContent];
      for (const delta of deltas) {
        if (delta) this.emit(eventTextDelta(delta));
      }
    }
    const finalMessage: ChatMessage = {
      role: "assistant",
      content: finalContent,
      reasoning_content: reasoning || undefined,
    };
    this.sessionManager.appendMessage(finalMessage);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
    this.emit({ type: "message_end", role: "assistant", message: finalMessage });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  private fallbackModels(currentModel: Model): Model[] {
    const models = this.modelRegistry?.getAll?.() || [];
    const blocked = new Set([modelIdentity(currentModel), modelIdentity(this.model)]);
    const seen = new Set<string>();
    return models
      .map((model) => ({ model, rank: fallbackRank(model), identity: modelIdentity(model) }))
      .filter(({ model, rank, identity }) => {
        if (!Number.isFinite(rank) || blocked.has(identity) || seen.has(identity)) return false;
        if (!model.baseUrl && !model.baseURL) return false;
        seen.add(identity);
        return true;
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ model }) => model);
  }

  private emitFallbackRoute(activeModel: Model, fromModel: Model, reason: ModelFallbackReason): void {
    this.emit({
      type: "provider_meta",
      activeProvider: activeModel.id || activeModel.provider,
      fallbackFrom: [{
        id: fromModel.id || fromModel.provider,
        provider: fromModel.provider,
        reason,
      }],
    });
  }

  private async finishWithFallback(
    baseMessages: ChatMessage[],
    reason: ModelFallbackReason,
    fromModel: Model,
  ): Promise<boolean> {
    const originalEvidenceMessages = hasAnyToolEvidence(baseMessages) ? [...baseMessages] : [];
    const candidates = this.fallbackModels(fromModel);
    if (!candidates.length) {
      const evidenceSafetyAnswer = buildEvidenceSafetyAnswer(originalEvidenceMessages.length ? originalEvidenceMessages : baseMessages);
      if (evidenceSafetyAnswer) {
        this.finishAssistantAnswer(evidenceSafetyAnswer, undefined, { streamedText: false });
        return true;
      }
      return false;
    }
    let sharedMessages = [...baseMessages];
    let latestEvidenceMessages = originalEvidenceMessages.length ? [...originalEvidenceMessages] : [];
    for (const candidate of candidates) {
      try {
        this.emitFallbackRoute(candidate, fromModel, reason);
        const existingAnyEvidence = hasAnyToolEvidence(sharedMessages);
        const existingUsableEvidence = hasUsableToolEvidence(sharedMessages);
        if (existingAnyEvidence) latestEvidenceMessages = [...sharedMessages];
        const availableFallbackTools = this.getFallbackTools();
        const allowTools = !existingUsableEvidence && availableFallbackTools.length > 0;
        const fallbackTools = allowTools ? availableFallbackTools : [];
        let workingMessages = existingUsableEvidence
          ? buildFallbackSynthesisMessages(sharedMessages, reason)
          : [
            ...sharedMessages,
            roleMessage("user", allowTools ? fallbackInstructionWithToolUse(reason) : fallbackInstruction(reason)),
          ];
        const maxFallbackToolRounds = allowTools ? 1 : 0;
        for (let round = 0; round <= maxFallbackToolRounds; round += 1) {
          const result = await this.callModel(workingMessages, {
            model: candidate,
          tools: round < maxFallbackToolRounds ? fallbackTools : [],
          streamText: false,
          timeoutMs: fallbackModelCallTimeoutMs(),
        });
          result.toolCalls = result.toolCalls.filter(isExecutableToolCall);
          const content = contentToText(result.assistant.content);
          if (content.trim() && !isUnsafeFinalAnswerText(content)) {
            this.finishAssistantAnswer(content, result.reasoning, {
              streamedText: false,
            });
            return true;
          }
          if (!result.toolCalls.length || round >= maxFallbackToolRounds) break;
          const assistantForHistory: ChatMessage = {
            role: "assistant",
            content: "",
            tool_calls: result.toolCalls as ChatAssistantToolCall[],
          };
          workingMessages.push(assistantForHistory);
          this.sessionManager.appendMessage(assistantForHistory);
          this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
          for (const toolCall of result.toolCalls) {
            const toolResult = await this.executeToolCall(toolCall, fallbackTools);
            const toolMessage: ChatMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: toolResultToMessageContent(toolResult),
            };
            workingMessages.push(toolMessage);
            this.sessionManager.appendMessage(toolMessage);
          }
          this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
          if (hasAnyToolEvidence(workingMessages)) {
            latestEvidenceMessages = [...workingMessages];
          }
          if (hasUsableToolEvidence(workingMessages)) {
            workingMessages = buildFallbackSynthesisMessages(workingMessages, reason);
          }
        }
        sharedMessages = workingMessages;
      } catch {
        // Try the next fallback model. The visible turn should end with either a
        // usable answer or the explicit safety fallback below, not intermediate noise.
      }
    }
    const evidenceSafetyAnswer = buildEvidenceSafetyAnswer(
      latestEvidenceMessages.length
        ? latestEvidenceMessages
        : originalEvidenceMessages.length ? originalEvidenceMessages : sharedMessages,
    );
    if (evidenceSafetyAnswer) {
      this.finishAssistantAnswer(evidenceSafetyAnswer, undefined, { streamedText: false });
      return true;
    }
    return false;
  }

  private async runTurn(): Promise<void> {
    this.isStreaming = true;
    this.abortController = new AbortController();
    let fallbackMessages: ChatMessage[] = [];
    try {
      const stepExecutorPolicy = this.findStepExecutorModel() ? buildStepExecutorPolicyPrompt() : "";
      const system = [
        await maybeString(this.resourceLoader.getSystemPrompt?.()),
        await maybeString(this.resourceLoader.getAppendSystemPrompt?.()),
        stepExecutorPolicy,
      ].filter(Boolean).join("\n\n");
      const rawContext = this.sessionManager.buildSessionContext().messages || [];
      const sanitizedContext = sanitizeMessagesBeforePrompt(rawContext);
      if (sanitizedContext.removed > 0 || sanitizedContext.rewritten > 0) {
        this.agent.replaceMessages(sanitizedContext.messages);
      }
      const baseContext = sanitizedContext.messages;
      const messages: ChatMessage[] = system ? [{ role: "system", content: system }, ...baseContext] : [...baseContext];
      fallbackMessages = messages;
      const maxToolRounds = 3;
      for (let round = 0; round < maxToolRounds; round += 1) {
        const result = await this.callModel(messages, { timeoutMs: defaultModelCallTimeoutMs() });
        result.toolCalls = result.toolCalls.filter(isExecutableToolCall);
        if (!result.toolCalls.length) {
          const content = contentToText(result.assistant.content);
          if (!content.trim()) {
            const handled = await this.finishWithFallback(messages, "empty_response", this.model);
            if (handled) return;
            this.finishAssistantAnswer(
              "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文；请点击「编辑重发」重试，或换个更明确的问题。",
              result.reasoning,
              { streamedText: false },
            );
            return;
          }
          if (isUnsafeFinalAnswerText(content)) {
            const handled = await this.finishWithFallback(messages, "empty_response", this.model);
            if (handled) return;
            const evidenceSafetyAnswer = buildEvidenceSafetyAnswer(messages);
            if (evidenceSafetyAnswer) {
              this.finishAssistantAnswer(evidenceSafetyAnswer, undefined, { streamedText: false });
              return;
            }
            this.finishAssistantAnswer(
              "模型返回的答案与当前日期或已有证据冲突。本轮已停止输出以避免误导；请点击「编辑重发」重新查询。",
              result.reasoning,
              { streamedText: false },
            );
            return;
          }
          this.finishAssistantAnswer(content, result.reasoning, {
            streamedText: result.streamedText,
            contentDeltas: result.contentDeltas,
          });
          return;
        }
        const assistantForHistory: ChatMessage = {
          role: "assistant",
          content: "",
          tool_calls: result.toolCalls as ChatAssistantToolCall[],
        };
        messages.push(assistantForHistory);
        this.sessionManager.appendMessage(assistantForHistory);
        this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
        for (const toolCall of result.toolCalls) {
          const toolResult = await this.executeToolCall(toolCall);
          const content = toolResultToMessageContent(toolResult);
          const toolMessage: ChatMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content,
          };
          messages.push(toolMessage);
          this.sessionManager.appendMessage(toolMessage);
        }
        this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
        fallbackMessages = messages;
        if (this.shouldAutoDelegateToStep(messages, round)) {
          const handled = await this.finishWithFallback(messages, "tool_round_limit", this.model);
          if (handled) return;
        }
      }
      const handled = await this.finishWithFallback(messages, "tool_round_limit", this.model);
      if (handled) return;
      const evidenceSafetyAnswer = buildEvidenceSafetyAnswer(messages);
      if (evidenceSafetyAnswer) {
        this.finishAssistantAnswer(evidenceSafetyAnswer, undefined, { streamedText: false });
        return;
      }
      this.finishAssistantAnswer(
        "工具链已执行多轮但没有形成最终回复。本轮已安全结束，请缩小问题范围后重试。",
        undefined,
        { streamedText: false },
      );
    } catch (err) {
      const isAbortError = (err as any)?.name === "AbortError";
      const handled = fallbackMessages.length
        ? await this.finishWithFallback(fallbackMessages, "model_error", this.model)
        : false;
      if (handled) return;
      if (isAbortError) {
        this.emit(eventError("aborted"));
      } else {
        this.emit(eventError(err instanceof Error ? err.message : String(err)));
      }
      this.emit({ type: "agent_end", messages: this.messages });
    } finally {
      this.isStreaming = false;
      this.abortController = null;
      this.drainPendingPrompts();
    }
  }

  private drainPendingPrompts(): void {
    if (this.disposed || this.isStreaming || this.pendingPrompts.length === 0) return;
    const next = this.pendingPrompts.shift();
    if (!next) return;
    void this.prompt(next.prompt, next.options);
  }

  private async callModel(messages: ChatMessage[], options: ModelCallOptions = {}): Promise<{
    assistant: ChatMessage;
    toolCalls: ToolCall[];
    reasoning: string;
    contentDeltas: string[];
    streamedText: boolean;
  }> {
    const model = options.model || this.model;
    const tools = options.tools ?? this.getAllTools();
    const streamTextImmediately = options.streamText ?? tools.length === 0;
    const body = buildRequestBody(model, messages, tools, this.thinkingLevel);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.requestHeaders,
    };
    if (model.apiKey && !headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${model.apiKey}`;
    }
    const timed = createTimedSignal(this.abortController?.signal, options.timeoutMs ?? defaultModelCallTimeoutMs());
    try {
      const response = await fetch(chatCompletionsUrl(model), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timed.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`LLM request failed: ${response.status} ${response.statusText}${text ? ` · ${text.slice(0, 500)}` : ""}`);
      }
      if (!response.body) throw new Error("LLM response did not include a stream body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolDeltas = new Map<number, StreamToolCallAccumulator>();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;
        for (const payload of parsed.payloads) {
          if (payload === "[DONE]") continue;
          this.handleLynnSideEvent(payload);
          const chunk = parsePayload(payload);
          if (!chunk) continue;
          if (chunk.error && !chunk.choices) throw new Error(typeof chunk.error === "string" ? chunk.error : maybeJson(chunk.error));
          for (const choice of chunk.choices || []) {
            const delta = choice.delta || choice.message || {};
            const reasoning = typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta.reasoning === "string" ? delta.reasoning : "";
            if (reasoning) {
              reasoningParts.push(reasoning);
              this.emit(eventThinkingDelta(reasoning));
            }
            if (typeof delta.content === "string" && delta.content) {
              textParts.push(delta.content);
              if (streamTextImmediately) this.emit(eventTextDelta(delta.content));
            }
            const rawToolCalls = delta.tool_calls || delta.toolCalls;
            if (Array.isArray(rawToolCalls)) {
              rawToolCalls.forEach((raw, index) => appendToolDelta(toolDeltas, raw, index));
            }
          }
        }
      }
      const toolCalls = finalizeToolCalls(toolDeltas);
      const content = textParts.join("");
      return {
        assistant: { role: "assistant", content, reasoning_content: reasoningParts.join("") || undefined },
        toolCalls,
        reasoning: reasoningParts.join(""),
        contentDeltas: textParts,
        streamedText: streamTextImmediately,
      };
    } catch (err) {
      if (timed.didTimeout()) throw new ModelCallTimeoutError(options.timeoutMs ?? defaultModelCallTimeoutMs());
      throw err;
    } finally {
      timed.cleanup();
    }
  }

  private handleLynnSideEvent(payload: string): void {
    const parsed = parsePayload(payload);
    if (!parsed) return;
    if (parsed.object === "lynn.provider") {
      this.emit({ type: "provider_meta", meta: parsed.meta || {} });
    }
    if (parsed.object === "lynn.tool_progress") {
      const progress = asRecord(parsed.tool_progress);
      this.emit({
        type: "tool_progress",
        name: String(progress.name || ""),
        event: String(progress.event || ""),
        ms: typeof progress.ms === "number" ? progress.ms : undefined,
        ok: typeof progress.ok === "boolean" ? progress.ok : undefined,
        summary: typeof progress.summary === "string" ? progress.summary : undefined,
        details: Array.isArray(progress.details) ? progress.details : undefined,
      });
    }
  }

  private async executeToolCall(toolCall: ToolCall, tools = this.getAllTools()): Promise<ToolResult> {
    const normalized = normalizeToolCallForExecution(toolCall.function.name, toolCall.function.arguments, tools);
    toolCall.function.name = normalized.name;
    toolCall.function.arguments = maybeJson(normalized.args);
    let tool = this.resolveToolByName(toolCall.function.name, tools);
    if (!tool?.execute && isBrainManagedCustomToolName(toolCall.function.name)) {
      tool = this.resolveToolByName(toolCall.function.name, this.getFallbackTools());
    }
    const args = normalized.args;
    this.emit({
      type: "message_update",
      role: "assistant",
      assistantMessageEvent: { type: "toolcall_start", toolCall },
    });
    this.emit({
      type: "tool_execution_start",
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      args,
      toolCall,
    });
    if (!tool?.execute) {
      const result = {
        isError: true,
        content: [{
          type: "text",
          text: `工具当前不可用：${toolCall.function.name}。请改用 web_search 或 web_fetch 获取公开来源。`,
        }],
      };
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: true,
      });
      return result;
    }
    try {
      const result = normalizeToolResult(await tool.execute(toolCall.id, args, this._buildRuntime()));
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: result.isError === true,
      });
      this.emit({
        type: "message_update",
        role: "assistant",
        assistantMessageEvent: { type: "toolcall_end", toolCall },
      });
      return result;
    } catch (err) {
      const result = {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: true,
      });
      return result;
    }
  }
}

export async function createLynnAgentSession(options: LynnCreateAgentSessionOptions = {}): Promise<{
  session: LynnAgentSession;
  extensionsResult: LoadExtensionsResult;
}> {
  const session = new LynnAgentSession(options);
  await session.resourceLoader.reload?.();
  return {
    session,
    extensionsResult: { extensions: [], diagnostics: [] },
  };
}
