import type { LocalQwen35Message } from "./local-qwen35-direct-policy.js";

export interface LocalQwen35Usage {
  [key: string]: unknown;
}

interface LocalQwen35FetchBody extends AsyncIterable<Uint8Array> {
  cancel?: () => unknown | Promise<unknown>;
}

interface LocalQwen35FetchResponse {
  ok: boolean;
  body: LocalQwen35FetchBody | null;
  status: number;
  text: () => Promise<string>;
}

export type LocalQwen35FetchImpl = (input: unknown, init: RequestInit) => Promise<LocalQwen35FetchResponse>;

export interface LocalQwen35StreamState {
  assistantText: string;
  reasoningText: string;
  usage: LocalQwen35Usage | null;
}

interface LocalQwen35StreamDelta {
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
  content?: string;
}

interface LocalQwen35StreamPayload {
  usage?: LocalQwen35Usage;
  choices?: Array<{ delta?: LocalQwen35StreamDelta }>;
}

export interface StreamLocalQwen35CompletionOptions {
  endpoint?: string;
  model?: string;
  messages?: LocalQwen35Message[];
  enableThinking?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  fetchImpl?: LocalQwen35FetchImpl;
  onFirstDelta?: () => void;
  onReasoningDelta?: (delta: string) => void | Promise<void>;
  onContentDelta?: (delta: string) => void | Promise<void>;
  onUsage?: (usage: LocalQwen35Usage) => void;
  shouldStopEarly?: (state: LocalQwen35StreamState) => boolean;
}

export interface StreamLocalQwen35CompletionResult {
  assistantText: string;
  reasoningText: string;
  usage: LocalQwen35Usage | null;
  timedOutAfterVisibleOutput: boolean;
}

export async function streamLocalQwen35Completion({
  endpoint,
  model,
  messages,
  enableThinking,
  maxTokens,
  timeoutMs,
  temperature = 0.2,
  fetchImpl = globalThis.fetch as unknown as LocalQwen35FetchImpl,
  onFirstDelta,
  onReasoningDelta,
  onContentDelta,
  onUsage,
  shouldStopEarly,
}: StreamLocalQwen35CompletionOptions = {}): Promise<StreamLocalQwen35CompletionResult> {
  if (typeof fetchImpl !== "function") {
    throw new Error("local qwen direct bridge failed: fetch is unavailable");
  }

  const controller = new AbortController();
  let abortedByTimeout = false;
  let timedOutAfterVisibleOutput = false;
  let assistantText = "";
  let reasoningText = "";
  let usage: LocalQwen35Usage | null = null;
  let firstDeltaSeen = false;
  const timeout = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  const notifyFirstDelta = () => {
    if (firstDeltaSeen) return;
    firstDeltaSeen = true;
    onFirstDelta?.();
  };

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        chat_template_kwargs: { enable_thinking: enableThinking },
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`local qwen direct bridge failed: HTTP ${res.status}${body ? ` ${body.slice(0, 240)}` : ""}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let streamDone = false;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        newlineIdx = buffer.indexOf("\n");
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          streamDone = true;
          break;
        }
        let payload: LocalQwen35StreamPayload | null = null;
        try {
          payload = JSON.parse(data) as LocalQwen35StreamPayload;
        } catch {
          continue;
        }
        if (payload?.usage) {
          usage = payload.usage;
          onUsage?.(usage);
        }
        const delta = payload?.choices?.[0]?.delta || {};
        const reasoningDelta = delta.reasoning_content || delta.reasoning || delta.thinking || "";
        if (reasoningDelta) {
          notifyFirstDelta();
          reasoningText += reasoningDelta;
          await onReasoningDelta?.(reasoningDelta);
        }
        const contentDelta = delta.content || "";
        if (contentDelta) {
          notifyFirstDelta();
          assistantText += contentDelta;
          await onContentDelta?.(contentDelta);
          if (shouldStopEarly?.({ assistantText, reasoningText, usage })) {
            streamDone = true;
            break;
          }
        }
      }
      if (streamDone) {
        try { await res.body.cancel?.(); } catch { /* body may already be closed */ }
        break;
      }
    }
  } catch (err) {
    if (!(abortedByTimeout && assistantText.trim())) {
      throw err;
    }
    timedOutAfterVisibleOutput = true;
  } finally {
    clearTimeout(timeout);
  }

  return {
    assistantText,
    reasoningText,
    usage,
    timedOutAfterVisibleOutput,
  };
}
