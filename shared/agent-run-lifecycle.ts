export type AgentRunPhase =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_tool"
  | "compacting"
  | "verifying"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRunTerminalCode =
  | "completed"
  | "completed_with_fallback"
  | "max_steps_reached"
  | "cancelled"
  | "timed_out"
  | "provider_failed"
  | "tool_failed"
  | "verification_failed"
  | "protocol_error";

export type AgentToolRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface AgentToolRunRecord {
  callId: string;
  name: string;
  signature: string | null;
  status: AgentToolRunStatus;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

export interface AgentRunTerminal {
  code: AgentRunTerminalCode;
  ok: boolean;
  resumable: boolean;
  partial: boolean;
  message: string | null;
  endedAt: number;
}

export interface AgentRunSnapshot {
  schemaVersion: 1;
  runId: string;
  scope: string;
  phase: AgentRunPhase;
  revision: number;
  startedAt: number | null;
  updatedAt: number;
  endedAt: number | null;
  terminal: AgentRunTerminal | null;
  tools: Record<string, AgentToolRunRecord>;
}

export interface AgentRunFinishInput {
  code: AgentRunTerminalCode;
  message?: string | null;
  resumable?: boolean;
  partial?: boolean;
}

export interface AgentRunMutationResult {
  accepted: boolean;
  duplicate: boolean;
  snapshot: AgentRunSnapshot;
}

export interface AgentToolRunMutationResult extends AgentRunMutationResult {
  callId: string;
  conflict: boolean;
}

const TERMINAL_PHASES = new Set<AgentRunPhase>(["paused", "completed", "failed", "cancelled"]);

const ALLOWED_TRANSITIONS: Record<AgentRunPhase, ReadonlySet<AgentRunPhase>> = {
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["waiting_approval", "waiting_tool", "compacting", "verifying", "paused", "completed", "failed", "cancelled"]),
  waiting_approval: new Set(["running", "waiting_tool", "paused", "failed", "cancelled"]),
  waiting_tool: new Set(["running", "waiting_approval", "verifying", "paused", "failed", "cancelled"]),
  compacting: new Set(["running", "paused", "failed", "cancelled"]),
  verifying: new Set(["running", "paused", "completed", "failed", "cancelled"]),
  paused: new Set(),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

let fallbackRunCounter = 0;

export function createAgentRunId(scope = "agent", now = Date.now()): string {
  const normalizedScope = scope.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "agent";
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `${normalizedScope}-${randomUuid}`;
  fallbackRunCounter += 1;
  return `${normalizedScope}-${now.toString(36)}-${fallbackRunCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneSnapshot(snapshot: AgentRunSnapshot): AgentRunSnapshot {
  return {
    ...snapshot,
    terminal: snapshot.terminal ? { ...snapshot.terminal } : null,
    tools: Object.fromEntries(Object.entries(snapshot.tools).map(([callId, tool]) => [callId, { ...tool }])),
  };
}

function terminalPhase(code: AgentRunTerminalCode): AgentRunPhase {
  if (code === "completed" || code === "completed_with_fallback") return "completed";
  if (code === "max_steps_reached" || code === "timed_out") return "paused";
  if (code === "cancelled") return "cancelled";
  return "failed";
}

function terminalDefaults(code: AgentRunTerminalCode): Pick<AgentRunTerminal, "ok" | "resumable"> {
  if (code === "completed" || code === "completed_with_fallback") return { ok: true, resumable: false };
  if (code === "max_steps_reached" || code === "timed_out") return { ok: false, resumable: true };
  return { ok: false, resumable: false };
}

function isAbortLike(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error && error.name === "AbortError") return true;
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /\b(?:abort(?:ed)?|cancel(?:led|ed)?)\b/i.test(text);
}

export function classifyAgentRunError(
  error: unknown,
  options: { signal?: AbortSignal; fallbackCode?: AgentRunTerminalCode; partial?: boolean } = {},
): AgentRunFinishInput {
  const message = error instanceof Error ? error.message : String(error || "Agent run failed");
  if (options.signal?.aborted || isAbortLike(error)) {
    return { code: "cancelled", message, partial: options.partial === true, resumable: true };
  }
  return {
    code: options.fallbackCode || "provider_failed",
    message,
    partial: options.partial === true,
  };
}

export class AgentRunLifecycle {
  private state: AgentRunSnapshot;

  constructor(options: { runId?: string; scope?: string; now?: number } = {}) {
    const now = options.now ?? Date.now();
    const scope = options.scope || "agent";
    this.state = {
      schemaVersion: 1,
      runId: options.runId || createAgentRunId(scope, now),
      scope,
      phase: "queued",
      revision: 0,
      startedAt: null,
      updatedAt: now,
      endedAt: null,
      terminal: null,
      tools: {},
    };
  }

  snapshot(): AgentRunSnapshot {
    return cloneSnapshot(this.state);
  }

  start(now = Date.now()): AgentRunMutationResult {
    if (this.state.phase === "running") return this.result(false, true);
    return this.transition("running", now);
  }

  transition(next: AgentRunPhase, now = Date.now()): AgentRunMutationResult {
    if (next === this.state.phase) return this.result(false, true);
    if (this.state.terminal || TERMINAL_PHASES.has(this.state.phase)) return this.result(false, false);
    if (!ALLOWED_TRANSITIONS[this.state.phase].has(next)) return this.result(false, false);
    this.state.phase = next;
    if (next === "running" && this.state.startedAt === null) this.state.startedAt = now;
    this.touch(now);
    return this.result(true, false);
  }

  beginTool(callId: string, name: string, signature: string | null = null, now = Date.now()): AgentToolRunMutationResult {
    const normalizedCallId = callId.trim();
    const normalizedName = name.trim() || "unknown_tool";
    if (!normalizedCallId || this.state.terminal) return this.toolResult(normalizedCallId, false, false, false);
    const existing = this.state.tools[normalizedCallId];
    if (existing) {
      const conflict = existing.name !== normalizedName || (signature !== null && existing.signature !== null && existing.signature !== signature);
      return this.toolResult(normalizedCallId, false, !conflict, conflict);
    }
    if (this.state.phase === "queued") this.start(now);
    this.state.tools[normalizedCallId] = {
      callId: normalizedCallId,
      name: normalizedName,
      signature,
      status: "running",
      startedAt: now,
      endedAt: null,
      error: null,
    };
    if (this.state.phase !== "waiting_tool") this.transition("waiting_tool", now);
    else this.touch(now);
    return this.toolResult(normalizedCallId, true, false, false);
  }

  finishTool(
    callId: string,
    outcome: { ok: boolean; cancelled?: boolean; error?: string | null },
    now = Date.now(),
  ): AgentToolRunMutationResult {
    const normalizedCallId = callId.trim();
    const tool = this.state.tools[normalizedCallId];
    if (!tool || this.state.terminal) return this.toolResult(normalizedCallId, false, false, false);
    if (tool.status !== "running") return this.toolResult(normalizedCallId, false, true, false);
    tool.status = outcome.cancelled ? "cancelled" : outcome.ok ? "succeeded" : "failed";
    tool.endedAt = now;
    tool.error = outcome.error || null;
    this.touch(now);
    const stillRunning = Object.values(this.state.tools).some((entry) => entry.status === "running");
    if (!stillRunning && this.state.phase === "waiting_tool") this.transition("running", now);
    return this.toolResult(normalizedCallId, true, false, false);
  }

  finish(input: AgentRunFinishInput, now = Date.now()): AgentRunMutationResult {
    if (this.state.terminal) return this.result(false, true);
    if (this.state.phase === "queued") this.start(now);
    const defaults = terminalDefaults(input.code);
    const nextPhase = terminalPhase(input.code);
    for (const tool of Object.values(this.state.tools)) {
      if (tool.status !== "running") continue;
      tool.status = input.code === "cancelled" || input.code === "timed_out" ? "cancelled"
        : defaults.ok ? "succeeded" : "failed";
      tool.endedAt = now;
      tool.error = defaults.ok ? null : input.message || "Run ended before the tool completion event";
    }
    this.state.phase = nextPhase;
    this.state.endedAt = now;
    this.state.terminal = {
      code: input.code,
      ok: defaults.ok,
      resumable: input.resumable ?? defaults.resumable,
      partial: input.partial === true,
      message: input.message || null,
      endedAt: now,
    };
    this.touch(now);
    return this.result(true, false);
  }

  private touch(now: number): void {
    this.state.updatedAt = now;
    this.state.revision += 1;
  }

  private result(accepted: boolean, duplicate: boolean): AgentRunMutationResult {
    return { accepted, duplicate, snapshot: this.snapshot() };
  }

  private toolResult(callId: string, accepted: boolean, duplicate: boolean, conflict: boolean): AgentToolRunMutationResult {
    return { callId, accepted, duplicate, conflict, snapshot: this.snapshot() };
  }
}

export function createAgentRunLifecycle(options: { runId?: string; scope?: string; now?: number } = {}): AgentRunLifecycle {
  return new AgentRunLifecycle(options);
}
