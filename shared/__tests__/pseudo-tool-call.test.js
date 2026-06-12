import { describe, expect, it } from "vitest";

import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
  stripPseudoToolCallMarkup,
} from "../pseudo-tool-call.js";

describe("pseudo tool detection suppression", () => {
  it("classifies high-confidence pseudo tool markup but leaves shell examples alone", () => {
    expect(containsPseudoToolSimulation('web_search(querys=["今日金价"])')).toBe(true);
    expect(containsPseudoToolSimulation('<tool_call name="web_search">x</tool_call>')).toBe(true);
    expect(containsPseudoToolSimulation("shell: > ls /Users/lynn")).toBe(false);
  });

  it("counts high-confidence pseudo-tool-looking text as suppression evidence", () => {
    const raw = [
      '<tool_call name="web_search">x</tool_call>',
      'web_search(querys=["今日金价"])',
      "shell: > ls /Users/lynn",
    ].join("\n");
    expect(countPseudoToolMarkers(raw)).toBeGreaterThanOrEqual(2);
  });

  it("strips pseudo tool markup but keeps surrounding prose", () => {
    const raw = [
      "先看一下",
      "",
      'web_search(querys=["今日金价"])',
      "",
      "<web_search>\n今日金价\n</web_search>",
      "",
      "再继续总结",
    ].join("\n");
    const cleaned = stripPseudoToolCallMarkup(raw);
    expect(cleaned).toContain("先看一下");
    expect(cleaned).toContain("再继续总结");
    expect(cleaned).not.toContain("web_search");
    expect(cleaned).not.toContain("<web_search>");
  });
});
