import { AppError } from '../shared/errors.js';
import { errorBus } from '../shared/error-bus.js';
import { withRetry } from '../shared/retry.js';
import {
  readSignedClientAgentHeadersForProvider,
} from './client-agent-identity.js';
import { getPooledDispatcher } from '../shared/http-pool.js';
import type {
  LLMApi,
  LLMContentBlock,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ToolCall,
} from './types.js';
import type { ClientAgentHeaders } from './client-agent-identity.js';

type DisplayableTextType = "text" | "output_text" | "input_text" | "refusal";
type ResponseKind = "text" | "reasoning_only" | "non_displayable_content" | "empty";

type ContentStats = {
  textParts: string[];
  reasoningTextParts: string[];
  reasoningBlockCount: number;
  nonDisplayableBlockCount: number;
};

type ResponseAnalysis = {
  text: string;
  responseKind: ResponseKind;
  fallbackFromReasoning: boolean;
  reasoningBlockCount: number;
  nonDisplayableBlockCount: number;
};

type SseJsonEvent = {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  [key: string]: unknown;
};

type StreamChoice = {
  finish_reason?: unknown;
  delta?: unknown;
  message?: unknown;
  [key: string]: unknown;
};

type StreamMessageDelta = Partial<LLMMessage> & {
  content?: LLMMessage["content"];
  reasoning?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
};

type ClientAgentRequestMetadata = {
  method: "POST";
  pathname: "/v1/messages" | "/responses" | "/chat/completions";
};

type NormalizedMessage = {
  role: LLMMessage["role"];
  content: string | undefined;
  reasoning_content?: LLMMessage["reasoning_content"];
};

type LlmRequestBody = Record<string, unknown>;
type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: ReturnType<typeof getPooledDispatcher> | undefined;
};

type LlmRateLimitedError = AppError & {
  _retryAfterMs?: number;
};

const DISPLAYABLE_TEXT_TYPES: ReadonlySet<string> = new Set<DisplayableTextType>([
  "text",
  "output_text",
  "input_text",
  "refusal",
]);

function isDeepSeekProviderLike(provider: unknown, baseUrl: unknown): boolean {
  const providerId = String(provider || "").trim().toLowerCase();
  if (providerId.includes("deepseek")) return true;
  try {
    const url = new URL(String(baseUrl || ""));
    return url.hostname.toLowerCase().includes("deepseek");
  } catch {
    return String(baseUrl || "").toLowerCase().includes("deepseek");
  }
}

function isDeepSeekV4ThinkingModel(provider: unknown, model: unknown, baseUrl?: unknown): boolean {
  const modelId = String(model || "").trim().toLowerCase();
  return isDeepSeekProviderLike(provider, baseUrl)
    && (
      /^deepseek-v4-(?:flash|pro)(?:[-_.:].*)?$/u.test(modelId)
      || /^deepseek-reasoner(?:[-_.:].*)?$/u.test(modelId)
    );
}

function deepSeekThinkingPayload(reasoning: boolean): Record<string, unknown> {
  return {
    thinking: reasoning
      ? { type: "enabled", reasoning_effort: "high" }
      : { type: "disabled" },
  };
}

function createContentStats(): ContentStats {
  return {
    textParts: [],
    reasoningTextParts: [],
    reasoningBlockCount: 0,
    nonDisplayableBlockCount: 0,
  };
}

function extractTextValue(value: string | LLMContentBlock | null | undefined): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.value === "string") return value.value;
  if (typeof value.refusal === "string") return value.refusal;
  if (value.text && typeof value.text === "object") {
    if (typeof value.text.value === "string") return value.text.value;
    if (typeof value.text.text === "string") return value.text.text;
  }
  return "";
}

function isReasoningLikeBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const record = block as LLMContentBlock;
  const type = String(record.type || "").toLowerCase();
  return type.includes("thinking")
    || type.includes("reasoning")
    || typeof record.thinking === "string"
    || typeof record.reasoning === "string"
    || typeof record.reasoning_content === "string";
}

