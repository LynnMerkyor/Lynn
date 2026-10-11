import { describe, expect, it } from "vitest";
import { captureGuiToolEvent, recordGuiToolLifecycle, rejectGuiToolAuthorization, releaseRegressionMustFail, validateGuiTaskEvidence } from "../scripts/gui-task-quality.mjs";

const evidence = { answer: "顺德大良明晚有降雨可能。", expected: "大良", finished: true, requiredTools: ["weather"], toolEvents: [{ name: "weather", event: "end", ok: true }] };

describe("real GUI task evidence", () => {
  it("blocks nightly release on extended failures instead of reporting exit zero", () => {
    const extended = { failed: ["office"], blockerFailed: [], criticalFailed: [] };
    expect(releaseRegressionMustFail(extended, "nightly")).toBe(true);
    expect(releaseRegressionMustFail(extended, "release")).toBe(false);
    expect(releaseRegressionMustFail({ failed: [], blockerFailed: [], criticalFailed: [] }, "nightly")).toBe(false);
    expect(releaseRegressionMustFail({ failed: ["boot"], blockerFailed: ["boot"], criticalFailed: [] }, "smoke")).toBe(true);
    expect(releaseRegressionMustFail({ failed: ["tool"], blockerFailed: [], criticalFailed: ["tool"] }, "release")).toBe(true);
  });
  it("rejects only the isolated session's requests and records acknowledged denials", async () => {
    const active = { authorizationDecisions: [], errors: [] };
    const requests = [];
    const config = { sessionPath: "gate-session", reject: async (...args) => { requests.push(args); return { ok: true }; } };
    const message = { type: "tool_authorization", sessionPath: "gate-session", confirmId: "confirmation" };
    await rejectGuiToolAuthorization(active, { ...message, sessionPath: "daily-session" }, config);
    await rejectGuiToolAuthorization(active, { ...message, sessionPath: undefined }, config);
    await rejectGuiToolAuthorization(active, message, { ...config, sessionPath: null });
    await rejectGuiToolAuthorization(active, { ...message, type: "text_delta" }, config);
    expect(requests).toEqual([]);
    await Promise.all([rejectGuiToolAuthorization(active, message, config), rejectGuiToolAuthorization(active, message, config)]);
    expect(requests).toEqual([["confirmation", { action: "rejected" }]]);
    expect(active.authorizationDecisions).toEqual([{ confirmId: "confirmation", action: "rejected", status: "resolved" }]);
    expect(active.errors).toEqual([]);
  });
  it("does not send a confirmation request without an id", async () => {
    const active = { authorizationDecisions: [], errors: [] };
    await rejectGuiToolAuthorization(active, { type: "tool_authorization", sessionPath: "gate-session" }, {
      sessionPath: "gate-session", reject: async () => { throw new Error("must not run"); },
    });
    expect(active.authorizationDecisions).toEqual([]);
    expect(active.errors).toEqual(["authorization:missing-confirm-id"]);
  });
  it.each([false, true])("fails visibly when a denial is not acknowledged: transport error=%s", async (transportError) => {
    const active = { authorizationDecisions: [], errors: [] };
    await rejectGuiToolAuthorization(active, { type: "tool_authorization", sessionPath: "gate-session", confirmId: "confirmation" }, {
      sessionPath: "gate-session", reject: async () => { if (transportError) throw new Error("private transport details"); return { ok: false }; },
    });
    expect(active.authorizationDecisions[0].status).toBe("failed");
    expect(active.errors).toEqual(["authorization:rejection-failed"]);
  });
  it.each(["tool_progress", "tool_start", "tool_execution_start"])("tracks current-turn starts and matching ends for %s", (type) => {
    const active = { tools: [], orphanToolEnds: [] };
    recordGuiToolLifecycle(active, { type, event: "start", name: "weather", id: "current" });
    const endType = type === "tool_progress" ? type : type.replace("start", "end");
    recordGuiToolLifecycle(active, { type: endType, event: "end", name: "weather", id: "current", ok: true, success: true });
    expect(active.tools).toHaveLength(1);
    expect(active.tools[0].success).toBe(true);
    expect(active.orphanToolEnds).toEqual([]);
  });
  it("does not count orphan ends, nameless progress or text as a tool invocation", () => {
    const active = { tools: [], orphanToolEnds: [] };
    recordGuiToolLifecycle(active, { type: "tool_progress", event: "end", name: "weather", ok: true });
    recordGuiToolLifecycle(active, { type: "tool_progress", event: "start" });
    recordGuiToolLifecycle(active, { type: "text_delta", name: "weather", delta: "tool_start" });
    expect(active.tools).toEqual([]);
    expect(active.orphanToolEnds).toHaveLength(1);
  });
  it.each([false, undefined])("does not invent tool success from ok=%s", (ok) => {
    const active = { tools: [], orphanToolEnds: [] };
    recordGuiToolLifecycle(active, { type: "tool_progress", event: "start", name: "weather" });
    recordGuiToolLifecycle(active, { type: "tool_progress", event: "end", name: "weather", ok });
    expect(active.tools[0].success).toBe(false);
  });
  it("does not match a delayed call id or a different transport to a new call", () => {
    const active = { tools: [], orphanToolEnds: [] };
    recordGuiToolLifecycle(active, { type: "tool_progress", event: "start", name: "weather", id: "new" });
    recordGuiToolLifecycle(active, { type: "tool_progress", event: "end", name: "weather", id: "old", ok: true });
    recordGuiToolLifecycle(active, { type: "tool_end", name: "weather", id: "new", success: true });
    expect(active.tools[0].success).toBeNull();
    expect(active.orphanToolEnds).toHaveLength(2);
  });
  it("requires a completed answer and a proven successful tool", () => {
    expect(validateGuiTaskEvidence(evidence)).toBeNull();
    expect(validateGuiTaskEvidence({ ...evidence, finished: false })).toBe("assistant-turn-not-finished");
    expect(validateGuiTaskEvidence({ ...evidence, toolEvents: [] })).toBe("required-tool-not-successful:weather");
    expect(validateGuiTaskEvidence({ ...evidence, toolEvents: [{ name: "weather", event: "end", ok: false }] })).toBe("required-tool-not-successful:weather");
  });
  it("rejects a location mentioned only in fallback scaffolding", () => {
    expect(validateGuiTaskEvidence({ ...evidence, answer: "这轮检索拿到的可核验线索有限，先按可见内容收口：顺德大良" })).toBe("assistant-answer-is-tool-fallback");
    expect(validateGuiTaskEvidence({ ...evidence, answer: "工具当前不可用：weather。顺德大良" })).toBe("assistant-answer-is-tool-fallback");
    expect(validateGuiTaskEvidence({ ...evidence, answer: "搜索提示：顺德大良" })).toBe("assistant-answer-is-tool-fallback");
  });
  it("does not infer success from a tool name or a missing error flag", () => {
    expect(captureGuiToolEvent({ type: "tool_execution_end", toolName: "weather" }).ok).toBe(false);
    expect(captureGuiToolEvent({ type: "tool_progress", name: "weather", event: "end", ok: true }).ok).toBe(true);
    expect(captureGuiToolEvent({ type: "tool_execution_end", toolName: "read", isError: false }).ok).toBe(true);
    expect(captureGuiToolEvent({ type: "text_delta", delta: "weather" })).toBeNull();
  });
  it("keeps the basic no-tool GUI task valid", () => {
    expect(validateGuiTaskEvidence({ answer: "桐门已亮", expected: "桐门已亮", finished: true })).toBeNull();
  });
});
