export async function streamLocalQwen35Completion({
  endpoint,
  model,
  messages,
  enableThinking,
  maxTokens,
  timeoutMs,
  temperature = 0.2,
  fetchImpl = globalThis.fetch,
  onFirstDelta,
  onReasoningDelta,
  onContentDelta,
  onUsage,
  shouldStopEarly,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("local qwen direct bridge failed: fetch is unavailable");
  }

  const controller = new AbortController();
  let abortedByTimeout = false;
  let timedOutAfterVisibleOutput = false;
  let assistantText = "";
  let reasoningText = "";
  let usage = null;
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
        let payload = null;
        try {
          payload = JSON.parse(data);
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
