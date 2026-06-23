import { Hono } from "hono";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { safeJson } from "../hono-helpers.js";
import { BRAIN_API_ROOT, BRAIN_BACKUP_API_ROOT, isBrainProvider } from "../../shared/brain-provider.js";
import { findModel } from "../../shared/model-ref.js";
import { callText } from "../../shared/llm-client.js";
import { artifactToolArguments, normalizeArtifactPayload } from "../chat/artifact-shape.js";
import type { ArtifactPayload } from "../chat/artifact-shape.js";
import type { LLMApi, ModelId, ProviderId } from "../../core/types.js";

export const DEFAULT_DEEP_RESEARCH_TIMEOUT_MS = 180_000;
const LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
const LOCAL_QWEN35_MODEL_ID = "qwen35-9b-q4km-imatrix";
const LOCAL_QWEN35_BASE_URL = "http://127.0.0.1:18099/v1";
const LOCAL_DEEP_RESEARCH_MAX_TOKENS = 32_768;

type JsonRecord = Record<string, unknown>;

type DeepResearchMessage = {
  role: string;
  content: string;
};

type DeepResearchBody = {
  messages?: unknown;
  prompt?: unknown;
  query?: unknown;
  text?: unknown;
  provider?: unknown;
  modelProvider?: unknown;
  model?: unknown;
  modelId?: unknown;
  candidates?: unknown;
  baseUrl?: unknown;
  localBaseUrl?: unknown;
  sourceLabel?: unknown;
  max_tokens?: unknown;
  timeoutMs?: unknown;
  sessionPath?: unknown;
};

type DeepResearchMetaEvent = JsonRecord & {
  type?: unknown;
};

type DeepResearchParsed = {
  ok: true;
  text: string;
  reasoning?: string;
  finishReason: unknown | null;
  winnerProviderId: string | null | undefined;
  winnerModelId?: string;
  sourceLabel?: string;
  metaEvents: DeepResearchMetaEvent[];
  usage: unknown | null;
  artifact?: ArtifactPayload;
};

type PersistResult =
  | { persisted: false; persistError?: string }
  | { persisted: true; persistedSessionPath: string };

type DeepResearchModel = {
  id: string;
  provider?: string | null;
  name?: string | null;
  api?: LLMApi | null;
  baseUrl?: string | null;
  [key: string]: unknown;
};

type DeepResearchCredentials = {
  api_key?: string;
  base_url?: string;
  api?: LLMApi;
};

type OAuthCredential = {
  type?: unknown;
  resourceUrl?: unknown;
};

type DeepResearchProviderEntry = {
  authType?: unknown;
};

type DeepResearchEngine = {
  availableModels?: DeepResearchModel[];
  resolveProviderCredentials?: (provider: string | null | undefined) => DeepResearchCredentials | null | undefined;
  authStorage?: {
    get?: (provider: string | null | undefined) => OAuthCredential | null | undefined;
    getApiKey?: (provider: string | null | undefined) => Promise<string | null | undefined> | string | null | undefined;
  };
  providerRegistry?: {
    get?: (provider: string | null | undefined) => DeepResearchProviderEntry | null | undefined;
  };
  agentsDir?: string | null;
};

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type DeepResearchRouteOptions = {
  fetchImpl?: FetchImpl;
};

type DirectModelConfig = {
  provider: string | null | undefined;
  model: string;
  api: LLMApi;
  apiKey: string;
  baseUrl: string;
  sourceLabel: string;
};

type RunDeepResearchArgs = {
  fetchImpl: FetchImpl;
  messages: DeepResearchMessage[];
  signal: AbortSignal;
  timeoutMs: number;
  maxTokens: unknown;
  baseUrl?: unknown;
  providerId?: string;
  modelId?: string;
  sourceLabel?: string;
  enableThinking?: boolean;
};

type RunDirectModelArgs = {
  engine: DeepResearchEngine;
  messages: DeepResearchMessage[];
  signal: AbortSignal;
  timeoutMs: number;
  maxTokens: unknown;
  body: DeepResearchBody;
  disableThinking?: boolean;
};

