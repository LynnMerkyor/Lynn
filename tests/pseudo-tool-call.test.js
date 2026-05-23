import { describe, expect, it } from "vitest";
import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
  stripPseudoToolCallMarkup,
} from "../shared/pseudo-tool-call.js";

describe("pseudo tool call pass-through", () => {
  it("does not suppress malformed pseudo tool markup", () => {
    const raw = [
      '<tool_call>glob pattern="*/笺*" path="/Users/lynn/Desktop/Lynn"</arg_value>我先查看一下你的工作空间和笺文件。',
      '<read_file>',
      '<path>/Users/lynn/Desktop/Lynn</path>',
      "</read_file>",
    ].join("\n");

    expect(containsPseudoToolSimulation(raw)).toBe(false);
    expect(countPseudoToolMarkers(raw)).toBe(0);
    expect(stripPseudoToolCallMarkup(raw)).toBe(raw);
  });

  it("keeps bridge leaked markup as model output", () => {
    const raw = '明天深圳天气\n||1read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||2read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||7';
    expect(containsPseudoToolSimulation(raw)).toBe(false);
    expect(stripPseudoToolCallMarkup(raw)).toBe(raw);
  });

  it("still leaves normal markdown untouched", () => {
    const raw = "| 列1 | 列2 |\n|---|---|\n| a | b |\n表格正常显示。";
    expect(containsPseudoToolSimulation(raw)).toBe(false);
    expect(stripPseudoToolCallMarkup(raw)).toBe(raw);
  });
});
