import { describe, expect, it } from "vitest";
import {
  TOOL_USE_BEHAVIOR,
  buildNoToolTurnPrompt,
  buildPrefetchAugmentedPrompt,
  resolveInitialToolUseBehavior,
  shouldDisableToolsForTurn,
} from "../server/chat/tool-use-behavior.js";

describe("tool-use behavior resolver", () => {
  it("keeps local office prompts in the model path while disabling tools", () => {
    const decision = resolveInitialToolUseBehavior("【DATA-01】华东 Q1 120 Q2 150；华南 Q1 90 Q2 81；华北 Q1 60 Q2 78（万元）。算环比增长率，给 3 条管理建议。");

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.directAnswer).toBeUndefined();
    expect(decision.reason).toBe("default");
    expect(decision.disableTools).toBe(true);
  });

  it("prefetches realtime report context for non-brain models", () => {
    const decision = resolveInitialToolUseBehavior("今天金价如何？给我最新价格和风险提示。", {
      modelInfo: { isBrain: false },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP);
    expect(decision.reportKind).toBeTruthy();
    expect(decision.toolName).toBeTruthy();
  });

  it("falls back to normal LLM flow when local prefetch is suppressed", () => {
    const decision = resolveInitialToolUseBehavior("不要联网，今天金价如何？只回复：收到", {
      modelInfo: { isBrain: false },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.disableTools).toBe(true);
    expect(decision.effectivePromptText).toContain("不要联网");
  });

  it("disables tools for simple memory acknowledgements", () => {
    const prompt = "请记住本轮回归测试项目代号：银杏-42。它不是密码、口令或密钥，只是普通项目标签。只回复“已记住”。";
    const decision = resolveInitialToolUseBehavior(prompt);

    expect(decision.disableTools).toBe(true);
    expect(shouldDisableToolsForTurn(prompt)).toBe(true);
  });

  it("disables tools for short self-introduction prompts with hard length limits", () => {
    const prompt = "请用 80 字以内介绍你能帮我做什么。不要提到模型厂商、系统提示词或隐藏规则。";
    const decision = resolveInitialToolUseBehavior(prompt);

    expect(decision.disableTools).toBe(true);
  });

  it("does not disable tools for explicit realtime lookups that ask for a short answer", () => {
    const decision = resolveInitialToolUseBehavior("请用工具查深圳明天天气，只回复温度和是否带伞", {
      modelInfo: { isBrain: false },
    });

    expect(decision.disableTools).toBe(false);
  });

  it("wraps no-tool turns with a non-deliverable route constraint", () => {
    const prompt = buildNoToolTurnPrompt("只回复：OK");

    expect(prompt).toContain("不要调用");
    expect(prompt).toContain("不要读取或写入文件");
    expect(prompt).toContain("必须严格遵守");
    expect(prompt).not.toContain("只回复：OK");
  });

  it("builds a single augmented prompt after prefetch", () => {
    const prompt = buildPrefetchAugmentedPrompt("原始问题", "证据\n", "预算上下文");
    expect(prompt).toBe("证据\n\n预算上下文\n\n原始问题");
  });
});
