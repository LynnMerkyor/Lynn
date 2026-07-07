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

  it("disables tools when the user asks for a shell command snippet, not execution", () => {
    const decision = resolveInitialToolUseBehavior("写一个 bash 命令统计当前目录下所有 .ts 文件行数");

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.disableTools).toBe(true);
  });

  it("disables tools for zod release manifest schema snippets", () => {
    const decision = resolveInitialToolUseBehavior("写一个 zod schema 校验 release manifest");

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.disableTools).toBe(true);
  });

  it("does not prefetch public-data context for code snippets with numeric words", () => {
    const decision = resolveInitialToolUseBehavior("写一个 Node.js 脚本读取 JSON 并输出 keys 数量", {
      modelInfo: { isBrain: true },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.disableTools).toBe(true);
    expect(decision.toolName).toBeUndefined();
  });

  it("keeps personal budget calculations local and tool-free", () => {
    const prompt = "我月收入 18000，房租 5200，固定支出 3800，想 8 个月攒 60000，帮我算每月该存多少并给建议";
    const decision = resolveInitialToolUseBehavior(prompt, {
      modelInfo: { isBrain: true },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.disableTools).toBe(true);
    expect(decision.toolName).toBeUndefined();
    expect(decision.effectivePromptText).toContain("每月需要存：7500");
    expect(decision.effectivePromptText).toContain("完成储蓄后每月可支配：1500");
    expect(shouldDisableToolsForTurn(prompt)).toBe(true);
  });

  it("keeps non-realtime medical advice prompts tool-free", () => {
    const prompt = "体检报告里肝功能有几项偏高，我应该带着哪些问题去问医生？不要替医生诊断";
    const decision = resolveInitialToolUseBehavior(prompt, {
      modelInfo: { isBrain: true },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.disableTools).toBe(true);
    expect(decision.toolName).toBeUndefined();
    expect(shouldDisableToolsForTurn(prompt)).toBe(true);
  });

  it("keeps stable legal negotiation and evidence planning prompts tool-free", () => {
    for (const prompt of [
      "租房押金被房东拖着不退，帮我写一个协商和证据整理步骤",
      "劳动合同试用期被突然辞退，我应该先收集什么材料？不要当正式法律意见",
      "快递损坏商家和快递互相推责，帮我整理投诉材料清单和沟通话术",
    ]) {
      const decision = resolveInitialToolUseBehavior(prompt, {
        modelInfo: { isBrain: true },
      });

      expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
      expect(decision.disableTools).toBe(true);
      expect(decision.toolName).toBeUndefined();
      expect(shouldDisableToolsForTurn(prompt)).toBe(true);
    }
  });

  it("keeps current law and policy lookup prompts tool-eligible", () => {
    for (const prompt of [
      "查一下深圳 2026 年社保缴费政策有没有最新变化，给来源和不确定点",
      "个人所得税专项附加扣除最新规则有哪些需要注意？请查来源",
    ]) {
      const decision = resolveInitialToolUseBehavior(prompt, {
        modelInfo: { isBrain: false },
      });

      expect(decision.disableTools).toBe(false);
    }
  });

  it("keeps ordinary planning and drafting prompts tool-free unless a file is requested", () => {
    for (const prompt of [
      "考研复习还剩 120 天，帮我做一个三阶段排期",
      "第一次去杭州三天两晚，帮我安排一个不赶路的行程",
      "为一个 AI Agent 前端工程师写 JD，要求务实不要堆黑话",
      "给客户写一封道歉邮件，说明延期原因并给补救计划",
      "我拿到 offer 但薪资低于预期，帮我写一段谈判话术",
    ]) {
      const decision = resolveInitialToolUseBehavior(prompt, {
        modelInfo: { isBrain: true },
      });

      expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
      expect(decision.disableTools).toBe(true);
      expect(decision.toolName).toBeUndefined();
      expect(shouldDisableToolsForTurn(prompt)).toBe(true);
    }
  });

  it("keeps operational optimization prompts tool-free", () => {
    const prompt = "医院门诊排队太长，如何从分诊、预约、叫号三个环节优化？";
    const decision = resolveInitialToolUseBehavior(prompt, {
      modelInfo: { isBrain: true },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
    expect(decision.disableTools).toBe(true);
    expect(decision.toolName).toBeUndefined();
    expect(shouldDisableToolsForTurn(prompt)).toBe(true);
  });

  it("keeps tools available when the user explicitly asks to save a plan file", () => {
    const prompt = "考研复习还剩 120 天，帮我做一个三阶段排期并保存成 markdown 文件到桌面";
    const decision = resolveInitialToolUseBehavior(prompt, {
      modelInfo: { isBrain: true },
    });

    expect(decision.disableTools).toBe(false);
  });

  it("disables tools for conceptual product and workflow reasoning prompts", () => {
    for (const prompt of [
      "如果复核模型和主模型结论冲突，产品上怎么展示比较好？",
      "设计一个 5 步门禁测试流程验证聊天工具链",
      "给一个 UI 输入框在窄屏不溢出的设计检查清单",
      "给 Session Map 的 Huge 节点写 3 个短状态文案",
      "右侧工作台显示当前会话 digest 时应该避免什么？",
      "给 GUI 右侧工作台写一个信息架构草案",
      "给 CLI 和 GUI 共用内核写一个回归测试矩阵",
      "给我 3 条 git commit message 规范",
      "给出三条提交信息规则",
    ]) {
      const decision = resolveInitialToolUseBehavior(prompt);
      expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN);
      expect(decision.disableTools).toBe(true);
    }
  });

  it("keeps explicit realtime lookup prompts tool-eligible", () => {
    const decision = resolveInitialToolUseBehavior("查一下 OpenAI 最近发布了什么新模型，给一句摘要", {
      modelInfo: { isBrain: false },
    });

    expect(decision.behavior).toBe(TOOL_USE_BEHAVIOR.PREFETCH_THEN_RUN_OR_STOP);
    expect(decision.disableTools).toBe(false);
    expect(decision.toolName).toBeTruthy();
  });

  it("wraps no-tool turns with a non-deliverable route constraint", () => {
    const prompt = buildNoToolTurnPrompt("只回复：OK");

    expect(prompt).toContain("不要调用");
    expect(prompt).toContain("不要声称");
    expect(prompt).toContain("搜到/没搜到");
    expect(prompt).toContain("不要读取或写入文件");
    expect(prompt).toContain("必须严格遵守");
    expect(prompt).not.toContain("只回复：OK");
  });

  it("builds a single augmented prompt after prefetch", () => {
    const prompt = buildPrefetchAugmentedPrompt("原始问题", "证据\n", "预算上下文");
    expect(prompt).toBe("证据\n\n预算上下文\n\n原始问题");
  });
});