type LocalStreamState = {
  text: string;
  reasoning: string;
  finishReason: unknown | null;
  usage: unknown | null;
};

type UpstreamFailure = {
  status: number;
  message: string;
  baseUrl: string;
  endpoint: string;
};

type ErrorLike = Error & {
  code?: unknown;
  status?: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function readErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function readErrorCode(err: unknown): unknown {
  return isRecord(err) ? err.code : undefined;
}

function normalizeBaseUrl(rawValue: unknown): string {
  const value = String(rawValue || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function resolveDeepResearchBaseUrl(value: unknown): string {
  return resolveDeepResearchBaseUrls(value)[0] || "";
}

export function resolveDeepResearchBaseUrls(value: unknown): string[] {
  const explicit = normalizeBaseUrl(value);
  if (explicit) return [explicit];

  const envValue = normalizeBaseUrl(
    process.env.LYNN_DEEP_RESEARCH_BASE_URL
      || process.env.LYNN_BRAIN_V2_BASE_URL
      || process.env.LYNN_BRAIN_V2_BASE
      || process.env.BRAIN_V2_BASE_URL
      || process.env.BRAIN_V2_BASE,
  );
  if (envValue) return [envValue];

  return unique([
    normalizeBaseUrl(`${BRAIN_API_ROOT}/v2`),
    normalizeBaseUrl(`${BRAIN_BACKUP_API_ROOT}/v2`),
    "http://127.0.0.1:8790",
  ]);
}

export function buildDeepResearchEndpoint(baseUrl: unknown): string {
  return buildDeepResearchEndpointCandidates(baseUrl)[0] || "";
}

export function buildDeepResearchEndpointCandidates(baseUrl: unknown): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return [];

  // Public mirrors often expose /api/v2 as an nginx prefix that strips itself
  // before proxying to Brain v2. In that shape, the real upstream route is
  // /api/v2/v2/deep-research/completions, while direct :8790 uses /v2/....
  if (/\/api\/v2$/iu.test(normalized)) {
    return unique([
      `${normalized}/v2/deep-research/completions`,
      `${normalized}/deep-research/completions`,
    ]);
  }

  if (/\/v2$/iu.test(normalized)) {
    return unique([
      `${normalized}/deep-research/completions`,
      `${normalized}/v2/deep-research/completions`,
    ]);
  }

  return [`${normalized}/v2/deep-research/completions`];
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export function parseDeepResearchSse(rawText: unknown): DeepResearchParsed {
  const textParts: string[] = [];
  const metaEvents: DeepResearchMetaEvent[] = [];
  let finishReason: unknown | null = null;
  let winnerProviderId: string | null = null;
  let usage: unknown | null = null;

  for (const rawLine of String(rawText || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    const payload = readRecord(parseJsonLine(data));
    if (!payload) {
      metaEvents.push({ type: "parse_error", raw: data.slice(0, 300) });
      continue;
    }

    const payloadMeta = readRecord(payload.meta);
    const eventType = payload.type || payloadMeta?.event || null;
    if (payload.object === "deep-research.meta" || payload.type || payloadMeta?.event) {
      const normalizedMeta = {
        ...payload,
        type: eventType || payload.type,
      };
      metaEvents.push(normalizedMeta);
      if (eventType === "winner-picked") {
        const nextWinner = payload.providerId || payload.winnerProviderId || payloadMeta?.winnerProviderId || payloadMeta?.providerId;
        winnerProviderId = typeof nextWinner === "string" ? nextWinner : winnerProviderId;
      }
      continue;
    }

    const choice = Array.isArray(payload.choices) ? readRecord(payload.choices[0]) : null;
    const delta = readRecord(choice?.delta);
    const message = readRecord(choice?.message);
    const deltaContent = delta?.content;
    const messageContent = message?.content;
    if (typeof deltaContent === "string") textParts.push(deltaContent);
    else if (typeof messageContent === "string") textParts.push(messageContent);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (payload.usage) usage = payload.usage;
  }

  return {
    ok: true,
    text: textParts.join(""),
    finishReason,
    winnerProviderId,
    metaEvents,
    usage,
  };
}

function normalizeMessages(body: DeepResearchBody): DeepResearchMessage[] {
  if (Array.isArray(body.messages) && body.messages.length) {
    return body.messages
      .filter(isRecord)
      .map((message) => ({
        role: String(message.role || "user"),
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      }))
      .filter((message) => message.content.trim());
  }

  const prompt = String(body.prompt || body.query || body.text || "").trim();
  return prompt ? [{ role: "user", content: prompt }] : [];
}

function shouldRunLocalDeepResearch(body: DeepResearchBody): boolean {
  const provider = String(body?.provider || body?.modelProvider || "").trim();
  const candidates = Array.isArray(body?.candidates)
    ? body.candidates.map((candidate) => String(candidate || "").trim()).filter(Boolean)
    : [];
  return /^local-qwen35-/u.test(provider) || candidates.some((candidate) => /^local-qwen35-/u.test(candidate));
}

function buildLocalChatCompletionsEndpoint(rawBaseUrl: unknown): string {
  const normalized = normalizeBaseUrl(rawBaseUrl || process.env.LOCAL_QWEN35_BASE_URL || LOCAL_QWEN35_BASE_URL);
  if (!normalized) return `${LOCAL_QWEN35_BASE_URL}/chat/completions`;
  if (/\/chat\/completions$/iu.test(normalized)) return normalized;
  return `${normalized.replace(/\/+$/u, "")}/chat/completions`;
}

function parseOpenAiStreamLine(data: string, state: LocalStreamState): void {
  if (!data || data === "[DONE]") return;
  const payload = readRecord(parseJsonLine(data));
  if (!payload) return;
  if (payload.usage) state.usage = payload.usage;
  const choice = Array.isArray(payload.choices) ? readRecord(payload.choices[0]) : null;
  const delta = readRecord(choice?.delta) || {};
  const message = readRecord(choice?.message) || {};
  if (typeof delta.content === "string") state.text += delta.content;
  if (typeof message.content === "string") state.text += message.content;
  const reasoning = delta.reasoning_content || delta.reasoning || delta.thinking || message.reasoning_content || "";
  if (typeof reasoning === "string") state.reasoning += reasoning;
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
}

function buildLocalDeepResearchMessages(messages: DeepResearchMessage[], enableThinking: boolean): DeepResearchMessage[] {
  if (enableThinking !== false) return messages;
  return buildNoThinkMessages(messages);
}

function buildNoThinkMessages(messages: DeepResearchMessage[]): DeepResearchMessage[] {
  const next = messages.map((message) => ({ ...message }));
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i]?.role !== "user") continue;
    const content = String(next[i].content || "");
    next[i] = {
      ...next[i],
      content: /\/no_think\b/u.test(content) ? content : `${content.trim()}\n\n/no_think`,
    };
    break;
  }
  return next;
}

async function runLocalDeepResearch({
  fetchImpl,
  messages,
  signal,
  timeoutMs,
  maxTokens,
  baseUrl,
  providerId,
  modelId,
  sourceLabel,
  enableThinking = true,
}: RunDeepResearchArgs): Promise<DeepResearchParsed> {
  const endpoint = buildLocalChatCompletionsEndpoint(baseUrl);
  const localTimeoutMs = Math.max(timeoutMs || DEFAULT_DEEP_RESEARCH_TIMEOUT_MS, 300_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), localTimeoutMs);
  const relayAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.("abort", relayAbort, { once: true });

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelId || LOCAL_QWEN35_MODEL_ID,
        messages: buildLocalDeepResearchMessages(messages, enableThinking),
        temperature: 0.2,
        max_tokens: Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
          ? Number(maxTokens)
          : LOCAL_DEEP_RESEARCH_MAX_TOKENS,
        stream: true,
        chat_template_kwargs: { enable_thinking: enableThinking !== false },
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      throw new Error(`local deep research failed: HTTP ${res.status}${raw ? ` ${raw.slice(0, 500)}` : ""}`);
    }

    const state: LocalStreamState = { text: "", reasoning: "", finishReason: null, usage: null };
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        parseOpenAiStreamLine(data, state);
      }
      if (done) break;
    }
    if (buffer.trim().startsWith("data:")) {
      parseOpenAiStreamLine(buffer.trim().slice(5).trim(), state);
    }
    return {
      ok: true,
      text: state.text,
      reasoning: state.reasoning,
      finishReason: state.finishReason || "stop",
      winnerProviderId: providerId || LOCAL_QWEN35_PROVIDER_ID,
      winnerModelId: modelId || LOCAL_QWEN35_MODEL_ID,
      sourceLabel: sourceLabel || providerId || LOCAL_QWEN35_PROVIDER_ID,
      metaEvents: [{ type: "local-deep-research", endpoint, enableThinking: enableThinking !== false }],
      usage: state.usage,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", relayAbort);
  }
}

