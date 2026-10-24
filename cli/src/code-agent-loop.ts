import {
classifyAgentRunError,
createAgentRunLifecycle
} from "../../shared/agent-run-lifecycle.js";
import { runCodeAgentLoopCore } from "./code-agent-loop-core.js";
import type { CodeAgentLoopInput, CodeAgentLoopResult } from "./code-agent-loop-types.js";
import { nowIso, writeJsonLine } from "./jsonl.js";
import { withReadState } from "./tools/read-state.js";
export { planModeBlockedReason } from "./code-agent-loop-support.js";
export type { CodeAgentApprovalDecision, CodeAgentApprovalRequest, CodeAgentEvent, CodeAgentLoopInput, CodeAgentLoopResult, PermissionDenial } from "./code-agent-loop-types.js";
export { compactRuntimeMessages } from "./code-runtime-compaction.js";


export async function runCodeAgentLoop(inputData: CodeAgentLoopInput): Promise<CodeAgentLoopResult> {
  const lifecycle = createAgentRunLifecycle({ scope: "cli" });
  const started = lifecycle.start();
  inputData.onEvent?.({
    type: "run.started",
    runId: started.snapshot.runId,
    phase: "running",
    revision: started.snapshot.revision,
  });
  if (inputData.json) {
    writeJsonLine({
      type: "code.run.started",
      ts: nowIso(),
      runId: started.snapshot.runId,
      phase: "running",
      revision: started.snapshot.revision,
    });
  }
  try {
    const core = await withReadState(() => runCodeAgentLoopCore({ ...inputData, lifecycle }));
    const finished = lifecycle.finish({
      code: core.maxStepsReached ? "max_steps_reached" : "completed",
      partial: core.maxStepsReached && !!core.text.trim(),
    });
    const terminal = finished.snapshot.terminal!;
    inputData.onEvent?.({ type: "run.finished", runId: finished.snapshot.runId, snapshot: finished.snapshot, terminal });
    if (inputData.json) {
      writeJsonLine({
        type: "code.run.finished",
        ts: nowIso(),
        runId: finished.snapshot.runId,
        phase: finished.snapshot.phase,
        code: terminal.code,
        ok: terminal.ok,
        resumable: terminal.resumable,
        partial: terminal.partial,
      });
    }
    return { ...core, runId: finished.snapshot.runId, terminal };
  } catch (error) {
    const finished = lifecycle.finish(classifyAgentRunError(error, {
      signal: inputData.signal,
      partial: false,
    }));
    const terminal = finished.snapshot.terminal!;
    inputData.onEvent?.({ type: "run.finished", runId: finished.snapshot.runId, snapshot: finished.snapshot, terminal });
    if (inputData.json) {
      writeJsonLine({
        type: "code.run.finished",
        ts: nowIso(),
        runId: finished.snapshot.runId,
        phase: finished.snapshot.phase,
        code: terminal.code,
        ok: terminal.ok,
        resumable: terminal.resumable,
        partial: terminal.partial,
        message: terminal.message,
      });
    }
    throw error;
  }
}
