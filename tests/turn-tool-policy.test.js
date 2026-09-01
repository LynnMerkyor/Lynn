import { describe, expect, it } from "vitest";

import {
  filterDeliverableToolsForTurn,
  filterToolsForTurn,
  hasExplicitDeliverableIntent,
  hasExplicitImageToolIntent,
  isDeliverableToolName,
  isFileMutationToolName,
  isImageMutationToolName,
  isStructurallyCompletePartialAnswer,
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
    expect(shouldRecoverIncompleteVisibleAnswer(
      "给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威",
      "陈默，34岁，前AI伦理工程师。左眉骨有一道浅疤，是七年前那场实验室事故留下的。他",
      375,
    )).toBe(true);
    expect(shouldRecoverIncompleteVisibleAnswer(
      "给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威",
      "陈默曾是结构工程师，事故后离开研究院。",
      375,
    )).toBe(false);
    expect(shouldRecoverIncompleteVisibleAnswer("2+2 等于几？只给答案", "4", 900)).toBe(false);
    expect(shouldRecoverIncompleteVisibleAnswer("把 hello world 翻译成中文", "你好，世界", 980)).toBe(false);
    expect(shouldRecoverIncompleteVisibleAnswer(
      "劳动合同试用期被突然辞退，我应该先收集什么材料？不要当正式法律意见",
      "",
      470,
    )).toBe(true);
    expect(isStructurallyCompletePartialAnswer("这是一份已经完整写完的搬家清单，包含打包、预约车辆、清点箱数和修改地址。") ).toBe(true);
    expect(isStructurallyCompletePartialAnswer("这是一份还没写完的搬家清")).toBe(false);
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

  it("hides image mutation tools from text-only writing turns", () => {
    const visualTools = [
      { name: "web_search" },
      { name: "generate_image" },
      { name: "flux-studio.generate_image" },
      { name: "flux-studio_edit_image" },
      { name: "view_image" },
    ];
    const biography = "给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威";
    expect(hasExplicitImageToolIntent(biography)).toBe(false);
    expect(filterToolsForTurn(visualTools, {
      allowDeliverables: false,
      allowImageTools: hasExplicitImageToolIntent(biography),
    }).map((tool) => tool.name)).toEqual(["web_search", "view_image"]);
    expect(isImageMutationToolName("flux-studio.generate_image")).toBe(true);
    expect(isImageMutationToolName("flux-studio_edit_image")).toBe(true);
    expect(isImageMutationToolName("view_image")).toBe(false);
  });

  it("opens image tools only for explicit visual creation or editing", () => {
    expect(hasExplicitImageToolIntent("画一张雨夜里的赛博朋克城市插画")).toBe(true);
    expect(hasExplicitImageToolIntent("把这张头图翻译成英文版")).toBe(true);
    expect(hasExplicitImageToolIntent("Create a poster image for the release")).toBe(true);
    expect(hasExplicitImageToolIntent("Write a character biography for a former engineer")).toBe(false);
  });
});
