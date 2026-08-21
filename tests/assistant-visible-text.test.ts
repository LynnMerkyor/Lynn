import { describe, expect, it } from "vitest";

import { normalizeFinalAnswerText } from "../core/agent-runtime/session-fallback-helpers.js";
import { stripLeadingInternalTaskNarration } from "../shared/assistant-visible-text.js";

describe("assistant visible text", () => {
  it("removes a leading internal task restatement from the persisted answer", () => {
    const raw = "用户需要租房押金纠纷的实操步骤，分协商和证据两块。直接给结构化清单，按时间线排列，让用户能照着执行。\n\n先保存合同和付款记录。";

    expect(normalizeFinalAnswerText(raw)).toBe("先保存合同和付款记录。");
  });

  it("preserves ordinary advice addressed in third person", () => {
    const raw = "用户需要先保存合同和付款记录。直接给房东发送书面通知。然后保留送达凭证。";

    expect(stripLeadingInternalTaskNarration(raw)).toBe(raw);
    expect(normalizeFinalAnswerText(raw)).toBe(raw);
  });

  it("removes narration-only output so the existing empty-answer fallback can run", () => {
    const raw = "用户需要一份证据清单。直接给结构化步骤，让用户照着执行。";

    expect(normalizeFinalAnswerText(raw)).toBe("");
  });

  it("removes a model-only Chinese outline label from persisted prose", () => {
    expect(normalizeFinalAnswerText("<大纲>\n## 第一幕\n主角出租了一段记忆。")).toBe("## 第一幕\n主角出租了一段记忆。");
    expect(normalizeFinalAnswerText("<STAR 框架：处理线上事故>\n先说明事故影响范围。")).toBe("先说明事故影响范围。");
    expect(normalizeFinalAnswerText("```text\n<大纲>\n```" )).toBe("```text\n<大纲>\n```");
  });
});
