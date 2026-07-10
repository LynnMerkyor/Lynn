import { describe, expect, it } from "vitest";

import {
  filterDeliverableToolsForTurn,
  hasExplicitDeliverableIntent,
  isDeliverableToolName,
} from "../core/agent-runtime/turn-tool-policy.js";

describe("turn deliverable tool policy", () => {
  const tools = [
    { name: "read" },
    { name: "web_search" },
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
  });

  it("opens deliverable tools for explicit file or rendered-output requests", () => {
    expect(hasExplicitDeliverableIntent("把这份分析导出成 PDF 报告")).toBe(true);
    expect(hasExplicitDeliverableIntent("请做成一个可预览的 HTML 页面")).toBe(true);
    expect(hasExplicitDeliverableIntent("Create a downloadable PPTX report")).toBe(true);
    expect(filterDeliverableToolsForTurn(tools, true)).toEqual(tools);
  });

  it("normalizes hyphenated deliverable aliases", () => {
    expect(isDeliverableToolName("create-report")).toBe(true);
    expect(isDeliverableToolName("present-files")).toBe(true);
    expect(isDeliverableToolName("web-search")).toBe(false);
  });
});
