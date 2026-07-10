import { describe, expect, it } from "vitest";

import {
  filterDeliverableToolsForTurn,
  hasExplicitDeliverableIntent,
  isDeliverableToolName,
  isFileMutationToolName,
  shouldRecoverIncompleteVisibleAnswer,
} from "../core/agent-runtime/turn-tool-policy.js";

describe("turn deliverable tool policy", () => {
  const tools = [
    { name: "read" },
    { name: "web_search" },
    { name: "write" },
    { name: "edit" },
    { name: "create_artifact" },
    { name: "create-report" },
    { name: "present_files" },
  ];

  it("keeps ordinary answer formats in chat instead of exposing file tools", () => {
    expect(hasExplicitDeliverableIntent("帮我整理一个赛博朋克小说的世界观设定表")).toBe(false);
    expect(hasExplicitDeliverableIntent("写一个 JSON Schema，并解释字段")).toBe(false);
    expect(filterDeliverableToolsForTurn(tools, false).map((tool) => tool.name)).toEqual([
      "read",
      "web_search",
    ]);
    expect(isFileMutationToolName("write")).toBe(true);
    expect(isFileMutationToolName("edit")).toBe(true);
    expect(shouldRecoverIncompleteVisibleAnswer(
      "给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威",
      "陈默，三十六岁，前结构工程师。左手食指有一道浅疤，斜切入",
      491,
    )).toBe(true);
    expect(shouldRecoverIncompleteVisibleAnswer("2+2 等于几？只给答案", "4", 900)).toBe(false);
  });

  it("opens deliverable tools for explicit file or rendered-output requests", () => {
    expect(hasExplicitDeliverableIntent("把这份分析导出成 PDF 报告")).toBe(true);
    expect(hasExplicitDeliverableIntent("请做成一个可预览的 HTML 页面")).toBe(true);
    expect(hasExplicitDeliverableIntent("Create a downloadable PPTX report")).toBe(true);
    expect(filterDeliverableToolsForTurn(tools, true)).toEqual(tools);
    expect(hasExplicitDeliverableIntent("修改 README.md，补充发布步骤")).toBe(true);
  });

  it("normalizes hyphenated deliverable aliases", () => {
    expect(isDeliverableToolName("create-report")).toBe(true);
    expect(isDeliverableToolName("present-files")).toBe(true);
    expect(isDeliverableToolName("web-search")).toBe(false);
  });
});
