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
}

/**
 * Stateful line splitter: feed it raw stdout chunks, get back complete fleet
 * events. Each parsed event is stamped with `workerId` if the worker omitted it;
 * malformed lines become progress events.
 */
export function createLineParser(workerId: string): (chunk: string) => FleetWorkerEvent[] {
  let buf = "";
  return (chunk: string): FleetWorkerEvent[] => {
    buf += chunk;
    const out: FleetWorkerEvent[] = [];
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const trimmed = line.trim();
      if (trimmed) {
        const parsed = parseFleetJsonLine(trimmed);
        if (parsed.ok && parsed.event) {
          out.push(parsed.event.workerId ? parsed.event : { ...parsed.event, workerId });
        } else {
          out.push(makeFleetProgressEvent(trimmed, { workerId }));
        }
      }
      nl = buf.indexOf("\n");
    }
    return out;
  };
}

export function spawnWorker(opts: SpawnWorkerOptions, onEvent: (e: FleetWorkerEvent) => void): WorkerHandle {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parse = createLineParser(opts.workerId);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const e of parse(chunk)) onEvent(e);
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
    onEvent(makeFleetProgressEvent(`worker process exited (${code ?? "?"})`, { workerId: opts.workerId }));
  });

  return {
    workerId: opts.workerId,
    pid: child.pid,
    kill: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
