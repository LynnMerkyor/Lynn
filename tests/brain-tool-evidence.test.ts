import { describe, expect, it } from "vitest";
import { brainToolEvidenceMessages } from "../shared/brain-tool-evidence.js";

const call = { id: "server-weather", type: "function", function: { name: "weather", arguments: '{"city":"顺德大良","fallback_locations":["顺德"]}' } };

describe("Brain tool evidence handoff", () => {
  it("preserves exact model parameters and full source results as a completed tool pair", () => {
    expect(brainToolEvidenceMessages({ event: "end", name: "weather", toolCall: call, result: "完整预报与来源" })).toEqual([
      { role: "assistant", content: "", reasoning_content: "", tool_calls: [call] },
      { role: "tool", name: "weather", tool_call_id: call.id, content: "完整预报与来源" },
    ]);
  });
  it("does not fabricate proof from a progress summary or mismatched call", () => {
    expect(brainToolEvidenceMessages({ event: "start", name: "weather", toolCall: call, result: "预报" })).toEqual([]);
    expect(brainToolEvidenceMessages({ event: "end", name: "weather", toolCall: call })).toEqual([]);
    expect(brainToolEvidenceMessages({ event: "end", name: "sports_score", toolCall: call, result: "预报" })).toEqual([]);
    expect(brainToolEvidenceMessages({ event: "end", name: "weather", toolCall: { ...call, id: "" }, result: "预报" })).toEqual([]);
  });
  it("keeps actual failed execution results without treating them as successful data", () => {
    expect(brainToolEvidenceMessages({ event: "end", name: "weather", toolCall: call, result: '{"error":"source unavailable"}' })[1].content).toBe('{"error":"source unavailable"}');
  });
});
