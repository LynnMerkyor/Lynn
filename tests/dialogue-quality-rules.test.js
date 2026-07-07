import { describe, expect, it } from "vitest";
import { additionalDialogueQualityReason } from "../scripts/dialogue-quality-rules.mjs";

describe("dialogue quality rules", () => {
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
