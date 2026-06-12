import { describe, expect, it } from "vitest";
import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
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
