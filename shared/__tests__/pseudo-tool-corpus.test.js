import { describe, expect, it } from "vitest";

import {
  containsPseudoToolSimulation,
  scanPseudoToolMarkers,
  stripPseudoToolCallMarkup,
} from "../pseudo-tool-call.js";

describe("scanPseudoToolMarkers corpus scan", () => {
  it("labels malformed tool-call shapes with pattern names + counts", () => {
    const raw = [
      "先看一下",
      "",
      'web_search(querys=["今日金价"])',
      "",
      "<web_search>",
      "今日金价",
      "</web_search>",
      "",
      "shell: > ls /Users/lynn",
      "",
      "再继续总结",
    ].join("\n");
    const scan = scanPseudoToolMarkers(raw);
    expect(scan.total).toBeGreaterThanOrEqual(3);
    const names = scan.patterns.map((p) => p.name);
    // standalone web_search(...) + <web_search> xml + pseudo shell line should all surface
    expect(names).toContain("standalone_function_call");
    expect(names.some((n) => n === "known_tool_xml_tag" || n === "known_tool_xml_block")).toBe(true);
    expect(names).toContain("pseudo_shell_line");
    for (const p of scan.patterns) expect(p.count).toBeGreaterThan(0);
  });

  it("returns total 0 for clean prose", () => {
    const scan = scanPseudoToolMarkers("今天天气不错，我们去公园散步吧。");
    expect(scan.total).toBe(0);
    expect(scan.patterns).toEqual([]);
  });

  it("handles empty / non-string input", () => {
    expect(scanPseudoToolMarkers("").total).toBe(0);
    expect(scanPseudoToolMarkers(null).total).toBe(0);
    expect(scanPseudoToolMarkers(undefined).total).toBe(0);
  });

  it("scans broad shapes while suppression blocks high-confidence pseudo tools", () => {
    const raw = 'web_search(querys=["今日金价"])\n\n<web_search>金价</web_search>';
    expect(scanPseudoToolMarkers(raw).total).toBeGreaterThan(0);
    expect(containsPseudoToolSimulation(raw)).toBe(true);
    expect(stripPseudoToolCallMarkup(raw)).not.toContain("web_search");
  });
});