function extractUnknownText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(extractUnknownText).filter(Boolean).join("\n").trim();
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "value", "content", "summary"]) {
    const text = extractUnknownText(record[key]);
    if (text) return text;
  }
  return "";
}

function extractReasoningText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const record = block as LLMContentBlock;
  return [
    record.reasoning_content,
    record.reasoning,
    record.thinking,
    record.text,
    record.value,
  ].map(extractUnknownText).filter(Boolean).join("\n").trim();
}

function collectContentStats(content: LLMMessage["content"]): ContentStats {
  const stats = createContentStats();

  if (typeof content === "string") {
    const text = content.trim();
    if (text) stats.textParts.push(text);
    return stats;
  }

  if (!Array.isArray(content)) return stats;

  for (const block of content) {
    if (typeof block === "string") {
      const text = block.trim();
      if (text) stats.textParts.push(text);
      continue;
    }
    if (!block || typeof block !== "object") continue;

    const type = String(block.type || "").toLowerCase();
    if (DISPLAYABLE_TEXT_TYPES.has(type) || !type) {
      const text = extractTextValue(block).trim();
      if (text) {
        stats.textParts.push(text);
        continue;
      }
    }

    if (isReasoningLikeBlock(block)) {
      stats.reasoningBlockCount += 1;
      const reasoningText = extractReasoningText(block);
      if (reasoningText) stats.reasoningTextParts.push(reasoningText);
      continue;
    }

    stats.nonDisplayableBlockCount += 1;
  }

  return stats;
}

function mergeContentStats(target: ContentStats, source: ContentStats): void {
  target.textParts.push(...source.textParts);
  target.reasoningTextParts.push(...source.reasoningTextParts);
  target.reasoningBlockCount += source.reasoningBlockCount;
  target.nonDisplayableBlockCount += source.nonDisplayableBlockCount;
}

function cleanReasoningFallbackText(parts: string[]): string {
  const raw = stripInternalProgressTags(parts.join("\n"))
    .replace(/<\/?think>/giu, "")
    .trim();
  if (!raw) return "";

  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const stripLabel = (line: string): string => line
    .replace(/^(?:最终答案|答案|结论|final\s+answer|answer|conclusion)\s*[：:\-]\s*/iu, "")
    .trim();

  const labeled = [...lines].reverse().find((line) => (
    /^(?:最终答案|答案|结论|final\s+answer|answer|conclusion)\s*[：:\-]/iu.test(line)
  ));
  if (labeled) return stripLabel(labeled).slice(0, 1200).trim();

  const conclusion = [...lines].reverse().find((line) => (
    /^(?:因此|所以|综上|总之|简而言之|therefore|so|in\s+short)\b/iu.test(line)
  ));
  if (conclusion) return conclusion.slice(0, 1200).trim();

  const singleShortLine = lines.length === 1 && lines[0].length <= 220 ? lines[0] : "";
  if (singleShortLine && !/(?:先|需要|分析|思考|推理|step\s*by\s*step|reasoning)/iu.test(singleShortLine)) {
    return singleShortLine;
  }
  return "";
}

function finalizeResponseAnalysis(stats: ContentStats): ResponseAnalysis {
  const visibleText = stripInternalProgressTags(stats.textParts.join("\n")).trim();
  const fallbackText = visibleText ? "" : cleanReasoningFallbackText(stats.reasoningTextParts);
  const text = visibleText || fallbackText;
  const responseKind: ResponseKind = visibleText
    ? "text"
    : stats.reasoningBlockCount > 0
      ? "reasoning_only"
      : stats.nonDisplayableBlockCount > 0
        ? "non_displayable_content"
        : "empty";
  return {
    text,
    responseKind,
    fallbackFromReasoning: !visibleText && !!fallbackText,
    reasoningBlockCount: stats.reasoningBlockCount,
    nonDisplayableBlockCount: stats.nonDisplayableBlockCount,
  };
}

function stripInternalProgressTags(value: unknown): string {
  return String(value || "")
    .replace(/<lynn_tool_progress\b[^>]*>(?:<\/lynn_tool_progress>)?/giu, "")
    .replace(/<\/lynn_tool_progress>/giu, "");
}