async function runLocalDeepResearchWithFallback(args: RunDeepResearchArgs): Promise<DeepResearchParsed> {
  const first = await runLocalDeepResearch({ ...args, enableThinking: true });
  if (String(first.text || "").trim()) return first;
  const retry = await runLocalDeepResearch({ ...args, enableThinking: false });
  return {
    ...retry,
    metaEvents: [
      ...(first.metaEvents || []),
      {
        type: "local-deep-research-retry",
        reason: "empty-visible-answer",
        firstFinishReason: first.finishReason || null,
        firstReasoningChars: String(first.reasoning || "").length,
      },
      ...(retry.metaEvents || []),
    ],
    usage: retry.usage || first.usage,
  };
}

async function resolveDirectModelConfig(engine: DeepResearchEngine, body: DeepResearchBody): Promise<DirectModelConfig | null> {
  const provider = String(body?.provider || body?.modelProvider || "").trim();
  const modelId = String(body?.model || body?.modelId || "").trim();
  if (!provider || !modelId || isBrainProvider(provider) || /^local-qwen35-/u.test(provider)) return null;

  const model = findModel(engine?.availableModels || [], modelId, provider);
  if (!model) {
    const err: ErrorLike = new Error(`selected model not found: ${provider}/${modelId}`);
    err.status = 404;
    throw err;
  }

  const creds = engine.resolveProviderCredentials?.(model.provider) || {};
  const oauthCred = engine.authStorage?.get?.(model.provider);
  const oauthBaseUrl = oauthCred?.type === "oauth" ? String(oauthCred.resourceUrl || "") : "";
  const baseUrl = creds.base_url || oauthBaseUrl || model.baseUrl || "";
  const api = creds.api || model.api || "openai-completions";
  let apiKey = creds.api_key || "";
  if (!apiKey) {
    try {
      apiKey = String(await engine.authStorage?.getApiKey?.(model.provider) || "");
    } catch {
      // Some providers intentionally allow missing keys; validate below.
    }
  }
  const providerEntry = engine.providerRegistry?.get?.(model.provider);
  const allowMissingApiKey = providerEntry?.authType === "none";
  if (!baseUrl) {
    const err: ErrorLike = new Error(`selected provider has no base_url: ${model.provider}`);
    err.status = 400;
    throw err;
  }
  if (!apiKey && !allowMissingApiKey) {
    const err: ErrorLike = new Error(`selected provider has no api_key: ${model.provider}`);
    err.status = 401;
    throw err;
  }

  return {
    provider: model.provider,
    model: model.id,
    api,
    apiKey,
    baseUrl,
    sourceLabel: String(body?.sourceLabel || model.name || `${model.provider}/${model.id}`).trim(),
  };
}

