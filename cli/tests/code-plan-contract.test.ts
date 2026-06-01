import { describe, expect, it } from "vitest";
import { checkPlanContract, defaultToolBudget, checkToolBudget } from "../src/code-plan-contract.js";
import type { CodePlanItem } from "../src/plan-tool.js";

function plan(...items: Array<[CodePlanItem["status"], string]>): CodePlanItem[] {
  return items.map(([status, content]) => ({ status, content }));
}

describe("#3 checkPlanContract", () => {
  it("is complete for an empty / null plan (no plan = no contract)", () => {
    expect(checkPlanContract(null).complete).toBe(true);
    expect(checkPlanContract([]).complete).toBe(true);
  });

  it("is complete when every step is completed", () => {
    expect(checkPlanContract(plan(["completed", "a"], ["completed", "b"])).complete).toBe(true);
  });

  it("blocks finishing while steps are pending / in_progress and names them", () => {
    const result = checkPlanContract(plan(["completed", "done one"], ["in_progress", "writing tests"], ["pending", "update docs"]));
    expect(result.complete).toBe(false);
    expect(result.pending).toBe(2);
    expect(result.message).toContain("writing tests");
    expect(result.message).toContain("update docs");
    expect(result.message).toContain("Do not give a final answer");
  });
});

describe("#6 tool budget", () => {
  it("defaults to ≈3 tools/step with a floor of 12, overridable", () => {
    expect(defaultToolBudget(2, {})).toBe(12); // floor
    expect(defaultToolBudget(10, {})).toBe(30);
    expect(defaultToolBudget(10, { LYNN_CLI_TOOL_BUDGET: "5" })).toBe(5);
  });

  it("stays quiet under budget and once already warned", () => {
    expect(checkToolBudget(5, 12, false).overBudget).toBe(false);
    expect(checkToolBudget(99, 12, true).overBudget).toBe(false); // already warned → no repeat
  });

  it("forces a reflection exactly when the budget is reached", () => {
    const verdict = checkToolBudget(12, 12, false);
    expect(verdict.overBudget).toBe(true);
    expect(verdict.message).toContain("Tool budget reached");
    expect(verdict.message).toContain("remain");
  });
});
