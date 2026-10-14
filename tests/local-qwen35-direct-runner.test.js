import { afterEach, describe, expect, it, vi } from "vitest";
import { streamLocalQwen35Completion } from "../server/chat/local-qwen35-direct-runner.js";

function sseResponse(events) {
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return {
    ok: true,
    body,
    status: 200,
    text: async () => "",
  };
}

describe("local Qwen3.5 direct runner", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["firstChunk", "idle"])("reports %s expiry with a setting hint", async kind => {
    vi.useFakeTimers();
    const pending = streamLocalQwen35Completion({
      timeouts: { firstChunkMs: 100, idleMs: 50, totalMs: 0 },
      fetchImpl: async (_url, opts) => ({
        ok: true, status: 200, text: async () => "",
        body: { async *[Symbol.asyncIterator]() {
          if (kind === "idle") yield new TextEncoder().encode(': heartbeat\n\n');
          await new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }));
        } },
      }),
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "ModelCallTimeoutError", kind, message: expect.stringContaining("模型请求超时") });
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending connection when the user stops, without treating it as a timeout", async () => {
    const controller = new AbortController();
    let requestSignal;
    const pending = streamLocalQwen35Completion({
      signal: controller.signal,
      timeoutMs: 60_000,
      fetchImpl: async (_url, opts) => {
        requestSignal = opts.signal;
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
        });
      },
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(requestSignal.aborted).toBe(true);
  });

  it("streams reasoning, content, and usage from OpenAI-compatible SSE", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      { choices: [{ delta: { reasoning_content: "想一下" } }] },
      { choices: [{ delta: { content: "答案" } }], usage: { total_tokens: 8 } },
    ]));
    const seen = { first: 0, reasoning: "", content: "", usage: null };

    const result = await streamLocalQwen35Completion({
      endpoint: "http://127.0.0.1:18099/v1/chat/completions",
      model: "qwen35-9b-q4km-imatrix",
      messages: [{ role: "user", content: "q" }],
      enableThinking: true,
      maxTokens: 128,
      timeoutMs: 1000,
      fetchImpl,
      onFirstDelta: () => { seen.first += 1; },
      onReasoningDelta: (delta) => { seen.reasoning += delta; },
      onContentDelta: (delta) => { seen.content += delta; },
      onUsage: (usage) => { seen.usage = usage; },
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(result).toMatchObject({ assistantText: "答案", reasoningText: "想一下" });
    expect(result.usage).toEqual({ total_tokens: 8 });
    expect(seen).toEqual({ first: 1, reasoning: "想一下", content: "答案", usage: { total_tokens: 8 } });
  });

  it("reports the timeout instead of claiming partial output is complete", async () => {
    const fetchImpl = vi.fn(async (_url, opts) => {
      const body = {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n');
          await new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
        },
        cancel() {},
      };
      return {
        ok: true,
        body,
        status: 200,
        text: async () => "",
      };
    });

    await expect(streamLocalQwen35Completion({ timeoutMs: 1, fetchImpl }))
      .rejects.toMatchObject({ name: "ModelCallTimeoutError", kind: "total" });
  });
});
