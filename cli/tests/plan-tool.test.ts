import { describe, expect, it } from "vitest";
import { normalizePlanItems, renderPlanItems } from "../src/plan-tool.js";

describe("plan tool", () => {
  it("normalizes TodoWrite-style items", () => {
    expect(normalizePlanItems({
      todos: [
        { content: "探索代码库结构", status: "in_progress", id: "S0" },
        { content: "实现测试", status: "pending", id: "C1" },
        { content: "提交结果", status: "done" },
      ],
    })).toEqual([
      { content: "探索代码库结构", status: "in_progress", id: "S0" },
      { content: "实现测试", status: "pending", id: "C1" },
      { content: "提交结果", status: "completed", id: "P3" },
    ]);
  });

  it("renders plan updates for non-Ink terminals and logs", () => {
    expect(renderPlanItems([
      { content: "Explore", status: "completed", id: "S0" },
      { content: "Patch", status: "in_progress", id: "C1" },
      { content: "Verify", status: "pending", id: "C2" },
    ])).toBe([
      "│ ◷ plan",
      "│   ✓ S0: Explore",
      "│   ● C1: Patch",
      "│   ○ C2: Verify",
    ].join("\n"));
  });
});
