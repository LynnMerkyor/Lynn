import {
  DUAL_BRAIN_ESCAPE_MODEL,
  DUAL_BRAIN_MANAGER_MODEL,
  DUAL_BRAIN_ROUTE,
  DUAL_BRAIN_WORKER_MODEL,
  shouldEscalateToDsV4Flash,
  validateDualBrainAcceptanceReport,
  type DualBrainAcceptanceReport,
  type DualBrainObjectiveEvidence,
} from "../../../shared/dual-brain-route.js";
import {
  FLEET_EVENT_SCHEMA_VERSION,
  type FleetWorkerEvent,
  validateFleetWorkerEvent,
} from "../../../shared/fleet-events.js";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { type BrainStreamEvent, streamBrainChat, streamDirectProviderChat } from "../brain-client.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { type CliProviderProfile } from "../provider-profile.js";
import { resolveProviderPreset } from "../provider-presets.js";
import { parseReasoningOptions } from "../reasoning.js";

export interface ManagerRunResult {
  ok: boolean;
  status: DualBrainAcceptanceReport["status"];
  report: DualBrainAcceptanceReport;
  workerText: string;
  escapeText: string;
}

const MANAGER_ID = "local-a3b-manager";
const WORKER_ID = "step37-worker";
const ESCAPE_ID = "ds-v4-flash-escape";

function emit(event: FleetWorkerEvent, jsonl: boolean): void {
  const enriched = { schemaVersion: FLEET_EVENT_SCHEMA_VERSION, ts: nowIso(), ...event } as FleetWorkerEvent;
  const validation = validateFleetWorkerEvent(enriched);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  if (jsonl) writeJsonLine(enriched);
}

function objectiveFromArgs(args: ParsedArgs): string {
  const subcommand = args.positionals[0] || "run";
  if (subcommand !== "run") throw new Error(`unsupported manager command: ${subcommand}`);
  return getStringFlag(args.flags, "p", "print", "prompt", "task")
    || args.positionals.slice(1).join(" ").trim();
}

export function buildManagerWorkerPrompt(objective: string): string {
  return [
    "You are StepFun 3.7 Flash, the Lynn dual-brain worker.",
    "The local distilled A3B manager has delegated this task to you.",
    "Do the work directly and keep the answer machine-checkable.",
    "Include concrete evidence: files changed, commands/tests run, or a short reason why this is answer-only.",
    "",
    "Objective:",
    objective,
  ].join("\n");
}

function buildEscapePrompt(objective: string, workerText: string, failureSummary: string): string {
  return [
    "You are DS-V4 Flash, Lynn's escape route for hard or failed delegated work.",
    "The StepFun worker output did not pass the manager's objective validation.",
    "Repair or complete the task. Be concise and cite objective evidence.",
    "",
    `Failure summary: ${failureSummary}`,
    "",
    "Original objective:",
    objective,
    "",
    "Worker output:",
    workerText || "(empty)",
  ].join("\n");
}

function providerProfileFromPreset(name: "stepfun" | "deepseek", args: ParsedArgs, prefix: "worker" | "escape"): CliProviderProfile {
  const preset = resolveProviderPreset(name);
  if (!preset) throw new Error(`unknown provider preset: ${name}`);
  const apiKey =
    getStringFlag(args.flags, `${prefix}-api-key`)
    || (name === "stepfun"
      ? process.env.STEPFUN_API_KEY || process.env.STEP_API_KEY
      : process.env.DEEPSEEK_API_KEY)
    || undefined;
  return {
    provider: preset.provider,
    baseUrl: getStringFlag(args.flags, `${prefix}-base-url`) || preset.baseUrl,
    model: getStringFlag(args.flags, `${prefix}-model`) || preset.model,
    apiKey,
  };
}

async function collectAssistantText(stream: AsyncGenerator<BrainStreamEvent>, options: {
  jsonl: boolean;
  workerId: string;
  agent: string;
}): Promise<string> {
  let text = "";
  for await (const event of stream) {
    if (event.type === "assistant.delta") {
      text += event.text;
      emit({ type: "assistant.delta", workerId: options.workerId, agent: options.agent, text: event.text }, options.jsonl);
      continue;
    }
    if (event.type === "reasoning.delta") {
      emit({ type: "reasoning.delta", workerId: options.workerId, agent: options.agent, text: event.text, hidden: true }, options.jsonl);
      continue;
    }
    if (event.type === "brain.error") {
      throw new Error(event.code ? `${event.code}: ${event.error}` : event.error);
    }
  }
  return text;
}

