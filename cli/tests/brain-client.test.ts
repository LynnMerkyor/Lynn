import { describe, expect, it } from "vitest";
import http from "node:http";
import { BrainConnectionError, chatCompletionsUrl, checkBrainReachable, parseBrainStreamPayload, parseSsePayloads, streamBrainChat } from "../src/brain-client.js";
import { parseArgs } from "../src/args.js";
import { applyReasoningToBody, parseReasoningOptions, shouldRenderReasoning } from "../src/reasoning.js";

describe("brain-client stream parser", () => {
  it("extracts SSE data payloads", () => {
    const payloads = parseSsePayloads([
      "event: message",
      "data: {\"a\":1}",
      "",
      "data: [DONE]",
      "",
    ].join("\n"));

    expect(payloads).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("parses assistant and reasoning deltas", () => {
    const events = parseBrainStreamPayload(JSON.stringify({
      choices: [{
        delta: {
          reasoning_content: "think",
          content: "answer",
        },
      }],
    }));

    expect(events).toEqual([
      { type: "reasoning.delta", text: "think", hidden: true },
      { type: "assistant.delta", text: "answer" },
    ]);
  });

  it("parses Lynn provider, tool progress, and error SSE payloads", () => {
    expect(parseBrainStreamPayload(JSON.stringify({
      object: "lynn.provider",
      meta: {
        active_provider: "mimo",
        fallback_from: [{ id: "spark", reason: "probe-failed" }],
      },
    }))).toEqual([
      { type: "provider", activeProvider: "mimo", fallbackFrom: [{ id: "spark", reason: "probe-failed" }] },
    ]);

    expect(parseBrainStreamPayload(JSON.stringify({
      object: "lynn.tool_progress",
      tool_progress: { event: "end", name: "web_search", ms: 120, ok: true },
    }))).toEqual([
      { type: "tool_progress", event: "end", name: "web_search", ms: 120, ok: true },
    ]);

    expect(parseBrainStreamPayload(JSON.stringify({
      object: "lynn.error",
      error: "tool_storm_limit",
      code: "tool_storm_limit",
    }))).toEqual([
      { type: "brain.error", error: "tool_storm_limit", code: "tool_storm_limit" },
    ]);
  });

  it("requires prompt or messages", async () => {
    await expect(async () => {
      for await (const _event of streamBrainChat({ brainUrl: "http://127.0.0.1:1", reasoning: { effort: "auto", display: "auto" } })) {
        // no-op
      }
    }).rejects.toThrow("requires a prompt or messages");
  });

  it("explains how to recover when Brain is unreachable", async () => {
    await expect(async () => {
      for await (const _event of streamBrainChat({ brainUrl: "http://127.0.0.1:1", prompt: "hello", reasoning: { effort: "auto", display: "auto" } })) {
        // no-op
      }
    }).rejects.toThrow("Start the Lynn client GUI");
  });

  it("uses a typed error for unreachable Brain", async () => {
    await expect(async () => {
      for await (const _event of streamBrainChat({ brainUrl: "http://127.0.0.1:1", prompt: "hello", reasoning: { effort: "auto", display: "auto" } })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(BrainConnectionError);
  });

  it("returns false when the Brain health probe cannot connect", async () => {
    await expect(checkBrainReachable("http://127.0.0.1:1", 50)).resolves.toBe(false);
  });

  it("falls back to a CLI BYOK OpenAI-compatible provider when Brain is offline", async () => {
    const server = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-test");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        expect(JSON.parse(body)).toMatchObject({
          model: "test-model",
          stream: true,
          reasoning_effort: "off",
          extra_body: { enable_thinking: false },
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"hello from byok\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: "http://127.0.0.1:1",
        prompt: "hello",
        reasoning: { effort: "off", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "test-model",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "assistant.delta", text: "hello from byok" });
      expect(events).toContainEqual({ type: "provider", activeProvider: "cli-byok:openai-compatible", fallbackFrom: [{ id: "brain", reason: "offline" }] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out a stalled local Brain quickly when BYOK fallback is available", async () => {
    const stalledBrain = http.createServer((_request, _response) => {
      // Intentionally never respond; the CLI must not hang before trying BYOK.
    });
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"fast fallback\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
    await new Promise<void>((resolve) => stalledBrain.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const oldTimeout = process.env.LYNN_CLI_BRAIN_TIMEOUT_MS;
    process.env.LYNN_CLI_BRAIN_TIMEOUT_MS = "25";
    try {
      const brainAddress = stalledBrain.address();
      const providerAddress = provider.address();
      if (!brainAddress || typeof brainAddress === "string") throw new Error("brain test server failed to listen");
      if (!providerAddress || typeof providerAddress === "string") throw new Error("provider test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: `http://127.0.0.1:${brainAddress.port}`,
        prompt: "hello",
        reasoning: { effort: "auto", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
          model: "test-model",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "assistant.delta", text: "fast fallback" });
    } finally {
      if (oldTimeout === undefined) delete process.env.LYNN_CLI_BRAIN_TIMEOUT_MS;
      else process.env.LYNN_CLI_BRAIN_TIMEOUT_MS = oldTimeout;
      await new Promise<void>((resolve) => stalledBrain.close(() => resolve()));
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });

  it("builds chat completion URLs from base URLs", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1").toString()).toBe("https://api.example.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://api.example.com/v1/chat/completions").toString()).toBe("https://api.example.com/v1/chat/completions");
  });
});

describe("reasoning options", () => {
  it("parses CLI reasoning flags", () => {
    expect(parseReasoningOptions(parseArgs(["exec", "x", "--reasoning", "high", "--show-reasoning", "always"]))).toEqual({
      effort: "high",
      display: "always",
    });
  });

  it("maps off to non-thinking request fields", () => {
    expect(applyReasoningToBody({}, { effort: "off", display: "auto" })).toEqual({
      reasoning_effort: "off",
      extra_body: { enable_thinking: false },
    });
  });

  it("always renders reasoning in JSON mode", () => {
    expect(shouldRenderReasoning("never", true)).toBe(true);
    expect(shouldRenderReasoning("auto", false)).toBe(false);
    expect(shouldRenderReasoning("always", false)).toBe(true);
  });
});
