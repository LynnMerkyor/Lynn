/**
 * worker-manager.ts — spawn a worker process and turn its stdout into fleet events.
 *
 * Generic on purpose: it spawns ANY command that emits the fleet JSONL protocol on
 * stdout, so the same pipeline drives `lynn worker run --jsonl` (once the CLI lane
 * merges into integration) and any other adapter. Non-JSONL lines are preserved as
 * progress events — output is never dropped.
 */
import { spawn } from "node:child_process";
import { parseFleetJsonLine, makeFleetProgressEvent, type FleetWorkerEvent } from "../../shared/fleet-events.js";

export interface SpawnWorkerOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  workerId: string;
}

export interface WorkerHandle {
  workerId: string;
  pid: number | undefined;
  kill: () => void;
  cancelled: () => boolean;
}

export interface FleetLineParser {
  (chunk: string): FleetWorkerEvent[];
  flush: () => FleetWorkerEvent[];
}

/**
 * Stateful line splitter: feed it raw stdout chunks, get back complete fleet
 * events. Each parsed event is stamped with `workerId` if the worker omitted it;
 * malformed lines become progress events.
 */
export function createLineParser(workerId: string): FleetLineParser {
  let buf = "";

  function parseLine(line: string): FleetWorkerEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const parsed = parseFleetJsonLine(trimmed);
    if (parsed.ok && parsed.event) {
      return [parsed.event.workerId ? parsed.event : { ...parsed.event, workerId }];
    }
    const mapped = mapKnownCliJsonLine(trimmed, workerId);
    if (Array.isArray(mapped)) return mapped;
    if (mapped) return [mapped];
    return [makeFleetProgressEvent(trimmed, { workerId })];
  }

  const parse = ((chunk: string): FleetWorkerEvent[] => {
    buf += chunk;
    const out: FleetWorkerEvent[] = [];
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      out.push(...parseLine(line));
      nl = buf.indexOf("\n");
    }
    return out;
  }) as FleetLineParser;

  parse.flush = (): FleetWorkerEvent[] => {
    const line = buf;
    buf = "";
    return parseLine(line);
  };

  return parse;
}

export function mapKnownCliJsonLine(line: string, workerId: string): FleetWorkerEvent | FleetWorkerEvent[] | null {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "code.tool.requested") {
    const name = typeof parsed.tool === "string" ? parsed.tool : "tool";
    return {
      type: "tool.started",
      workerId,
      name,
      argsPreview: previewJson(parsed.args),
    };
  }
  if (type === "code.tool.result") {
    const name = typeof parsed.tool === "string" ? parsed.tool : "tool";
    return {
      type: "tool.finished",
      workerId,
      name,
      ok: parsed.ok === true,
      ms: typeof parsed.ms === "number" ? parsed.ms : undefined,
    };
  }
  if (type === "code.plan.updated") {
    const count = Array.isArray(parsed.items) ? parsed.items.length : 0;
    return makeFleetProgressEvent(`plan updated${count ? ` (${count})` : ""}`, {
      workerId,
      data: { kind: "plan", items: parsed.items },
    });
  }
  if (type === "usage") {
    return makeFleetProgressEvent("usage", { workerId, data: normalizeUsageData(parsed) });
  }
  if (type === "session.checkpoint") {
    const lineType = typeof parsed.line === "string" ? parsed.line : "turn";
    return makeFleetProgressEvent(`checkpoint: ${lineType}`, { workerId, data: { path: parsed.path, line: parsed.line } });
  }
  if (type === "session.saved") {
    return makeFleetProgressEvent("session saved", { workerId, data: { path: parsed.path } });
  }
  if (type === "run.finished") {
    return {
      type: "gate.finished",
      workerId,
      ok: parsed.ok !== false,
      summary: "code run finished",
    };
  }
  if (type === "code.task.finished") {
    const ok = parsed.ok !== false;
    const code = typeof parsed.code === "string" ? parsed.code : "";
    const finishedEvent: FleetWorkerEvent = {
      type: "gate.finished",
      workerId,
      ok,
      summary: ok ? "code task finished" : `code task failed${code ? `: ${code}` : ""}`,
    };
    const sessionPath = typeof parsed.sessionPath === "string" && parsed.sessionPath ? parsed.sessionPath : "";
    const resumeCommand = typeof parsed.resumeCommand === "string" && parsed.resumeCommand ? parsed.resumeCommand : "";
    if (!sessionPath && !resumeCommand) return finishedEvent;
    const checkpointEvent = makeFleetProgressEvent("session saved", {
      workerId,
      data: {
        ...(sessionPath ? { path: sessionPath } : {}),
        ...(resumeCommand ? { resumeCommand } : {}),
        ...(code ? { code } : {}),
      },
    });
    return [checkpointEvent, finishedEvent];
  }
  return null;
}

function normalizeUsageData(parsed: Record<string, unknown>): unknown {
  const usage = parsed.usage;
  const durationMs = typeof parsed.durationMs === "number" && Number.isFinite(parsed.durationMs)
    ? parsed.durationMs
    : typeof parsed.duration_ms === "number" && Number.isFinite(parsed.duration_ms)
      ? parsed.duration_ms
      : undefined;
  if (durationMs === undefined) return usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { duration_ms: durationMs };
  return { ...(usage as Record<string, unknown>), duration_ms: durationMs };
}

function previewJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return undefined;
  }
}

export function spawnWorker(opts: SpawnWorkerOptions, onEvent: (e: FleetWorkerEvent) => void): WorkerHandle {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const parse = createLineParser(opts.workerId);
  let sawWorkerTerminalEvent = false;
  let cancelled = false;

  function emitParsedEvent(event: FleetWorkerEvent): void {
    if (event.type === "worker.finished" || event.type === "worker.error") {
      sawWorkerTerminalEvent = true;
    }
    onEvent(event);
  }

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const e of parse(chunk)) emitParsedEvent(e);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    onEvent(makeFleetProgressEvent(String(chunk).replace(/\n+$/, ""), { workerId: opts.workerId, level: "warning" }));
  });
  child.on("error", (err: Error) => {
    onEvent({
      type: "worker.error",
      workerId: opts.workerId,
      code: "spawn_failed",
      message: err.message,
      recoverable: false,
    });
  });
  child.on("close", (code: number | null) => {
    for (const e of parse.flush()) emitParsedEvent(e);
    if (cancelled) {
      onEvent(makeFleetProgressEvent(`worker process cancelled (${code ?? "?"})`, { workerId: opts.workerId }));
      return;
    }
    if (code === 0 && !sawWorkerTerminalEvent) {
      emitParsedEvent({
        type: "worker.finished",
        workerId: opts.workerId,
        ok: true,
        exitCode: 0,
        summary: "worker process exited without final event",
      });
    }
    if (typeof code === "number" && code !== 0 && !sawWorkerTerminalEvent) {
      onEvent({
        type: "worker.error",
        workerId: opts.workerId,
        code: "worker_exit",
        message: `worker process exited with code ${code}`,
        recoverable: true,
      });
    }
    onEvent(makeFleetProgressEvent(`worker process exited (${code ?? "?"})`, { workerId: opts.workerId }));
  });

  return {
    workerId: opts.workerId,
    pid: child.pid,
    kill: () => {
      cancelled = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
    cancelled: () => cancelled,
  };
}