function evidenceFromWorker(workerText: string, args: ParsedArgs): DualBrainObjectiveEvidence[] {
  const evidence: DualBrainObjectiveEvidence[] = [{
    kind: "worker",
    ok: workerText.trim().length > 0,
    summary: workerText.trim() ? "StepFun worker returned visible output" : "StepFun worker returned empty output",
  }];
  const expected = getStringFlag(args.flags, "expect");
  if (expected) {
    evidence.push({
      kind: "harness",
      ok: workerText.includes(expected),
      summary: workerText.includes(expected)
        ? `worker output contains expected marker: ${expected}`
        : `worker output missing expected marker: ${expected}`,
    });
  }
  if (hasFlag(args.flags, "force-fail", "mock-fail")) {
    evidence.push({
      kind: "harness",
      ok: false,
      summary: "forced manager validation failure",
    });
  }
  return evidence;
}

function buildAcceptanceReport(input: {
  taskId: string;
  status: DualBrainAcceptanceReport["status"];
  evidence: DualBrainObjectiveEvidence[];
  escalationReason: string | null;
}): DualBrainAcceptanceReport {
  return {
    taskId: input.taskId,
    managerModel: DUAL_BRAIN_MANAGER_MODEL,
    workerModel: DUAL_BRAIN_WORKER_MODEL,
    escapeModel: DUAL_BRAIN_ESCAPE_MODEL,
    status: input.status,
    objectiveEvidence: input.evidence,
    falseVerifyRisk: input.evidence.some((item) => !item.ok) ? "suspected" : "none",
    escalationReason: input.status === "escalated" ? input.escalationReason || "DS-V4 Flash escape route used" : null,
  };
}

function validationSummary(evidence: readonly DualBrainObjectiveEvidence[]): string {
  const failed = evidence.filter((item) => !item.ok);
  if (!failed.length) return `${evidence.length} objective evidence item(s) passed`;
  return failed.map((item) => item.summary).join("; ");
}

function shouldEscape(evidence: readonly DualBrainObjectiveEvidence[], args: ParsedArgs): boolean {
  if (hasFlag(args.flags, "force-escalate")) return true;
  return shouldEscalateToDsV4Flash({
    harnessFailures: evidence.filter((item) => !item.ok).map((item) => item.summary),
    workerRepairRounds: Number(getStringFlag(args.flags, "worker-repair-rounds") || 0),
    taskClass: getStringFlag(args.flags, "task-class") || "normal",
    managerHasObjectiveEvidence: evidence.length > 0,
    workerOutputMachineCheckable: evidence.some((item) => item.ok),
  });
}

function emitAcceptanceReport(report: DualBrainAcceptanceReport, jsonl: boolean): void {
  emit({
    type: "worker.progress",
    workerId: MANAGER_ID,
    agent: "lynn-cli",
    message: "dual-brain acceptance report",
    data: {
      kind: "dual_brain_acceptance_report",
      report,
    },
  }, jsonl);
}

