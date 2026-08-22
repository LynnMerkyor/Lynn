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

  it("rejects visible model-only structure tags but ignores fenced examples", () => {
    expect(additionalDialogueQualityReason({
      category: "education",
      prompt: "做一个 90 天学习计划",
      text: '<phase name="Foundation">每天练习</phase>',
      hasToolEvidence: false,
    })).toBe("model-structural-tag-visible");
    expect(additionalDialogueQualityReason({
      category: "code",
      prompt: "写一个 XML 示例",
      text: '```xml\n<phase name="Foundation">每天练习</phase>\n```',
      hasToolEvidence: false,
    })).toBe("");
    expect(additionalDialogueQualityReason({
      category: "writing",
      prompt: "整理一个世界观设定表",
      text: '<worldbuilding_table>\n| 阶层 | 货币 |\n</worldbuilding_table>',
      hasToolEvidence: false,
    })).toBe("model-structural-tag-visible");
  });

  it("requires a sample boundary for A-share anomaly snapshots", () => {
    expect(additionalDialogueQualityReason({
      category: "realtime",
      prompt: "今天 A 股有什么异动？",
      text: "中际旭创上涨 4.29%。",
      hasToolEvidence: true,
    })).toBe("a-share-anomaly-answer-missing-sample-boundary");
    expect(additionalDialogueQualityReason({
      category: "realtime",
      prompt: "今天 A 股有什么异动？",
      text: "当前只覆盖代表性样本，不是全市场异动榜；样本中中际旭创上涨 4.29%。",
      hasToolEvidence: true,
    })).toBe("");
  });

  it("rejects visible internal task narration at the start of an answer", () => {
    expect(additionalDialogueQualityReason({
      category: "gov_legal",
      prompt: "租房押金纠纷怎么处理？",
      text: "用户需要租房押金纠纷的实操步骤，分协商和证据两块。直接给结构化清单，按时间线排列，让用户能照着执行。先保存合同、付款记录和房屋交接照片。",
      hasToolEvidence: false,
    })).toBe("internal-task-narration-visible");
  });

  it("rejects model-only Chinese angle-bracket structure labels", () => {
    expect(additionalDialogueQualityReason({
      category: "writing",
      prompt: "设计一个三幕式小说大纲",
      text: "<大纲>\n## 第一幕\n主角出租了一段记忆。",
      hasToolEvidence: false,
    })).toBe("model-structural-label-visible");
    expect(additionalDialogueQualityReason({
      category: "writing",
      prompt: "设计一个三幕式小说大纲",
      text: "## 第三幕\n主角找回记忆。\n</大纲>",
      hasToolEvidence: false,
    })).toBe("model-structural-label-visible");
  });
});
