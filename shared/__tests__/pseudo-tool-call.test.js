import { describe, expect, it } from "vitest";

import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
  stripPseudoToolCallMarkup,
} from "../pseudo-tool-call.js";

describe("pseudo tool detection pass-through", () => {
  it("does not classify model text as invalid just because it looks like a tool call", () => {
    expect(containsPseudoToolSimulation('web_search(querys=["今日金价"])')).toBe(false);
    expect(containsPseudoToolSimulation('<tool_call name="web_search">x</tool_call>')).toBe(false);
    expect(containsPseudoToolSimulation("shell: > ls /Users/lynn")).toBe(false);
  });

  it("does not count pseudo-tool-looking text as suppression evidence", () => {
    const raw = [
      '<tool_call name="web_search">x</tool_call>',
      'web_search(querys=["今日金价"])',
      "shell: > ls /Users/lynn",
    ].join("\n");
    expect(countPseudoToolMarkers(raw)).toBe(0);
  });

  it("returns model text unchanged", () => {
    const raw = [
      "先看一下",
      "",
      'web_search(querys=["今日金价"])',
      "",
      "<web_search>\n今日金价\n</web_search>",
      "",
      "再继续总结",
    ].join("\n");
    expect(stripPseudoToolCallMarkup(raw)).toBe(raw);
  });
});