export async function runManager(args: ParsedArgs): Promise<number> {
  const objective = objectiveFromArgs(args);
  if (!objective) throw new Error("manager run requires -p/--prompt or a positional objective");

  const jsonl = hasFlag(args.flags, "json", "jsonl");
  const mock = hasFlag(args.flags, "mock");
  const taskId = getStringFlag(args.flags, "id") || `manager-${Date.now()}`;
  const reasoning = parseReasoningOptions(args);
  const brainUrl = await resolveDefaultBrainUrl(args);

  emit({
    type: "manager.started",
    taskId,
    workerId: MANAGER_ID,
    managerId: MANAGER_ID,
    route: DUAL_BRAIN_ROUTE.order,
    managerModel: DUAL_BRAIN_MANAGER_MODEL,
  }, jsonl);
  emit({
    type: "manager.delegated",
    taskId,
    managerId: MANAGER_ID,
    workerId: WORKER_ID,
    workerModel: DUAL_BRAIN_WORKER_MODEL,
    objective,
  }, jsonl);
  emit({
    type: "worker.started",
    taskId,
    workerId: WORKER_ID,
    agent: "stepfun-flash",
    cwd: process.cwd(),
    worktree: process.cwd(),
    branch: "manager-delegate",
    pid: process.pid,
  }, jsonl);

  let workerText = "";
  if (mock) {
    workerText = getStringFlag(args.flags, "mock-worker-output") || `mock StepFun worker completed: ${objective}`;
    emit({ type: "assistant.delta", taskId, workerId: WORKER_ID, agent: "stepfun-flash", text: workerText }, jsonl);
  } else {
    const stepfunFallback = providerProfileFromPreset("stepfun", args, "worker");
    workerText = await collectAssistantText(streamBrainChat({
      brainUrl,
      messages: [{ role: "user", content: buildManagerWorkerPrompt(objective) }],
      reasoning,
      fallbackProvider: stepfunFallback,
    }), { jsonl, workerId: WORKER_ID, agent: "stepfun-flash" });
  }

  emit({
    type: "worker.finished",
    taskId,
    workerId: WORKER_ID,
    agent: "stepfun-flash",
    ok: workerText.trim().length > 0,
    exitCode: workerText.trim() ? 0 : 1,
    summary: workerText.trim() ? "StepFun worker completed" : "StepFun worker returned empty output",
  }, jsonl);

  const evidence = evidenceFromWorker(workerText, args);
  const summary = validationSummary(evidence);
  const escape = shouldEscape(evidence, args);
  let status: DualBrainAcceptanceReport["status"] = evidence.every((item) => item.ok) ? "passed" : "failed";
  let escapeText = "";
  let escalationReason: string | null = null;

  emit({
    type: "manager.validation",
    taskId,
    workerId: MANAGER_ID,
    managerId: MANAGER_ID,
    ok: status === "passed",
    summary,
    falseVerifyRisk: status === "passed" ? "none" : "suspected",
    evidenceCount: evidence.length,
  }, jsonl);

  if (escape) {
    escalationReason = summary || "manager escalation rule matched";
    emit({
      type: "manager.delegated",
      taskId,
      managerId: MANAGER_ID,
      workerId: ESCAPE_ID,
      workerModel: DUAL_BRAIN_ESCAPE_MODEL,
      objective,
    }, jsonl);
    emit({
      type: "worker.started",
      taskId,
      workerId: ESCAPE_ID,
      agent: "deepseek",
      cwd: process.cwd(),
      worktree: process.cwd(),
      branch: "manager-escape",
      pid: process.pid,
    }, jsonl);
    if (mock) {
      escapeText = getStringFlag(args.flags, "mock-escape-output") || `mock DS-V4 Flash escape completed: ${objective}`;
      emit({ type: "assistant.delta", taskId, workerId: ESCAPE_ID, agent: "deepseek", text: escapeText }, jsonl);
    } else {
      const deepseek = providerProfileFromPreset("deepseek", args, "escape");
      escapeText = await collectAssistantText(streamDirectProviderChat({
        brainUrl: "direct://deepseek",
        messages: [{ role: "user", content: buildEscapePrompt(objective, workerText, escalationReason) }],
        reasoning,
      }, deepseek), { jsonl, workerId: ESCAPE_ID, agent: "deepseek" });
    }
    emit({
      type: "worker.finished",
      taskId,
      workerId: ESCAPE_ID,
      agent: "deepseek",
      ok: escapeText.trim().length > 0,
      exitCode: escapeText.trim() ? 0 : 1,
      summary: escapeText.trim() ? "DS-V4 Flash escape completed" : "DS-V4 Flash escape returned empty output",
    }, jsonl);
    status = "escalated";
  }

  const report = buildAcceptanceReport({
    taskId,
    status,
    evidence,
    escalationReason,
  });
  const reportValidation = validateDualBrainAcceptanceReport(report);
  if (!reportValidation.ok) throw new Error(reportValidation.errors.join("; "));
  emitAcceptanceReport(report, jsonl);

  const ok = status === "passed" || (status === "escalated" && !!escapeText.trim());
  emit({
    type: "manager.finished",
    taskId,
    workerId: MANAGER_ID,
    managerId: MANAGER_ID,
    ok,
    status,
    summary: status === "passed"
      ? "dual-brain delegated task passed"
      : status === "escalated"
        ? "dual-brain delegated task escalated to DS-V4 Flash"
        : "dual-brain delegated task failed validation",
    escalationReason,
  }, jsonl);

  if (!jsonl) {
    process.stdout.write([
      status === "passed" ? "Dual-brain manager: passed" : status === "escalated" ? "Dual-brain manager: escalated" : "Dual-brain manager: failed",
      `Worker: ${workerText.trim() || "(empty)"}`,
      escapeText.trim() ? `Escape: ${escapeText.trim()}` : "",
    ].filter(Boolean).join("\n") + "\n");
  }

  return ok ? 0 : 2;
}
