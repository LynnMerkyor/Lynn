import { describe, expect, it } from "vitest";
import {
  DUAL_BRAIN_ESCAPE_MODEL,
  DUAL_BRAIN_MANAGER_MODEL,
  DUAL_BRAIN_QOS_LABEL,
  DUAL_BRAIN_ROUTE,
  DUAL_BRAIN_ROUTE_LABEL,
  DUAL_BRAIN_WORKER_MODEL,
  decideDualBrainMtpProfile,
  resolveDualBrainManagerRoute,
  shouldEscalateToDsV4Flash,
  validateDualBrainAcceptanceReport,
} from "../dual-brain-route.js";

describe("dual-brain v0.83 route contract", () => {
  it("locks the default topology to manager/executor roles", () => {
    expect(DUAL_BRAIN_ROUTE_LABEL).toBe("A3B/V4 orchestrate · StepFun/V4/GLM execute");
    expect(DUAL_BRAIN_ROUTE.order).toEqual([
      "local-a3b-manager",
      "step-3.7-flash-worker",
      "ds-v4-flash-escape",
    ]);
    expect(DUAL_BRAIN_ROUTE.manager.apiModel).toBe(DUAL_BRAIN_MANAGER_MODEL);
    expect(DUAL_BRAIN_ROUTE.worker.apiModel).toBe(DUAL_BRAIN_WORKER_MODEL);
    expect(DUAL_BRAIN_ROUTE.escape.apiModel).toBe("deepseek-chat");
    expect(DUAL_BRAIN_ROUTE.escape.displayName).toBe("DS-V4 Flash");
    expect(DUAL_BRAIN_QOS_LABEL).toContain("manager brain: A3B + V4 Flash");
    expect(DUAL_BRAIN_QOS_LABEL).toContain("executor brain: StepFun 3.7 Flash + V4 Flash + GLM-5 Turbo");
  });

  it("accepts a task report only when objective evidence supports the status", () => {
    expect(validateDualBrainAcceptanceReport({
      taskId: "task-1",
      managerModel: DUAL_BRAIN_MANAGER_MODEL,
      workerModel: DUAL_BRAIN_WORKER_MODEL,
      escapeModel: DUAL_BRAIN_ESCAPE_MODEL,
      status: "passed",
      objectiveEvidence: [
        { kind: "test", ok: true, summary: "npm test passed" },
        { kind: "diff", ok: true, summary: "changed files remained inside owned scope" },
      ],
      falseVerifyRisk: "none",
      escalationReason: null,
    })).toEqual({ ok: true, errors: [] });
  });

  it("fails closed on false-verify and failed evidence", () => {
    const result = validateDualBrainAcceptanceReport({
      taskId: "task-2",
      managerModel: DUAL_BRAIN_MANAGER_MODEL,
      workerModel: DUAL_BRAIN_WORKER_MODEL,
      escapeModel: DUAL_BRAIN_ESCAPE_MODEL,
      status: "passed",
      objectiveEvidence: [
        { kind: "test", ok: false, summary: "concurrency fixture failed" },
      ],
      falseVerifyRisk: "confirmed",
      escalationReason: null,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("confirmed false-verify cannot be marked passed");
    expect(result.errors.join("\n")).toContain("passed reports cannot contain failed objective evidence");
  });

  it("escalates to DS-V4 Flash only from objective failure rules", () => {
    expect(shouldEscalateToDsV4Flash({
      harnessFailures: ["unit", "integration"],
      workerRepairRounds: 1,
      taskClass: "normal",
      managerHasObjectiveEvidence: true,
      workerOutputMachineCheckable: true,
    })).toBe(true);
    expect(shouldEscalateToDsV4Flash({
      harnessFailures: [],
      workerRepairRounds: 0,
      taskClass: "concurrency",
      managerHasObjectiveEvidence: true,
      workerOutputMachineCheckable: true,
    })).toBe(true);
    expect(shouldEscalateToDsV4Flash({
      harnessFailures: ["unit"],
      workerRepairRounds: 1,
      taskClass: "normal",
      managerHasObjectiveEvidence: true,
      workerOutputMachineCheckable: true,
    })).toBe(false);
  });

  it("keeps MTP optional unless the quality gate is acceptable", () => {
    expect(decideDualBrainMtpProfile({ tokenExact: false, qualityLossPct: 6 })).toBe("disabled");
    expect(decideDualBrainMtpProfile({ tokenExact: false, qualityLossPct: 5 })).toBe("experimental");
    expect(decideDualBrainMtpProfile({ tokenExact: true, qualityLossPct: 0, wallClockImprovementPct: 12 })).toBe("opt_in");
    expect(decideDualBrainMtpProfile({ tokenExact: true, qualityLossPct: 0, wallClockImprovementPct: 0 })).toBe("disabled");
  });

  it("uses the local A3B manager only when the single slot is idle", () => {
    expect(resolveDualBrainManagerRoute({
      localEndpointRunning: true,
      localSlotsBusy: 0,
      localSlotsTotal: 1,
    })).toMatchObject({
      decision: "local-a3b-manager",
      reason: "local-manager-idle",
      localAllowed: true,
      localConcurrencyLimit: 1,
    });

    expect(resolveDualBrainManagerRoute({
      localEndpointRunning: true,
      localSlotsBusy: 1,
      localSlotsTotal: 1,
    })).toMatchObject({
      decision: "step-3.7-flash-worker",
      reason: "local-manager-busy-single-slot",
      localAllowed: false,
    });
  });

  it("protects GUI interactive work by routing CLI/background manager work to StepFun", () => {
    expect(resolveDualBrainManagerRoute({
      localEndpointRunning: true,
      localSlotsBusy: 0,
      localSlotsTotal: 1,
      guiInteractiveActive: true,
    })).toMatchObject({
      decision: "step-3.7-flash-worker",
      reason: "gui-interactive-priority",
    });
  });

  it("uses DS-V4 Flash only as the objective escape lane", () => {
    expect(resolveDualBrainManagerRoute({
      localEndpointRunning: true,
      localSlotsBusy: 0,
      escalation: {
        harnessFailures: ["unit", "integration"],
        workerRepairRounds: 1,
        taskClass: "normal",
        managerHasObjectiveEvidence: true,
        workerOutputMachineCheckable: true,
      },
    })).toMatchObject({
      decision: "ds-v4-flash-escape",
      reason: "ds-v4-flash-escape-rule",
      localAllowed: false,
    });
  });
});
