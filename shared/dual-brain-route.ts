export const DUAL_BRAIN_ROUTE_VERSION = "v0.82.0";

export const DUAL_BRAIN_MANAGER_MODEL = "local-a3b-distill";
export const DUAL_BRAIN_WORKER_MODEL = "step-3.7-flash";
export const DUAL_BRAIN_ESCAPE_MODEL = "ds-v4-flash";
export const DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY = 1;

export type DualBrainRouteRole = "manager" | "worker" | "escape";

export interface DualBrainRouteNode {
  role: DualBrainRouteRole;
  id: string;
  displayName: string;
  providerPreset?: string;
  apiModel?: string;
  baselineTps?: number;
  local: boolean;
}

export const DUAL_BRAIN_ROUTE = Object.freeze({
  version: DUAL_BRAIN_ROUTE_VERSION,
  order: Object.freeze([
    "local-a3b-manager",
    "step-3.7-flash-worker",
    "ds-v4-flash-escape",
  ]),
  manager: Object.freeze({
    role: "manager",
    id: "local-a3b-manager",
    displayName: "Spark Qwen3.6-35B-A3B Distill",
    apiModel: DUAL_BRAIN_MANAGER_MODEL,
    baselineTps: 77,
    local: true,
  } satisfies DualBrainRouteNode),
  worker: Object.freeze({
    role: "worker",
    id: "step-3.7-flash-worker",
    displayName: "StepFun 3.7 Flash",
    providerPreset: "stepfun",
    apiModel: DUAL_BRAIN_WORKER_MODEL,
    local: false,
  } satisfies DualBrainRouteNode),
  escape: Object.freeze({
    role: "escape",
    id: "ds-v4-flash-escape",
    displayName: "DS-V4 Flash",
    providerPreset: "deepseek",
    apiModel: "deepseek-chat",
    local: false,
  } satisfies DualBrainRouteNode),
});

export const DUAL_BRAIN_ROUTE_LABEL = "A3B -> step37 -> DS-V4 Flash";
export const DUAL_BRAIN_QOS_LABEL = "GUI priority; local A3B single-slot; busy CLI falls back to StepFun; DS-V4 Flash is escape-only";

export type DualBrainStatus = "passed" | "failed" | "escalated";
export type DualBrainFalseVerifyRisk = "none" | "suspected" | "confirmed";
export type DualBrainEvidenceKind = "test" | "diff" | "command" | "file" | "harness" | "worker" | "other";

export interface DualBrainObjectiveEvidence {
  kind: DualBrainEvidenceKind | string;
  ok: boolean;
  summary: string;
}

export interface DualBrainAcceptanceReport {
  taskId: string;
  managerModel: typeof DUAL_BRAIN_MANAGER_MODEL | string;
  workerModel: typeof DUAL_BRAIN_WORKER_MODEL | string;
  escapeModel: typeof DUAL_BRAIN_ESCAPE_MODEL | string;
  status: DualBrainStatus;
  objectiveEvidence: DualBrainObjectiveEvidence[];
  falseVerifyRisk: DualBrainFalseVerifyRisk;
  escalationReason: string | null;
}

export interface DualBrainValidationResult {
  ok: boolean;
  errors: string[];
}

const STATUS_SET = new Set<DualBrainStatus>(["passed", "failed", "escalated"]);
const RISK_SET = new Set<DualBrainFalseVerifyRisk>(["none", "suspected", "confirmed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(candidate: Record<string, unknown>, field: string, errors: string[]): string {
  const value = candidate[field];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

function requireStringAt(candidate: Record<string, unknown>, field: string, label: string, errors: string[]): string {
  const value = candidate[field];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

export function validateDualBrainAcceptanceReport(report: unknown): DualBrainValidationResult {
  const errors: string[] = [];
  if (!isRecord(report)) return { ok: false, errors: ["acceptance report must be an object"] };

  const taskId = requireString(report, "taskId", errors);
  const managerModel = requireString(report, "managerModel", errors);
  const workerModel = requireString(report, "workerModel", errors);
  const escapeModel = requireString(report, "escapeModel", errors);
  const status = report.status;
  const falseVerifyRisk = report.falseVerifyRisk;

  if (managerModel && managerModel !== DUAL_BRAIN_MANAGER_MODEL) {
    errors.push(`managerModel must be ${DUAL_BRAIN_MANAGER_MODEL}`);
  }
  if (workerModel && workerModel !== DUAL_BRAIN_WORKER_MODEL) {
    errors.push(`workerModel must be ${DUAL_BRAIN_WORKER_MODEL}`);
  }
  if (escapeModel && escapeModel !== DUAL_BRAIN_ESCAPE_MODEL) {
    errors.push(`escapeModel must be ${DUAL_BRAIN_ESCAPE_MODEL}`);
  }
  if (typeof status !== "string" || !STATUS_SET.has(status as DualBrainStatus)) {
    errors.push("status must be passed, failed, or escalated");
  }
  if (typeof falseVerifyRisk !== "string" || !RISK_SET.has(falseVerifyRisk as DualBrainFalseVerifyRisk)) {
    errors.push("falseVerifyRisk must be none, suspected, or confirmed");
  }

  const evidence = report.objectiveEvidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    errors.push("objectiveEvidence must contain at least one item");
  } else {
    evidence.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(`objectiveEvidence[${index}] must be an object`);
        return;
      }
      requireStringAt(item, "kind", `objectiveEvidence[${index}].kind`, errors);
      requireStringAt(item, "summary", `objectiveEvidence[${index}].summary`, errors);
      if (typeof item.ok !== "boolean") errors.push(`objectiveEvidence[${index}].ok must be boolean`);
    });
  }

  const escalationReason = report.escalationReason;
  if (status === "escalated" && (typeof escalationReason !== "string" || !escalationReason.trim())) {
    errors.push("escalated reports require escalationReason");
  }
  if (status !== "escalated" && escalationReason !== null) {
    errors.push("non-escalated reports must set escalationReason to null");
  }
  if (status === "passed" && falseVerifyRisk === "confirmed") {
    errors.push("confirmed false-verify cannot be marked passed");
  }
  if (status === "passed" && Array.isArray(evidence)) {
    const failed = evidence.filter((item) => isRecord(item) && item.ok === false);
    if (failed.length) errors.push("passed reports cannot contain failed objective evidence");
  }
  if (status === "passed" && !taskId) {
    errors.push("passed reports require taskId");
  }

  return { ok: errors.length === 0, errors };
}