function analyzeLlmResponse(api: LLMApi, data: LLMResponse | null): ResponseAnalysis {
  if (api === "anthropic-messages") {
    return finalizeResponseAnalysis(collectContentStats(data?.content));
  }

  if (api === "openai-responses" || api === "openai-codex-responses") {
    const stats = createContentStats();

    if (typeof data?.output_text === "string" && data.output_text.trim()) {
      stats.textParts.push(data.output_text.trim());
    }

    for (const item of Array.isArray(data?.output) ? data.output : []) {
      const record = item && typeof item === "object" ? item as LLMMessage & LLMContentBlock : null;
      if (record?.type === "message" && record?.role === "assistant") {
        mergeContentStats(stats, collectContentStats(record.content));
      } else if (isReasoningLikeBlock(item)) {
        stats.reasoningBlockCount += 1;
      } else if (item && typeof item === "object") {
        stats.nonDisplayableBlockCount += 1;
      }
    }

    return finalizeResponseAnalysis(stats);
  }

  const stats = createContentStats();
  const message = data?.choices?.[0]?.message;
  if (message) {
    mergeContentStats(stats, collectContentStats(message.content));
    const refusalText = typeof message.refusal === "string" ? message.refusal.trim() : "";
    if (!stats.textParts.length && refusalText) stats.textParts.push(refusalText);
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      stats.nonDisplayableBlockCount += message.tool_calls.length;
    }
    if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
      stats.reasoningBlockCount += 1;
      stats.reasoningTextParts.push(message.reasoning_content.trim());
    } else if (Array.isArray(message.reasoning_content) && message.reasoning_content.length > 0) {
      stats.reasoningBlockCount += message.reasoning_content.length;
      const reasoningText = extractUnknownText(message.reasoning_content);
      if (reasoningText) stats.reasoningTextParts.push(reasoningText);
    }
    if (message.reasoning && typeof message.reasoning === "object") {
      stats.reasoningBlockCount += 1;
      const reasoningText = extractUnknownText(message.reasoning);
      if (reasoningText) stats.reasoningTextParts.push(reasoningText);
    } else if (typeof message.reasoning === "string" && message.reasoning.trim()) {
      stats.reasoningBlockCount += 1;
      stats.reasoningTextParts.push(message.reasoning.trim());
    }
  }
  return finalizeResponseAnalysis(stats);
}

