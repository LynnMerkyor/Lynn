import { describe, expect, it } from "vitest";
import {
  classifyAgentRunError,
  createAgentRunLifecycle,
} from "../shared/agent-run-lifecycle.js";

describe("agent run lifecycle", () => {
  it("accepts one terminal result and rejects duplicate completion", () => {
    const lifecycle = createAgentRunLifecycle({ runId: "run-1", scope: "test", now: 10 });
    expect(lifecycle.start(20).accepted).toBe(true);

    const first = lifecycle.finish({ code: "completed" }, 30);
    const duplicate = lifecycle.finish({ code: "provider_failed", message: "late error" }, 40);

    expect(first.accepted).toBe(true);
    expect(first.snapshot.terminal).toMatchObject({ code: "completed", ok: true, resumable: false });
    expect(duplicate).toMatchObject({ accepted: false, duplicate: true });
    expect(duplicate.snapshot.terminal?.code).toBe("completed");
    expect(duplicate.snapshot.endedAt).toBe(30);
  });

  it("deduplicates tool calls and rejects conflicting reuse of a call id", () => {
    const lifecycle = createAgentRunLifecycle({ runId: "run-tools", now: 1 });
    lifecycle.start(2);

    expect(lifecycle.beginTool("call-1", "read_file", "same", 3)).toMatchObject({ accepted: true });
    expect(lifecycle.beginTool("call-1", "read_file", "same", 4)).toMatchObject({ accepted: false, duplicate: true, conflict: false });
    expect(lifecycle.beginTool("call-1", "bash", "different", 5)).toMatchObject({ accepted: false, duplicate: false, conflict: true });
    expect(lifecycle.finishTool("call-1", { ok: true }, 6)).toMatchObject({ accepted: true });
    expect(lifecycle.finishTool("call-1", { ok: false }, 7)).toMatchObject({ accepted: false, duplicate: true });

    const snapshot = lifecycle.snapshot();
    expect(snapshot.phase).toBe("running");
    expect(snapshot.tools["call-1"]).toMatchObject({ status: "succeeded", endedAt: 6 });
  });

  it("marks step limits and timeouts as resumable partial terminals", () => {
    const maxSteps = createAgentRunLifecycle({ runId: "run-max", now: 1 });
    maxSteps.start(2);
    expect(maxSteps.finish({ code: "max_steps_reached", partial: true }, 3).snapshot).toMatchObject({
      phase: "paused",
      terminal: { code: "max_steps_reached", ok: false, resumable: true, partial: true },
    });

    const timeout = createAgentRunLifecycle({ runId: "run-timeout", now: 1 });
    timeout.start(2);
    expect(timeout.finish({ code: "timed_out", partial: true }, 3).snapshot.terminal).toMatchObject({
      code: "timed_out",
      resumable: true,
    });
  });

  it("allows a terminal event to close an out-of-order running tool", () => {
    const lifecycle = createAgentRunLifecycle({ runId: "run-out-of-order", now: 1 });
    lifecycle.start(2);
    lifecycle.beginTool("call-late", "web_search", null, 3);

    const finished = lifecycle.finish({ code: "completed" }, 4);
    expect(finished).toMatchObject({ accepted: true, snapshot: { phase: "completed" } });
    expect(finished.snapshot.tools["call-late"]).toMatchObject({ status: "succeeded", endedAt: 4 });
    expect(lifecycle.finishTool("call-late", { ok: true }, 5)).toMatchObject({ accepted: false });
  });

  it("classifies aborts separately from provider failures", () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    expect(classifyAgentRunError(new Error("request failed"), { signal: controller.signal })).toMatchObject({
      code: "cancelled",
      resumable: true,
    });
    expect(classifyAgentRunError(new Error("upstream unavailable"))).toMatchObject({
      code: "provider_failed",
    });
  });
});
