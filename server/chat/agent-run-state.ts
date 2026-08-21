import {
  createAgentRunLifecycle,
  type AgentRunFinishInput,
  type AgentRunLifecycle,
  type AgentRunMutationResult,
  type AgentRunSnapshot,
  type AgentToolRunMutationResult,
} from "../../shared/agent-run-lifecycle.js";

export interface AgentRunStateLike {
  runLifecycle?: AgentRunLifecycle;
  lifecycleToolCallQueues?: Map<string, string[]>;
  visibleTextAcc?: string;
  hasOutput?: boolean;
  [key: string]: unknown;
}

let anonymousToolCallCounter = 0;

function ensureLifecycle(ss: AgentRunStateLike): AgentRunLifecycle {
  if (!ss.runLifecycle) {
    ss.runLifecycle = createAgentRunLifecycle({ scope: "gui" });
    ss.runLifecycle.start();
  }
  return ss.runLifecycle;
}

function ensureToolQueues(ss: AgentRunStateLike): Map<string, string[]> {
  if (!ss.lifecycleToolCallQueues) ss.lifecycleToolCallQueues = new Map();
  return ss.lifecycleToolCallQueues;
}

function toolQueueKey(name: unknown): string {
  return String(name || "unknown_tool").trim() || "unknown_tool";
}

function fallbackToolCallId(lifecycle: AgentRunLifecycle, name: string): string {
  anonymousToolCallCounter += 1;
  return `${lifecycle.snapshot().runId}:tool:${name}:${anonymousToolCallCounter}`;
}

function toolSignature(args: unknown): string | null {
  if (args === undefined) return null;
  try { return JSON.stringify(args); } catch { return String(args); }
}

export function beginGuiToolRun(
  ss: AgentRunStateLike,
  input: { toolCallId?: unknown; name?: unknown; args?: unknown },
  now = Date.now(),
): AgentToolRunMutationResult {
  const lifecycle = ensureLifecycle(ss);
  const name = toolQueueKey(input.name);
  const explicitCallId = String(input.toolCallId || "").trim();
  const callId = explicitCallId || fallbackToolCallId(lifecycle, name);
  const result = lifecycle.beginTool(callId, name, toolSignature(input.args), now);
  if (result.accepted && !explicitCallId) {
    const queues = ensureToolQueues(ss);
    const queue = queues.get(name) || [];
    queue.push(callId);
    queues.set(name, queue);
  }
  return result;
}

export function finishGuiToolRun(
  ss: AgentRunStateLike,
  input: { toolCallId?: unknown; name?: unknown; ok: boolean; error?: unknown },
  now = Date.now(),
): AgentToolRunMutationResult {
  const lifecycle = ensureLifecycle(ss);
  const name = toolQueueKey(input.name);
  const explicitCallId = String(input.toolCallId || "").trim();
  let callId = explicitCallId;
  if (!callId) {
    const queues = ensureToolQueues(ss);
    const queue = queues.get(name) || [];
    callId = queue.shift() || "";
    if (queue.length) queues.set(name, queue);
    else queues.delete(name);
  }
  return lifecycle.finishTool(callId, {
    ok: input.ok,
    error: input.error ? String(input.error) : null,
  }, now);
}

export function terminalForGuiCloseReason(
  reason: unknown,
  options: { partial?: boolean; forced?: boolean } = {},
): AgentRunFinishInput {
  const normalized = String(reason || "").toLowerCase();
  const partial = options.partial === true;
  if (/hard_turn_timeout|authorization_timeout|\btimeout\b|timed_out/.test(normalized)) {
    return { code: "timed_out", message: String(reason || "timeout"), partial, resumable: true };
  }
  if (/cancel|interrupt|abort/.test(normalized)) {
    return { code: "cancelled", message: String(reason || "cancelled"), partial, resumable: true };
  }
  if (/model_tool_error|provider/.test(normalized)) {
    return { code: "provider_failed", message: String(reason || "provider failed"), partial, resumable: true };
  }
  if (/tool.*(?:error|fail)|(?:error|fail).*tool/.test(normalized)) {
    return { code: "tool_failed", message: String(reason || "tool failed"), partial, resumable: true };
  }
  if (/error/.test(normalized)) {
    return { code: "provider_failed", message: String(reason || "provider failed"), partial, resumable: true };
  }
  if (options.forced) {
    return { code: "completed_with_fallback", message: String(reason || "fallback"), partial };
  }
  return { code: "completed", partial };
}

export function finishGuiRun(
  ss: AgentRunStateLike,
  input: AgentRunFinishInput,
  now = Date.now(),
): AgentRunMutationResult {
  return ensureLifecycle(ss).finish(input, now);
}

export function guiRunStartFields(ss: AgentRunStateLike): Record<string, unknown> {
  const snapshot = ensureLifecycle(ss).snapshot();
  return {
    runId: snapshot.runId,
    runPhase: snapshot.phase,
    runRevision: snapshot.revision,
  };
}

export function guiRunTerminalFields(snapshot: AgentRunSnapshot, reason?: unknown): Record<string, unknown> {
  const terminal = snapshot.terminal;
  return {
    runId: snapshot.runId,
    runPhase: snapshot.phase,
    runRevision: snapshot.revision,
    ...(terminal ? {
      code: terminal.code,
      ok: terminal.ok,
      resumable: terminal.resumable,
      partial: terminal.partial,
    } : {}),
    ...(reason ? { reason: String(reason) } : {}),
  };
}