function shouldRetryDirectModelWithoutThinking(err: unknown): boolean {
  const message = readErrorMessage(err);
  return readErrorCode(err) === "LLM_EMPTY_RESPONSE"
    || /reasoning content without a final visible answer/iu.test(message)
    || /empty or non-displayable content/iu.test(message);
}

async function runDirectModelDeepResearch({
  engine,
  messages,
  signal,
  timeoutMs,
  maxTokens,
  body,
  disableThinking = false,
}: RunDirectModelArgs): Promise<DeepResearchParsed | null> {
  const config = await resolveDirectModelConfig(engine, body);
  if (!config) return null;
  const text = await callText({
    api: config.api,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model as ModelId,
    provider: config.provider == null ? undefined : config.provider as ProviderId,
    messages: disableThinking ? buildNoThinkMessages(messages) : messages,
    temperature: 0.2,
    quirks: disableThinking ? ["enable_thinking"] : [],
    maxTokens: Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
      ? Math.min(Number(maxTokens), LOCAL_DEEP_RESEARCH_MAX_TOKENS)
      : LOCAL_DEEP_RESEARCH_MAX_TOKENS,
    timeoutMs: Math.max(timeoutMs || DEFAULT_DEEP_RESEARCH_TIMEOUT_MS, 300_000),
    signal,
    reasoning: !disableThinking,
    throwOnReasoningOnly: true,
  });
  return {
    ok: true,
    text,
    finishReason: "stop",
    winnerProviderId: config.provider,
    winnerModelId: config.model,
    sourceLabel: config.sourceLabel,
    metaEvents: [{
      type: "selected-model-deep-research",
      provider: config.provider,
      model: config.model,
      enableThinking: !disableThinking,
    }],
    usage: null,
  };
}

