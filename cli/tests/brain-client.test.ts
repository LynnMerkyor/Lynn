import { describe, expect, it } from "vitest";
import { parseBrainStreamPayload, parseSsePayloads, streamBrainChat } from "../src/brain-client.js";
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

  it("requires prompt or messages", async () => {
    await expect(async () => {
      for await (const _event of streamBrainChat({ brainUrl: "http://127.0.0.1:1", reasoning: { effort: "auto", display: "auto" } })) {
        // no-op
      }
    }).rejects.toThrow("requires a prompt or messages");
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
