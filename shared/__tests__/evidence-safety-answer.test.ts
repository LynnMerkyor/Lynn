import { describe, expect, it } from "vitest";
import {
  buildEvidenceSafetyAnswer,
  collectToolEvidence,
  evidenceToReadableLines,
} from "../evidence-safety-answer.js";

describe("evidence safety answer", () => {
  it("extracts factual tool evidence into a local safety answer", () => {
    const messages = [
      { role: "user", content: "今晚世界杯有几场比赛" },
      {
        role: "tool",
        name: "web_search",
        content: [
          "2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)",
          "2026/06/22 03:00 Belgium vs Iran (Scheduled)",
        ].join("\n"),
      },
    ];

    const evidence = collectToolEvidence(messages);
    expect(evidenceToReadableLines(evidence)).toEqual([
      "2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)",
      "2026/06/22 03:00 Belgium vs Iran (Scheduled)",
    ]);
    expect(buildEvidenceSafetyAnswer(messages)).toContain("我能从工具证据中确认");
  });

  it("does not turn empty tool success shells into evidence", () => {
    const answer = buildEvidenceSafetyAnswer([
      { role: "user", content: "今晚世界杯有几场比赛" },
      { role: "tool", name: "web_search", content: "error.fetch failed\nTool not found: x" },
    ]);
    expect(answer).toBe("");
  });
});
