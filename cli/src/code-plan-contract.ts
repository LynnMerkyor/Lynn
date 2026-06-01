import type { CodePlanItem } from "./plan-tool.js";

// ============================================================================
// 计划即契约(#3)+ 目标级工具预算/反思(#6)—— 确定性 loop 守卫,不调用模型。
//
// #3:模型一旦用过 update_plan,就把"计划"当契约。收尾时若还有未完成步骤,不许宣布完成,
//     把未完成项贴回去让它要么做完、要么显式更新计划。防"漏步 / 提前收工"。
// #6:每个目标封顶 N 次工具调用;到顶时强制一次"做了什么 / 还差什么 / 是否在游走"的反思,
//     防止弱模型无限游走。一次性提醒,不刷屏。
// ============================================================================

export interface PlanContractResult {
  complete: boolean;
  pending: number;
  message: string | null;
}

/** #3 At the finish gate: refuse to finish while the model's own plan has open steps. */
export function checkPlanContract(plan: readonly CodePlanItem[] | null | undefined): PlanContractResult {
  if (!plan || plan.length === 0) return { complete: true, pending: 0, message: null };
  const incomplete = plan.filter((item) => item.status !== "completed");
  if (incomplete.length === 0) return { complete: true, pending: 0, message: null };
  const list = incomplete.map((item) => `  - [${item.status}] ${item.content}`).join("\n");
  return {
    complete: false,
    pending: incomplete.length,
    message: [
      `⚠ Plan not complete — ${incomplete.length} of your own plan step(s) are still open:`,
      list,
      "Finish these steps now. If a step is genuinely done or no longer needed, call update_plan to mark it completed (or drop it with a one-line reason). Do not give a final answer with open plan steps.",
    ].join("\n"),
  };
}

export interface ToolBudgetResult {
  overBudget: boolean;
  message: string | null;
}

/** Default per-goal tool-call budget: generous (≈3 tools/step), overridable via env. */
export function defaultToolBudget(maxSteps: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number.parseInt(env.LYNN_CLI_TOOL_BUDGET || "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  return Math.max(12, maxSteps * 3);
}

/** #6 When the tool-call budget is reached, force a one-time progress reflection. */
export function checkToolBudget(toolCallCount: number, budget: number, alreadyWarned: boolean): ToolBudgetResult {
  if (alreadyWarned || toolCallCount < budget) return { overBudget: false, message: null };
  return {
    overBudget: true,
    message: [
      `⚠ Tool budget reached (${toolCallCount}/${budget} tool calls). Stop and reflect before any more tools:`,
      "1. What has actually been accomplished and verified so far (be concrete)?",
      "2. What specific steps still remain to satisfy the ORIGINAL task?",
      "3. Are you repeating work or drifting off-task? If you are close, finish now; otherwise do only the remaining steps.",
    ].join("\n"),
  };
}
