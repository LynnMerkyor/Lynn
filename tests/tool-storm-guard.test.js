import { describe, expect, it } from "vitest";

import {
  buildToolStormFallbackText,
  isEvidenceTool,
  updateToolStormGuard,
} from "../server/chat/tool-storm-guard.js";

describe("tool storm guard", () => {
  it("stops repeated identical evidence searches without entity keywords", () => {
    const ss = { originalPromptText: "今晚蓝鲸杯有几场比赛" };
    let decision;
    decision = updateToolStormGuard(ss, "web_search", { query: "今晚蓝鲸杯有几场比赛" });
    expect(decision.exceeded).toBe(false);
    decision = updateToolStormGuard(ss, "web-search", { query: "今晚蓝鲸杯有几场比赛" });
    expect(decision.exceeded).toBe(false);
    decision = updateToolStormGuard(ss, "web_search", { query: " 今晚 蓝鲸杯 有几场比赛 " });
    expect(decision.exceeded).toBe(true);
    expect(decision.reason).toBe("repeated_evidence_tool_signature");
  });

  it("stops repeated fetches to the same URL", () => {
    const ss = { originalPromptText: "查一下最新结果" };
    updateToolStormGuard(ss, "web_fetch", { url: "https://example.com/a" });
    updateToolStormGuard(ss, "web_fetch", { url: "https://example.com/a" });
    const decision = updateToolStormGuard(ss, "web_fetch", { url: "https://example.com/a" });
    expect(decision.exceeded).toBe(true);
    expect(decision.signature).toContain("https://example.com/a");
  });

  it("uses a generic evidence total budget for simple realtime turns", () => {
    const ss = { originalPromptText: "今晚有什么比赛" };
    let decision;
    for (let i = 0; i < 8; i += 1) {
      decision = updateToolStormGuard(ss, i % 2 ? "web_search" : "web_fetch", {
        query: `query ${i}`,
        url: `https://example.com/${i}`,
      });
      expect(decision.exceeded).toBe(false);
    }
    decision = updateToolStormGuard(ss, "weather", { location: "深圳" });
    expect(decision.exceeded).toBe(true);
    expect(decision.reason).toBe("evidence_tool_total_budget_exceeded");
  });

  it("allows larger but finite budgets for research-style turns", () => {
    const ss = { originalPromptText: "完整调研中国主要创业社群的人数和收费" };
    let decision;
    for (let i = 0; i < 16; i += 1) {
      decision = updateToolStormGuard(ss, i % 2 ? "web_search" : "web_fetch", {
        query: `research query ${i}`,
        url: `https://example.com/research/${i}`,
      });
      expect(decision.exceeded).toBe(false);
    }
    decision = updateToolStormGuard(ss, "web_search", { query: "research query extra" });
    expect(decision.exceeded).toBe(true);
    expect(decision.reason).toBe("evidence_tool_total_budget_exceeded");
  });

  it("formats a visible fallback with the existing evidence summary", () => {
    const text = buildToolStormFallbackText({
      exceeded: true,
      reason: "repeated_evidence_tool_signature",
      canonicalName: "web_search",
      signature: "web_search:x",
      count: 3,
      limit: 2,
      evidenceTotal: 3,
      total: 3,
    }, "已执行 3 个操作，拿到 2 条来源。");
    expect(text).toContain("工具链已自动停止");
    expect(text).toContain("已执行 3 个操作");
  });

  it("recognizes evidence tools independent of display naming", () => {
    expect(isEvidenceTool("web-search")).toBe(true);
    expect(isEvidenceTool("web_search")).toBe(true);
    expect(isEvidenceTool("bash")).toBe(false);
  });
});
