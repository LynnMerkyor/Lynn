import { describe, expect, it } from "vitest";
import { buildLocalOfficeDirectAnswer } from "../server/chat/local-office-answer.js";

describe("buildLocalOfficeDirectAnswer", () => {
  it("handles regional growth prompts when unit is only declared once at the end", () => {
    const answer = buildLocalOfficeDirectAnswer("【DATA-01】华东 Q1 120 Q2 150；华南 Q1 90 Q2 81；华北 Q1 60 Q2 78（万元）。算环比增长率，给 3 条管理建议。");
    expect(answer).toContain("25%");
    expect(answer).toContain("-10%");
    expect(answer).toContain("30%");
    expect(answer).toContain("管理建议");
  });

  it("builds a stable three-column task priority risk table", () => {
    const answer = buildLocalOfficeDirectAnswer("给我一个三列表格：任务、优先级、风险");
    expect(answer).toContain("| 任务 | 优先级 | 风险 |");
    expect(answer).toContain("| 明确需求范围 | 高 |");
    expect(answer).not.toContain("你想让我");
  });

  it("sorts and deduplicates inline lists deterministically", () => {
    const answer = buildLocalOfficeDirectAnswer("把这个列表排序并去重：banana, apple, banana, pear");
    expect(answer).toBe("apple, banana, pear");
  });

  it("builds a stable zod release manifest schema", () => {
    const answer = buildLocalOfficeDirectAnswer("写一个 zod schema 校验 release manifest");

    expect(answer).toContain("import { z } from 'zod';");
    expect(answer).toContain("z.object({");
    expect(answer).toContain("releaseManifestSchema");
  });

  it("builds a stable Node JSON key-count script", () => {
    const answer = buildLocalOfficeDirectAnswer("写一个 Node.js 脚本读取 JSON 并输出 keys 数量");

    expect(answer).toContain("readFile");
    expect(answer).toContain("Object.keys(data).length");
    expect(answer).toContain("count-json-keys.mjs");
    expect(answer).not.toContain("如果需要更精确的实时结论");
  });

  it("answers Lynn right workbench architecture prompts without pseudo tool setup", () => {
    const answer = buildLocalOfficeDirectAnswer("给 GUI 右侧工作台写一个信息架构草案");

    expect(answer).toContain("右侧工作台信息架构草案");
    expect(answer).toContain("会话血缘");
    expect(answer).not.toContain("find /Users");
    expect(answer).not.toContain("先看一下");
  });

  it("answers shared CLI and GUI kernel regression matrix prompts directly", () => {
    const answer = buildLocalOfficeDirectAnswer("给 CLI 和 GUI 共用内核写一个回归测试矩阵");

    expect(answer).toContain("CLI / GUI 共用内核回归测试矩阵");
    expect(answer).toContain("证据门禁");
    expect(answer).not.toContain("DSML");
    expect(answer).not.toContain("find /Users");
  });
});