async function runDirectModelDeepResearchWithFallback(args: RunDirectModelArgs): Promise<DeepResearchParsed | null> {
  try {
    return await runDirectModelDeepResearch(args);
  } catch (err) {
    if (!shouldRetryDirectModelWithoutThinking(err)) throw err;
    const retry = await runDirectModelDeepResearch({ ...args, disableThinking: true });
    if (!retry) return retry;
    return {
      ...retry,
      metaEvents: [
        {
          type: "selected-model-deep-research-retry",
          reason: "empty-visible-answer",
          firstErrorCode: readErrorCode(err) || null,
        },
        ...(retry?.metaEvents || []),
      ],
    };
  }
}

function isValidSessionPath(sessionPath: string, agentsDir: string | null | undefined): boolean {
  if (!sessionPath || !agentsDir || !sessionPath.endsWith(".jsonl")) return false;
  const resolved = path.resolve(sessionPath);
  const base = path.resolve(agentsDir);
  return resolved.startsWith(base + path.sep);
}

function formatDeepResearchResultText(parsed: DeepResearchParsed): string {
  const text = String(parsed?.text || "").trim();
  const label = String(parsed?.sourceLabel || parsed?.winnerModelId || parsed?.winnerProviderId || "").trim();
  const source = label ? ` · 输出来源：${label}` : "";
  const status = "完成";
  return [
    text,
    "",
    "---",
    `**深度调研**：${status}${source}`,
  ].filter(Boolean).join("\n");
}

function escapeHtml(raw: unknown): string {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeArtifactTitle(raw: unknown): string {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 48) : "深度调研报告";
}

