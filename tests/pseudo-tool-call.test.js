import { describe, expect, it } from "vitest";
import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
  findUnresolvedPseudoToolOpen,
  isPseudoToolTagOpenAt,
  stripPseudoToolCallMarkup,
} from "../shared/pseudo-tool-call.js";

describe("pseudo tool call suppression", () => {
  it("suppresses malformed pseudo tool markup", () => {
    const raw = [
      '<tool_call>glob pattern="*/笺*" path="/Users/lynn/Desktop/Lynn"</arg_value>我先查看一下你的工作空间和笺文件。',
      '<read_file>',
      '<path>/Users/lynn/Desktop/Lynn</path>',
      "</read_file>",
    ].join("\n");

    expect(containsPseudoToolSimulation(raw)).toBe(true);
    expect(countPseudoToolMarkers(raw)).toBeGreaterThan(0);
    const cleaned = stripPseudoToolCallMarkup(raw);
    expect(cleaned).not.toContain("<tool_call");
    expect(cleaned).not.toContain("<read_file");
    expect(cleaned).not.toContain("/Users/lynn/Desktop/Lynn");
  });

  it("suppresses bridge leaked pipe tool markup while keeping surrounding text", () => {
    const raw = '明天深圳天气\n||1read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||2read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||7';
    expect(containsPseudoToolSimulation(raw)).toBe(true);
    const cleaned = stripPseudoToolCallMarkup(raw);
    expect(cleaned).toContain("明天深圳天气");
    expect(cleaned).not.toContain("||1read||");
    expect(cleaned).not.toContain(".lynn/skills");
  });

  it("still leaves normal markdown untouched", () => {
    const raw = "| 列1 | 列2 |\n|---|---|\n| a | b |\n表格正常显示。";
    expect(containsPseudoToolSimulation(raw)).toBe(false);
    expect(stripPseudoToolCallMarkup(raw)).toBe(raw);
  });
});

describe("streaming prefix helpers", () => {
  it("isPseudoToolTagOpenAt detects registry-matched openers anchored at a <", () => {
    expect(isPseudoToolTagOpenAt("<tool_call>", 0)).toBe(true);
    expect(isPseudoToolTagOpenAt("<tool_call", 0)).toBe(true);
    expect(isPseudoToolTagOpenAt("<Tool_Call>", 0)).toBe(true);
    expect(isPseudoToolTagOpenAt("</tool_call>", 0)).toBe(true);
    expect(isPseudoToolTagOpenAt("<read_file>", 0)).toBe(true);
    expect(isPseudoToolTagOpenAt("<search_result>", 0)).toBe(true);
  });

  it("isPseudoToolTagOpenAt returns false for ordinary markup", () => {
    expect(isPseudoToolTagOpenAt("<details>", 0)).toBe(false);
    expect(isPseudoToolTagOpenAt("<Component prop={x}>", 0)).toBe(false);
    expect(isPseudoToolTagOpenAt("<T>", 0)).toBe(false);
    expect(isPseudoToolTagOpenAt("a < b", 2)).toBe(false);
    expect(isPseudoToolTagOpenAt("<div>", 0)).toBe(false);
  });

  it("findUnresolvedPseudoToolOpen returns -1 when an opener has its matching closer", () => {
    // Lowercase opener + lowercase closer — paired, nothing unresolved.
    expect(findUnresolvedPseudoToolOpen("<tool_call>{}</tool_call> 后")).toBe(-1);
    // Mixed-case opener + lowercase closer — must still pair thanks to readPseudoTagName's
    // lowercasing. Without that fix this would return 0 (opener wrongly treated as unresolved)
    // and the carry buffer would withhold trailing prose forever.
    expect(findUnresolvedPseudoToolOpen("<Tool_Call>{}</tool_call> 后")).toBe(-1);
  });

  it("findUnresolvedPseudoToolOpen returns the opener index when it never closes", () => {
    expect(findUnresolvedPseudoToolOpen("<tool_call>{")).toBe(0);
    // "前文 " is 3 code units (前, 文, space) → "<" sits at index 3.
    expect(findUnresolvedPseudoToolOpen("前文 <tool_call>")).toBe(3);
    expect(findUnresolvedPseudoToolOpen("text <execute>inner")).toBe(5);
  });

  it("findUnresolvedPseudoToolOpen ignores non-registry tags entirely", () => {
    // <details> is not a registry tag, so even though it never closes here it must NOT be
    // reported as unresolved — otherwise legitimate markup would be withheld by the carry buffer.
    expect(findUnresolvedPseudoToolOpen("<details> unclosed on purpose")).toBe(-1);
    expect(findUnresolvedPseudoToolOpen("<Component prop={x}> 未闭合")).toBe(-1);
  });
});