export type DualBrainEscalationTaskClass =
  | "concurrency"
  | "permissions"
  | "data_migration"
  | "security"
  | "irreversible_file_ops"
  | "normal";

export interface DualBrainEscalationInput {
  harnessFailures: readonly string[];
  workerRepairRounds: number;
  taskClass: DualBrainEscalationTaskClass | string;
  managerHasObjectiveEvidence: boolean;
  workerOutputMachineCheckable: boolean;
}

const HIGH_RISK_TASK_CLASSES = new Set<string>([
  "concurrency",
  "permissions",
  "data_migration",
  "security",
  "irreversible_file_ops",
]);

export function shouldEscalateToDsV4Flash(input: DualBrainEscalationInput): boolean {
  const distinctFailures = new Set(input.harnessFailures.filter((reason) => reason.trim()));
  return (
    distinctFailures.size >= 2
    || input.workerRepairRounds > 2
    || HIGH_RISK_TASK_CLASSES.has(input.taskClass)
    || !input.managerHasObjectiveEvidence
    || !input.workerOutputMachineCheckable
  );
}

export type DualBrainManagerDecision = "local-a3b-manager" | "step-3.7-flash-worker" | "ds-v4-flash-escape";

export type DualBrainManagerDecisionReason =
  | "local-manager-idle"
  | "local-manager-forced"
  | "local-manager-not-ready"
  | "local-manager-loading"
  | "local-manager-occupied"
  | "local-manager-busy-single-slot"
  | "gui-interactive-priority"
  | "ds-v4-flash-escape-rule";

export interface DualBrainManagerRouteInput {
  localEndpointRunning?: boolean;
  localEndpointLoading?: boolean;
  localEndpointOccupied?: boolean;
  localSlotsBusy?: number | null;
  localSlotsTotal?: number | null;
  guiInteractiveActive?: boolean;
  forceLocalManager?: boolean;
  escalation?: DualBrainEscalationInput | null;
}

export interface DualBrainManagerRouteDecision {
  decision: DualBrainManagerDecision;
  reason: DualBrainManagerDecisionReason;
  localAllowed: boolean;
  localConcurrencyLimit: typeof DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY;
}

export function resolveDualBrainManagerRoute(input: DualBrainManagerRouteInput = {}): DualBrainManagerRouteDecision {
  const busy = Math.max(0, Number(input.localSlotsBusy || 0));
  const running = input.localEndpointRunning === true;
  const loading = input.localEndpointLoading === true;
  const occupied = input.localEndpointOccupied === true;
  const localIdle = running && !loading && !occupied && busy < DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY;

  if (input.forceLocalManager && localIdle) {
    return {
      decision: "local-a3b-manager",
      reason: "local-manager-forced",
      localAllowed: true,
      localConcurrencyLimit: DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
    };
  }
  if (input.escalation && shouldEscalateToDsV4Flash(input.escalation)) {
    return {
      decision: "ds-v4-flash-escape",
      reason: "ds-v4-flash-escape-rule",
      localAllowed: false,
      localConcurrencyLimit: DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
    };
  }
  if (input.guiInteractiveActive) {
    return {
      decision: "step-3.7-flash-worker",
      reason: "gui-interactive-priority",
      localAllowed: false,
      localConcurrencyLimit: DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
    };
  }
  if (!running) {
    return {
      decision: "step-3.7-flash-worker",
      reason: "local-manager-not-ready",
      localAllowed: false,
      localConcurrencyLimit: DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
    };
  }
  if (loading) {
    return {
      decision: "step-3.7-flash-worker",
      reason: "local-manager-loading",
      localAllowed: false,
      localConcurrencyLimit: DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
    };
  }
  if (occupied) {
    return {
      decision: "step-3.7-flash-worker",
      reason: "local-manager-occupied",
      localAllowed: false,
      localConcurrencyLimit: DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
    };
  }
  if (busy >= DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY) {
    return {
      decision: "step-3.7-flash-worker",
      reason: "local-manager-busy-single-slot",
      localAllowed: false,
      localConcurrencyLimit: DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
    };
  }
  return {
    decision: "local-a3b-manager",
    reason: "local-manager-idle",
    localAllowed: true,
    localConcurrencyLimit: DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY,
  };
}

export type DualBrainMtpDecision = "disabled" | "experimental" | "opt_in";

export interface DualBrainMtpGateInput {
  tokenExact: boolean;
  qualityLossPct: number | null;
  wallClockImprovementPct?: number | null;
}

export function decideDualBrainMtpProfile(input: DualBrainMtpGateInput): DualBrainMtpDecision {
  if (input.qualityLossPct == null || input.qualityLossPct > 5) return "disabled";
  if (input.tokenExact && (input.wallClockImprovementPct ?? 0) > 0) return "opt_in";
  if (!input.tokenExact) return "experimental";
  return "disabled";
}