function buildDeepResearchArtifact({
  messages,
  parsed,
}: {
  messages: DeepResearchMessage[];
  parsed: DeepResearchParsed;
}): ArtifactPayload | null {
  if (parsed?.artifact && typeof parsed.artifact === "object") {
    const artifact = normalizeArtifactPayload(parsed.artifact, {
      fallbackIdPrefix: "deep-research",
      fallbackId: `deep-research-${randomUUID().slice(0, 8)}`,
      defaultTitle: "深度调研报告",
    });
    if (artifact) return artifact;
  }

  const text = String(parsed?.text || "").trim();
  if (!text) return null;
  const userText = messages.filter((message) => message.role === "user").at(-1)?.content
    || messages.at(-1)?.content
    || "";
  const label = String(parsed?.sourceLabel || parsed?.winnerModelId || parsed?.winnerProviderId || "").trim();
  const title = `深度调研报告 · ${safeArtifactTitle(userText)}`;
  const artifactId = `deep-research-${randomUUID().slice(0, 8)}`;
  const sourceLine = label ? `<p class="meta">输出来源：${escapeHtml(label)}</p>` : "";
  const content = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="lynn-report-style" content="deep-research-html">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; }
    body { margin: 0; background: #f6f4ee; color: #33383d; }
    main { max-width: 920px; margin: 0 auto; padding: 48px 40px 64px; background: #fffefa; min-height: 100vh; box-sizing: border-box; }
    h1 { margin: 0 0 12px; font-size: 30px; line-height: 1.25; letter-spacing: 0; }
    .meta { margin: 0 0 28px; color: #65717a; font-size: 14px; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: 16px/1.78 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${sourceLine}
    <pre>${escapeHtml(text)}</pre>
  </main>
</body>
</html>`;
  return normalizeArtifactPayload({
    artifactId,
    artifactType: "html",
    type: "html",
    title,
    content,
    language: "html",
  }, { defaultTitle: "深度调研报告" });
}

function buildDeepResearchSessionEntries({
  messages,
  parsed,
}: {
  messages: DeepResearchMessage[];
  parsed: DeepResearchParsed;
}): JsonRecord[] {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const userText = messages.filter((message) => message.role === "user").at(-1)?.content
    || messages.at(-1)?.content
    || "";
  const userId = randomUUID().slice(0, 8);
  const assistantId = randomUUID().slice(0, 8);
  const artifact = buildDeepResearchArtifact({ messages, parsed });
  const assistantContent: JsonRecord[] = [{ type: "text", text: formatDeepResearchResultText(parsed) }];
  if (artifact) {
    const args = artifactToolArguments(artifact);
    assistantContent.push({
      type: "toolCall",
      name: "create_artifact",
      arguments: args,
    });
  }
  return [
    {
      type: "message",
      id: userId,
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: userText }],
        timestamp: now,
      },
    },
    {
      type: "message",
      id: assistantId,
      parentId: userId,
      timestamp: new Date(now + 1).toISOString(),
      message: {
        role: "assistant",
        content: assistantContent,
        api: "deep-research",
        provider: "brain-v2",
        model: parsed?.winnerProviderId || "deep-research",
        stopReason: parsed?.finishReason || "stop",
        timestamp: now + 1,
      },
    },
  ];
}

function persistDeepResearchExchange(
  engine: DeepResearchEngine,
  body: DeepResearchBody,
  messages: DeepResearchMessage[],
  parsed: DeepResearchParsed,
): PersistResult {
  const sessionPath = String(body?.sessionPath || "").trim();
  if (!sessionPath) return { persisted: false };
  if (!isValidSessionPath(sessionPath, engine?.agentsDir)) {
    return { persisted: false, persistError: "invalid_session_path" };
  }
  try {
    const entries = buildDeepResearchSessionEntries({ messages, parsed });
    const block = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    fs.appendFileSync(sessionPath, block, "utf8");
    return { persisted: true, persistedSessionPath: sessionPath };
  } catch (err) {
    return { persisted: false, persistError: readErrorMessage(err) };
  }
}

function withDeepResearchArtifact(payload: DeepResearchParsed, messages: DeepResearchMessage[]): DeepResearchParsed {
  const artifact = buildDeepResearchArtifact({ messages, parsed: payload });
  return artifact ? { ...payload, artifact } : payload;
}

export function createDeepResearchRoute(engine: DeepResearchEngine, options: DeepResearchRouteOptions = {}): Hono {
  const route = new Hono();
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  route.post("/deep-research", async (c) => {
    const body = await safeJson<DeepResearchBody>(c, {});
    const messages = normalizeMessages(body);
    if (!messages.length) {
      return c.json({ error: "missing_prompt" }, 400);
    }

    const baseUrls = resolveDeepResearchBaseUrls(body.baseUrl);
    const baseUrl = baseUrls[0];
    const timeoutMs = Number.isFinite(Number(body.timeoutMs))
      ? Math.max(1_000, Math.min(Number(body.timeoutMs), 300_000))
      : DEFAULT_DEEP_RESEARCH_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (shouldRunLocalDeepResearch(body)) {
        const parsed = await runLocalDeepResearchWithFallback({
          fetchImpl,
          messages,
          signal: controller.signal,
          timeoutMs,
          maxTokens: body.max_tokens,
          baseUrl: body.localBaseUrl,
          providerId: String(body.provider || LOCAL_QWEN35_PROVIDER_ID),
          modelId: String(body.model || LOCAL_QWEN35_MODEL_ID),
          sourceLabel: String(body.sourceLabel || ""),
        });
        const parsedWithArtifact = withDeepResearchArtifact(parsed, messages);
        const persistence = persistDeepResearchExchange(engine, body, messages, parsedWithArtifact);
        return c.json({
          ...parsedWithArtifact,
          baseUrl: buildLocalChatCompletionsEndpoint(body.localBaseUrl),
          endpoint: buildLocalChatCompletionsEndpoint(body.localBaseUrl),
          attemptedBaseUrls: [buildLocalChatCompletionsEndpoint(body.localBaseUrl)],
          ...persistence,
          source: "local-qwen35-deep-research",
        });
      }

      const selectedModelParsed = await runDirectModelDeepResearchWithFallback({
        engine,
        messages,
        signal: controller.signal,
        timeoutMs,
        maxTokens: body.max_tokens,
        body,
      });
      if (selectedModelParsed) {
        const parsedWithArtifact = withDeepResearchArtifact(selectedModelParsed, messages);
        const persistence = persistDeepResearchExchange(engine, body, messages, parsedWithArtifact);
        return c.json({
          ...parsedWithArtifact,
          attemptedBaseUrls: [],
          ...persistence,
          source: "selected-model-deep-research",
        });
      }

      const upstreamBody = {
        messages,
        ...(Array.isArray(body.candidates) ? { candidates: body.candidates } : {}),
        ...(Number.isFinite(Number(body.max_tokens)) ? { max_tokens: Number(body.max_tokens) } : {}),
      };

      let lastFailure: UpstreamFailure | null = null;
      for (const candidateBaseUrl of baseUrls) {
        for (const endpoint of buildDeepResearchEndpointCandidates(candidateBaseUrl)) {
          try {
            const upstream = await fetchImpl(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(upstreamBody),
              signal: controller.signal,
            });

            const raw = await upstream.text();
            if (!upstream.ok) {
              lastFailure = {
                status: upstream.status,
                message: raw.slice(0, 1_000),
                baseUrl: candidateBaseUrl,
                endpoint,
              };
              continue;
            }

            const parsed = parseDeepResearchSse(raw);
            if (body.sourceLabel && isBrainProvider(String(body.provider || ""))) {
              parsed.sourceLabel = String(body.sourceLabel);
            }
            const parsedWithArtifact = withDeepResearchArtifact(parsed, messages);
            const persistence = persistDeepResearchExchange(engine, body, messages, parsedWithArtifact);
            return c.json({
              ...parsedWithArtifact,
              baseUrl: candidateBaseUrl,
              endpoint,
              attemptedBaseUrls: baseUrls,
              ...persistence,
              source: "brain-v2-deep-research",
            });
          } catch (err) {
            if (isAbortError(err)) throw err;
            lastFailure = {
              status: 0,
              message: readErrorMessage(err),
              baseUrl: candidateBaseUrl,
              endpoint,
            };
          }
        }
      }

      return c.json({
        error: "deep_research_upstream_error",
        status: lastFailure?.status || 0,
        message: lastFailure?.message || "all deep research upstreams failed",
        baseUrl: lastFailure?.baseUrl || baseUrl,
        endpoint: lastFailure?.endpoint,
        attemptedBaseUrls: baseUrls,
      }, 502);
    } catch (err) {
      const isAbort = isAbortError(err);
      return c.json({
        error: isAbort ? "deep_research_timeout" : "deep_research_request_failed",
        message: readErrorMessage(err),
        baseUrl,
      }, isAbort ? 504 : 502);
    } finally {
      clearTimeout(timer);
    }
  });

  return route;
}