function parseSseJsonEvents(rawText: string): SseJsonEvent[] {
  const events: SseJsonEvent[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") return;
    try {
      events.push(JSON.parse(payload) as SseJsonEvent);
    } catch {
      // Ignore malformed telemetry/non-JSON SSE payloads; visible model output
      // is carried by OpenAI-compatible JSON data chunks.
    }
  };

  for (const line of String(rawText || "").split(/\r?\n/u)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return events;
}

function appendDeltaContent(parts: string[], value: LLMMessage["content"]): void {
  if (typeof value === "string") {
    if (value) parts.push(value);
    return;
  }
  const stats = collectContentStats(value);
  if (stats.textParts.length > 0) parts.push(stats.textParts.join("\n"));
}

function normalizeOpenAIStreamPayload(rawText: string): LLMResponse | null {
  const events = parseSseJsonEvents(rawText);
  if (events.length === 0) return null;

  let id = "";
  let model = "";
  let finishReason: unknown = null;
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (!id && typeof event.id === "string") id = event.id;
    if (typeof event.model === "string" && event.model) model = event.model;

    const choice = Array.isArray(event.choices) ? event.choices[0] : null;
    if (!choice || typeof choice !== "object") continue;
    const streamChoice = choice as StreamChoice;
    if (streamChoice.finish_reason) finishReason = streamChoice.finish_reason;

    const delta = streamChoice.delta && typeof streamChoice.delta === "object"
      ? streamChoice.delta as StreamMessageDelta
      : null;
    const message = streamChoice.message && typeof streamChoice.message === "object"
      ? streamChoice.message as StreamMessageDelta
      : null;
    if (delta) {
      appendDeltaContent(contentParts, delta.content);
      if (typeof delta.reasoning_content === "string") reasoningParts.push(delta.reasoning_content);
      if (typeof delta.reasoning === "string") reasoningParts.push(delta.reasoning);
      if (Array.isArray(delta.tool_calls)) toolCalls.push(...delta.tool_calls as ToolCall[]);
    }
    if (message) {
      appendDeltaContent(contentParts, message.content);
      if (typeof message.reasoning_content === "string") reasoningParts.push(message.reasoning_content);
      if (typeof message.reasoning === "string") reasoningParts.push(message.reasoning);
      if (Array.isArray(message.tool_calls)) toolCalls.push(...message.tool_calls as ToolCall[]);
    }
  }

  return {
    id,
    model,
    choices: [{
      index: 0,
      finish_reason: (finishReason || "stop") as string,
      message: {
        role: "assistant",
        content: contentParts.join("").trim(),
        reasoning_content: reasoningParts.join("").trim(),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    }],
  };
}

function parseLlmResponsePayload(rawText: string, contentType: string): LLMResponse | null {
  try {
    return rawText ? JSON.parse(rawText) as LLMResponse : null;
  } catch {
    if (/text\/event-stream/iu.test(contentType || "") || /^\s*data:/mu.test(rawText || "")) {
      const streamed = normalizeOpenAIStreamPayload(rawText);
      if (streamed) return streamed;
    }
    throw new Error("invalid-json");
  }
}

function applyVisibleAnswerRetryNudge(body: LlmRequestBody): void {
  const nudge = "上一次调用没有返回最终可见答案。本次请直接输出最终答案，不要只返回思考过程。";
  if (Array.isArray(body.messages)) {
    body.messages = [
      { role: "system", content: nudge },
      ...(body.messages as Array<unknown>),
    ];
  } else if (typeof body.instructions === "string") {
    body.instructions = `${body.instructions}\n\n${nudge}`;
  } else if (typeof body.system === "string") {
    body.system = `${body.system}\n\n${nudge}`;
  } else {
    body.instructions = nudge;
  }
  if ("enable_thinking" in body) body.enable_thinking = false;
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object") {
    body.thinking = { type: "disabled" };
  }
}

/**
 * core/llm-client.ts — 统一的非流式 LLM 调用入口
 *
 * 直接 HTTP POST（非流式），不走聊天 runtime 的流式链路。
 * 历史 stream-first 短文本路径对 DashScope 等供应商有 20-40x 延迟膨胀（stream SSE 首 token 慢），
 * utility 短文本生成（50-200 token）不需要流式，直接 POST 最快。
 *
 * URL 构造规则与聊天 runtime 一致，确保和 Chat 链路访问同一个端点：
 *   - openai-completions:  baseUrl + "/chat/completions"
 *   - anthropic-messages:  baseUrl + "/v1/messages"
 *   - openai-responses:    baseUrl + "/responses"
 */

/**
 * 统一非流式文本生成。
 *
 */
