import { Hono } from "hono";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { safeJson } from "../hono-helpers.js";
import { BRAIN_API_ROOT, BRAIN_BACKUP_API_ROOT, isBrainProvider } from "../../shared/brain-provider.js";
import { findModel } from "../../shared/model-ref.js";
import { callText } from "../../core/llm-client.js";

export const DEFAULT_DEEP_RESEARCH_TIMEOUT_MS = 180_000;
const LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
const LOCAL_QWEN35_MODEL_ID = "qwen35-9b-q4km-imatrix";
const LOCAL_QWEN35_BASE_URL = "http://127.0.0.1:18099/v1";
const LOCAL_DEEP_RESEARCH_MAX_TOKENS = 32_768;

function normalizeBaseUrl(rawValue) {
  const value = String(rawValue || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function resolveDeepResearchBaseUrl(value) {
  return resolveDeepResearchBaseUrls(value)[0] || "";
}

export function resolveDeepResearchBaseUrls(value) {
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

export function buildDeepResearchEndpoint(baseUrl) {
  return buildDeepResearchEndpointCandidates(baseUrl)[0] || "";
}

export function buildDeepResearchEndpointCandidates(baseUrl) {
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

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function parseDeepResearchSse(rawText) {
  const textParts = [];
  const metaEvents = [];
  let finishReason = null;
  let winnerProviderId = null;
  let usage = null;

  for (const rawLine of String(rawText || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    const payload = parseJsonLine(data);
    if (!payload) {
      metaEvents.push({ type: "parse_error", raw: data.slice(0, 300) });
      continue;
    }

    if (payload.object === "deep-research.meta" || payload.type || payload.meta?.event) {
      const eventType = payload.type || payload.meta?.event || null;
      const normalizedMeta = {
        ...payload,
        type: eventType || payload.type,
      };
      metaEvents.push(normalizedMeta);
      if (eventType === "winner-picked") {
        winnerProviderId = payload.providerId || payload.winnerProviderId || payload.meta?.winnerProviderId || payload.meta?.providerId || winnerProviderId;
      }
      continue;
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const deltaContent = choice?.delta?.content;
    const messageContent = choice?.message?.content;
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

function normalizeMessages(body) {
  if (Array.isArray(body.messages) && body.messages.length) {
    return body.messages
      .filter((message) => message && typeof message === "object")
      .map((message) => ({
        role: String(message.role || "user"),
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      }))
      .filter((message) => message.content.trim());
  }

  const prompt = String(body.prompt || body.query || body.text || "").trim();
  return prompt ? [{ role: "user", content: prompt }] : [];
}

function shouldRunLocalDeepResearch(body) {
  const provider = String(body?.provider || body?.modelProvider || "").trim();
  const candidates = Array.isArray(body?.candidates)
    ? body.candidates.map((candidate) => String(candidate || "").trim()).filter(Boolean)
    : [];
  return /^local-qwen35-/u.test(provider) || candidates.some((candidate) => /^local-qwen35-/u.test(candidate));
}

function buildLocalChatCompletionsEndpoint(rawBaseUrl) {
  const normalized = normalizeBaseUrl(rawBaseUrl || process.env.LOCAL_QWEN35_BASE_URL || LOCAL_QWEN35_BASE_URL);
  if (!normalized) return `${LOCAL_QWEN35_BASE_URL}/chat/completions`;
  if (/\/chat\/completions$/iu.test(normalized)) return normalized;
  return `${normalized.replace(/\/+$/u, "")}/chat/completions`;
}

function parseOpenAiStreamLine(data, state) {
  if (!data || data === "[DONE]") return;
  const payload = parseJsonLine(data);
  if (!payload) return;
  if (payload.usage) state.usage = payload.usage;
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const delta = choice?.delta || {};
  const message = choice?.message || {};
  if (typeof delta.content === "string") state.text += delta.content;
  if (typeof message.content === "string") state.text += message.content;
  const reasoning = delta.reasoning_content || delta.reasoning || delta.thinking || message.reasoning_content || "";
  if (typeof reasoning === "string") state.reasoning += reasoning;
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
}

function buildLocalDeepResearchMessages(messages, enableThinking) {
  if (enableThinking !== false) return messages;
  return buildNoThinkMessages(messages);
}

function buildNoThinkMessages(messages) {
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
}) {
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

    const state = { text: "", reasoning: "", finishReason: null, usage: null };
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

async function runLocalDeepResearchWithFallback(args) {
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

async function resolveDirectModelConfig(engine, body) {
  const provider = String(body?.provider || body?.modelProvider || "").trim();
  const modelId = String(body?.model || body?.modelId || "").trim();
  if (!provider || !modelId || isBrainProvider(provider) || /^local-qwen35-/u.test(provider)) return null;

  const model = findModel(engine?.availableModels || [], modelId, provider);
  if (!model) {
    const err = new Error(`selected model not found: ${provider}/${modelId}`);
    err.status = 404;
    throw err;
  }

  const creds = engine.resolveProviderCredentials?.(model.provider) || {};
  const oauthCred = engine.authStorage?.get?.(model.provider);
  const oauthBaseUrl = oauthCred?.type === "oauth" ? oauthCred.resourceUrl : "";
  const baseUrl = creds.base_url || oauthBaseUrl || model.baseUrl || "";
  const api = creds.api || model.api || "openai-completions";
  let apiKey = creds.api_key || "";
  if (!apiKey) {
    try {
      apiKey = await engine.authStorage?.getApiKey?.(model.provider);
    } catch {
      // Some providers intentionally allow missing keys; validate below.
    }
  }
  const providerEntry = engine.providerRegistry?.get?.(model.provider);
  const allowMissingApiKey = providerEntry?.authType === "none";
  if (!baseUrl) {
    const err = new Error(`selected provider has no base_url: ${model.provider}`);
    err.status = 400;
    throw err;
  }
  if (!apiKey && !allowMissingApiKey) {
    const err = new Error(`selected provider has no api_key: ${model.provider}`);
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

function shouldRetryDirectModelWithoutThinking(err) {
  return err?.code === "LLM_EMPTY_RESPONSE"
    || /reasoning content without a final visible answer/iu.test(String(err?.message || ""))
    || /empty or non-displayable content/iu.test(String(err?.message || ""));
}

async function runDirectModelDeepResearch({ engine, messages, signal, timeoutMs, maxTokens, body, disableThinking = false }) {
  const config = await resolveDirectModelConfig(engine, body);
  if (!config) return null;
  const text = await callText({
    api: config.api,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    provider: config.provider,
    messages: disableThinking ? buildNoThinkMessages(messages) : messages,
    temperature: 0.2,
    quirks: disableThinking ? ["enable_thinking"] : [],
    maxTokens: Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
      ? Math.min(Number(maxTokens), LOCAL_DEEP_RESEARCH_MAX_TOKENS)
      : LOCAL_DEEP_RESEARCH_MAX_TOKENS,
    timeoutMs: Math.max(timeoutMs || DEFAULT_DEEP_RESEARCH_TIMEOUT_MS, 300_000),
    signal,
    reasoning: !disableThinking,
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

async function runDirectModelDeepResearchWithFallback(args) {
  try {
    return await runDirectModelDeepResearch(args);
  } catch (err) {
    if (!shouldRetryDirectModelWithoutThinking(err)) throw err;
    const retry = await runDirectModelDeepResearch({ ...args, disableThinking: true });
    return {
      ...retry,
      metaEvents: [
        {
          type: "selected-model-deep-research-retry",
          reason: "empty-visible-answer",
          firstErrorCode: err?.code || null,
        },
        ...(retry.metaEvents || []),
      ],
    };
  }
}

function isValidSessionPath(sessionPath, agentsDir) {
  if (!sessionPath || !agentsDir || !sessionPath.endsWith(".jsonl")) return false;
  const resolved = path.resolve(sessionPath);
  const base = path.resolve(agentsDir);
  return resolved.startsWith(base + path.sep);
}

function formatDeepResearchResultText(parsed) {
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

function escapeHtml(raw) {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeArtifactTitle(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 48) : "深度调研报告";
}

function buildDeepResearchArtifact({ messages, parsed }) {
  if (parsed?.artifact && typeof parsed.artifact === "object") {
    const artifact = parsed.artifact;
    const content = String(artifact.content || "").trim();
    if (content) {
      const artifactType = String(artifact.artifactType || artifact.type || "html").trim() || "html";
      return {
        artifactId: String(artifact.artifactId || artifact.id || `deep-research-${randomUUID().slice(0, 8)}`),
        artifactType,
        type: String(artifact.type || artifactType),
        title: String(artifact.title || "深度调研报告"),
        content,
        language: artifact.language ? String(artifact.language) : (artifactType === "html" ? "html" : undefined),
      };
    }
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
  return {
    artifactId,
    artifactType: "html",
    type: "html",
    title,
    content,
    language: "html",
  };
}

function buildDeepResearchSessionEntries({ messages, parsed }) {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const userText = messages.filter((message) => message.role === "user").at(-1)?.content
    || messages.at(-1)?.content
    || "";
  const userId = randomUUID().slice(0, 8);
  const assistantId = randomUUID().slice(0, 8);
  const artifact = buildDeepResearchArtifact({ messages, parsed });
  const assistantContent = [{ type: "text", text: formatDeepResearchResultText(parsed) }];
  if (artifact) {
    assistantContent.push({
      type: "toolCall",
      name: "create_artifact",
      arguments: {
        artifactId: artifact.artifactId,
        type: artifact.type,
        title: artifact.title,
        content: artifact.content,
        language: artifact.language,
      },
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

function persistDeepResearchExchange(engine, body, messages, parsed) {
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
    return { persisted: false, persistError: err?.message || String(err) };
  }
}

function withDeepResearchArtifact(payload, messages) {
  const artifact = buildDeepResearchArtifact({ messages, parsed: payload });
  return artifact ? { ...payload, artifact } : payload;
}

export function createDeepResearchRoute(engine, options = {}) {
  const route = new Hono();
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  route.post("/deep-research", async (c) => {
    const body = await safeJson(c, {});
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

      let lastFailure = null;
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
            if (err?.name === "AbortError") throw err;
            lastFailure = {
              status: 0,
              message: err?.message || String(err),
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
      const isAbort = err?.name === "AbortError";
      return c.json({
        error: isAbort ? "deep_research_timeout" : "deep_research_request_failed",
        message: err?.message || String(err),
        baseUrl,
      }, isAbort ? 504 : 502);
    } finally {
      clearTimeout(timer);
    }
  });

  return route;
}
