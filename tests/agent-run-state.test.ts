import { describe, expect, it } from "vitest";
import { createAgentRunLifecycle } from "../shared/agent-run-lifecycle.js";
import {
  beginGuiToolRun,
  finishGuiRun,
  finishGuiToolRun,
  guiRunTerminalFields,
  terminalForGuiCloseReason,
} from "../server/chat/agent-run-state.js";

function state() {
  const runLifecycle = createAgentRunLifecycle({ runId: "gui-run", scope: "gui", now: 1 });
  runLifecycle.start(2);
  return { runLifecycle, lifecycleToolCallQueues: new Map<string, string[]>(), hasOutput: false, visibleTextAcc: "" };
}

describe("GUI agent run state bridge", () => {
  it("tracks anonymous same-name tools in FIFO order", () => {
    const ss = state();
    const first = beginGuiToolRun(ss, { name: "web_search", args: { q: "one" } }, 3);
    const second = beginGuiToolRun(ss, { name: "web_search", args: { q: "two" } }, 4);

    expect(first.callId).not.toBe(second.callId);
    expect(finishGuiToolRun(ss, { name: "web_search", ok: true }, 5).callId).toBe(first.callId);
    expect(finishGuiToolRun(ss, { name: "web_search", ok: false, error: "failed" }, 6).callId).toBe(second.callId);
    expect(ss.runLifecycle.snapshot().tools[first.callId].status).toBe("succeeded");
    expect(ss.runLifecycle.snapshot().tools[second.callId].status).toBe("failed");
  });

  it("maps forced close reasons to stable terminal semantics", () => {
    expect(terminalForGuiCloseReason("hard_turn_timeout", { partial: true, forced: true })).toMatchObject({
      code: "timed_out",
      resumable: true,
      partial: true,
    });
    expect(terminalForGuiCloseReason("persisted_final_answer_poll", { forced: true })).toMatchObject({
      code: "completed_with_fallback",
    });
    expect(terminalForGuiCloseReason("model_tool_error", { forced: true })).toMatchObject({
      code: "provider_failed",
      resumable: true,
    });
  });

  it("emits terminal fields from the accepted final state", () => {
    const ss = state();
    const finished = finishGuiRun(ss, { code: "completed_with_fallback", message: "fallback" }, 3);
    expect(guiRunTerminalFields(finished.snapshot, "fallback")).toMatchObject({
      runId: "gui-run",
      runPhase: "completed",
      code: "completed_with_fallback",
      ok: true,
      resumable: false,
      reason: "fallback",
    });
  });
});
