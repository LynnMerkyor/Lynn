import type { CodePlanItem } from "./plan-tool.js";

export interface PlanContractResult {
  complete: boolean;
  pending: number;
  message: string | null;
}

export function checkPlanContract(plan: readonly CodePlanItem[] | null | undefined): PlanContractResult {
  if (!plan || plan.length === 0) return { complete: true, pending: 0, message: null };
  const incomplete = plan.filter((item) => item.status !== "completed");
  if (incomplete.length === 0) return { complete: true, pending: 0, message: null };
  const list = incomplete.map((item) => `  - [${item.status}] ${item.content}`).join("\n");
  return {
    complete: false,
    pending: incomplete.length,
    message: [
      `Plan contract incomplete: ${incomplete.length} plan step(s) are still open:`,
      list,
      "Visible plan state remains open.",
    ].join("\n"),
  };
}

export interface ToolBudgetResult {
  overBudget: boolean;
  message: string | null;
}

export function defaultToolBudget(maxSteps: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number.parseInt(env.LYNN_CLI_TOOL_BUDGET || "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  return Math.max(12, maxSteps * 3);
}

export function checkToolBudget(toolCallCount: number, budget: number, alreadyWarned: boolean): ToolBudgetResult {
  if (alreadyWarned || toolCallCount < budget) return { overBudget: false, message: null };
  return {
    overBudget: true,
    message: [
      `Tool budget reached (${toolCallCount}/${budget} tool calls).`,
      "Current verified state, remaining work, and repeated work should be visible before more tools run.",
    ].join("\n"),
  };
}