export async function callText({
  api,
  apiKey,
  baseUrl,
  model,
  provider = "custom",
  quirks = [],
  reasoning = false,
  systemPrompt = "",
  messages = [],
  temperature = 0.3,
  maxTokens = 512,
  timeoutMs,
  signal,
  requestHeaders = null,
  throwOnReasoningOnly = false,
}: LLMRequest): Promise<string> {
  // T3: 推理模型自动延长超时（reasoning 模型 TTFT 通常 20-40 秒）
  const effectiveTimeoutMs = timeoutMs ?? (reasoning ? 90_000 : 60_000);
  // ── 1. 消息归一化：提取 system 消息合并到 systemPrompt ──
  let mergedSystem = systemPrompt || "";
  const normalizedMessages: NormalizedMessage[] = [];
  const shouldPreserveReasoningContent = isDeepSeekV4ThinkingModel(provider, model, baseUrl);
  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => typeof c === "string" ? "" : c.text || "").join("")
          : "";
      if (text) mergedSystem += (mergedSystem ? "\n" : "") + text;
    } else {
      const normalized: NormalizedMessage = {
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      };
      if (
        shouldPreserveReasoningContent
        && m.role === "assistant"
        && m.reasoning_content != null
      ) {
        normalized.reasoning_content = m.reasoning_content;
      }
      normalizedMessages.push(normalized);
    }
  }

  // ── 2. 超时信号 ──
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const clientAgentRequestMetadata: ClientAgentRequestMetadata = {
    method: "POST",
    pathname: api === "anthropic-messages"
      ? "/v1/messages"
      : (api === "openai-responses" || api === "openai-codex-responses")
        ? "/responses"
        : "/chat/completions",
  };
  const clientAgentHeaders: ClientAgentHeaders = {
    ...readSignedClientAgentHeadersForProvider({
      method: clientAgentRequestMetadata.method,
      pathname: clientAgentRequestMetadata.pathname,
      provider,
      baseUrl,
    }),
    ...(requestHeaders || {}),
  };

  // ── 3. 按协议构造请求 ──
  const base = (baseUrl || "").replace(/\/+$/, "");
  const dispatcher = getPooledDispatcher(base);
  let endpoint: string;
  let headers: Record<string, string>;
  let body: LlmRequestBody;

  if (api === "anthropic-messages") {
    // Anthropic Messages API：baseUrl + /v1/messages（和 runtime Anthropic provider 一致）
    endpoint = `${base}/v1/messages`;
    headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...clientAgentHeaders,
    };
    if (apiKey) headers["x-api-key"] = apiKey;

    // Anthropic 格式：system 和 messages 分离
    const anthropicMessages = normalizedMessages.filter(m => m.role === "user" || m.role === "assistant");
    if (anthropicMessages.length === 0) anthropicMessages.push({ role: "user", content: "" });
    body = {
      model, temperature, max_tokens: maxTokens,
      ...(mergedSystem && { system: mergedSystem }),
      messages: anthropicMessages,
    };
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    // OpenAI Responses API
    endpoint = `${base}/responses`;
    headers = { "Content-Type": "application/json", ...clientAgentHeaders };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = {
      model, temperature, max_output_tokens: maxTokens,
      ...(mergedSystem && { instructions: mergedSystem }),
      input: normalizedMessages,
    };
  } else {
    // OpenAI Completions API（默认）：baseUrl + /chat/completions
    endpoint = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json", ...clientAgentHeaders };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const allMessages: NormalizedMessage[] = [];
    if (mergedSystem) allMessages.push({ role: "system", content: mergedSystem });
    allMessages.push(...normalizedMessages);
    body = {
      model, temperature, max_tokens: maxTokens,
      messages: allMessages,
      ...(quirks.includes("enable_thinking") && { enable_thinking: false }),
      ...(isDeepSeekV4ThinkingModel(provider, model, baseUrl) ? deepSeekThinkingPayload(reasoning) : {}),
    };
  }

  // ── 4. 发送请求（带自动重试） ──
  let reasoningOnlyRetryCount = 0;
  return withRetry<string>(async () => {
    const SLOW_THRESHOLD_MS = 15_000;
    const slowTimer = setTimeout(() => {
      errorBus.report(new AppError('LLM_SLOW_RESPONSE', {
        context: { model, provider, elapsed: SLOW_THRESHOLD_MS },
      }));
    }, SLOW_THRESHOLD_MS);

    const requestInit: FetchInitWithDispatcher = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
      dispatcher: dispatcher || undefined,
    };
    const res = await fetch(endpoint, requestInit).catch((err: unknown) => {
      clearTimeout(slowTimer);
      const errorName = (err as { name?: string }).name;
      if (errorName === "AbortError" || errorName === "TimeoutError") {
        throw new AppError('LLM_TIMEOUT', { context: { model }, cause: err });
      }
      throw err;
    });

    // ── 5. 解析响应 ──
    const rawText = await res.text();
    const contentType = typeof res.headers?.get === "function"
      ? (res.headers.get("content-type") || "")
      : "";
    clearTimeout(slowTimer);
    let data: LLMResponse | null;
    try {
      data = parseLlmResponsePayload(rawText, contentType);
    } catch {
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AppError('LLM_AUTH_FAILED', { context: { model, status: res.status } });
        }
        if (res.status === 429) {
          const retryAfterSec = parseInt(
            typeof res.headers?.get === "function" ? (res.headers.get('retry-after') || '0') : '0',
            10,
          );
          const err = new AppError('LLM_RATE_LIMITED', { context: { model, retryAfterMs: retryAfterSec > 0 ? retryAfterSec * 1000 : undefined } }) as LlmRateLimitedError;
          if (retryAfterSec > 0) err._retryAfterMs = retryAfterSec * 1000;
          throw err;
        }
      }
      throw new Error(`LLM returned invalid JSON (status=${res.status})`);
    }

    if (!res.ok) {
      const message = data?.error?.message || data?.message || rawText || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new AppError('LLM_AUTH_FAILED', { context: { model, status: res.status } });
      }
      if (res.status === 429) {
        const retryAfterSec = parseInt(
          typeof res.headers?.get === "function" ? (res.headers.get('retry-after') || '0') : '0',
          10,
        );
        const err = new AppError('LLM_RATE_LIMITED', { context: { model, retryAfterMs: retryAfterSec > 0 ? retryAfterSec * 1000 : undefined } }) as LlmRateLimitedError;
        if (retryAfterSec > 0) err._retryAfterMs = retryAfterSec * 1000;
        throw err;
      }
      throw new AppError('UNKNOWN', { message, context: { model, status: res.status } });
    }

    // ── 6. 提取文本 ──
    const analysis = analyzeLlmResponse(api, data);
    const text = analysis.text;

    if (analysis.responseKind === "reasoning_only") {
      if (throwOnReasoningOnly) {
        const err = new AppError('LLM_EMPTY_RESPONSE', {
          message: 'Model returned reasoning content without a final visible answer',
          context: {
            provider: provider || null,
            modelId: model || null,
            api: api || null,
            responseKind: analysis.responseKind,
            reasoningBlockCount: analysis.reasoningBlockCount,
            nonDisplayableBlockCount: analysis.nonDisplayableBlockCount,
          },
        });
        err.retryable = false;
        throw err;
      }
      if (reasoningOnlyRetryCount < 1) {
        reasoningOnlyRetryCount += 1;
        applyVisibleAnswerRetryNudge(body);
        throw new AppError('LLM_EMPTY_RESPONSE', {
          message: 'Model returned reasoning content without a final visible answer',
          context: {
            provider: provider || null,
            modelId: model || null,
            api: api || null,
            responseKind: analysis.responseKind,
            reasoningBlockCount: analysis.reasoningBlockCount,
            nonDisplayableBlockCount: analysis.nonDisplayableBlockCount,
            retriedWithVisibleAnswerNudge: true,
          },
        });
      }
      if (!text) {
        return "模型这次只返回了思考过程，没有给出最终可见答案。请重试，或切换到 /fast 后再发。";
      }
      return text;
    }

    if (!text) {
      if (combinedSignal.aborted) {
        throw new AppError('LLM_TIMEOUT', { context: { model } });
      }
      const err = new AppError('LLM_EMPTY_RESPONSE', {
        message: analysis.responseKind === "non_displayable_content"
            ? 'Model returned non-displayable structured content without visible text'
            : 'Model returned empty or non-displayable content',
        context: {
          provider: provider || null,
          modelId: model || null,
          api: api || null,
          responseKind: analysis.responseKind,
          reasoningBlockCount: analysis.reasoningBlockCount,
          nonDisplayableBlockCount: analysis.nonDisplayableBlockCount,
        },
      });
      if (analysis.responseKind !== "empty") err.retryable = false;
      throw err;
    }

    return text;
  }, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 15000,
    signal: combinedSignal,
  }) as Promise<string>;
}
