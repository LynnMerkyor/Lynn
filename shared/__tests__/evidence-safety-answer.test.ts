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

  it("does not treat file paths or LaTeX structure snippets as completed analysis evidence", () => {
    const evidence = [
      "根据本轮已执行操作返回的可见结果，当前能确认：",
      "- read: /Users/zaintan/Documents/2026-physics/paper/alphaT3SOC_v2/main.tex",
      "- showpacs,twocolumn,amsmath,amssymb,floatfix,superscriptaddress]{revtex4-2}",
      "- \\includegraphics[width=0.99\\linewid",
    ].join("\n");
    const answer = buildEvidenceSafetyAnswer([
      { role: "user", content: "帮我综述这篇论文，请先阅读 main.tex 后推导关键发现" },
      { role: "tool", name: "read", content: evidence },
    ]);

    expect(evidenceToReadableLines(evidence)).toEqual([]);
    expect(answer).toContain("没有提取到足够可靠的事实");
    expect(answer).not.toContain("showpacs");
    expect(answer).not.toContain("\\includegraphics");
  });

  it("does not treat scheduler jobs as evidence for sports or realtime questions", () => {
    const evidence = [
      "[✓] job_2: 定时工作小结 (cron, 下次: 2026/6/23 10:00:00)",
      "[✓] job_3: 文件自动归纳 (cron, 下次: 2026/6/23 17:00:00)",
      "[✓] job_4: 每周工作周报 (cron, 下次: 2026/6/26 18:00:00)",
      "[✓] job_5: 五点会议提醒 (at, 下次: 2026/6/23 17:00:00)",
    ].join("\n");
    const answer = buildEvidenceSafetyAnswer([
      { role: "user", content: "今晚世界杯有比赛吗？" },
      { role: "tool", name: "cron", content: evidence },
    ]);

    expect(evidenceToReadableLines(evidence)).toEqual([]);
    expect(answer).toContain("没有提取到足够可靠的事实");
    expect(answer).not.toContain("job_2");
    expect(answer).not.toContain("定时工作小结");
  });
});
