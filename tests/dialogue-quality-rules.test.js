import { describe, expect, it } from "vitest";
import { additionalDialogueQualityReason, claimsFreshToolEvidence } from "../scripts/dialogue-quality-rules.mjs";

describe("dialogue quality rules", () => {
  it("only flags explicit live-result claims as tool evidence", () => {
    expect(claimsFreshToolEvidence("根据查询结果，深圳今天有阵雨。")).toBe(true);
    expect(claimsFreshToolEvidence("搜索结果显示该政策已于今天发布。")).toBe(true);
    expect(claimsFreshToolEvidence("上下文可包含检索到的参考资料和当前输入。")).toBe(false);
    expect(claimsFreshToolEvidence("可以检索相关资料后再做判断。")).toBe(false);
  });

  it("does not treat a relevant Claude Code product mention as stale context", () => {
    expect(additionalDialogueQualityReason({
      category: "recruiting",
      prompt: "为 AI Agent 前端工程师写一份务实 JD",
      text: "职责：实现流式对话、工具状态和长会话导航。要求：熟悉 React、TypeScript 与 SSE，候选人用过 Cursor、Claude Code 或其他 Agent 产品，并能举例说明交互取舍。面试按代码质量、工程判断和协作沟通评分。",
      hasToolEvidence: false,
    })).toBe("");
  });
  it("accepts character profile prose for writing profile prompts", () => {
    const reason = additionalDialogueQualityReason({
      category: "writing",
      prompt: "给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威",
      hasToolEvidence: false,
      text: "陈默，三十六岁，前结构工程师，现靠承接零散的民用加固设计维生。七年前的一场实验室事故让他的记忆出现缺口，官方结论越完整，他越本能地怀疑。性格上他克制、敏感，不轻易接受权威解释，但仍保留工程师式的秩序感。他的核心动机是找回事故当天缺失的三小时，同时避免自己再被任何机构定义。",
    });

    expect(reason).toBe("");
  });

  it("rejects thin character profile answers", () => {
    const reason = additionalDialogueQualityReason({
      category: "writing",
      prompt: "给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威",
      hasToolEvidence: false,
      text: "一个前工程师，失忆，不信任权威。",
    });

    expect(reason).toBe("creative-character-profile-too-thin");
  });
});
