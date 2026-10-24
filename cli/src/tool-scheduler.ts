/**
 * tool-scheduler.ts — decide how the tool calls of one assistant turn are run.
 *
 * Claude Code's rule, which this mirrors: consecutive read-only calls may run
 * concurrently, a mutating call is a barrier (everything before it must finish,
 * and it runs alone), and results are always reported in the model's original
 * declaration order. The ordering barrier matters: if a read result could appear
 * after a write result, the model reasons about a stale view of the tree.
 */
import type { ClientToolName } from "./tools/types.js";

/** Tools that never touch the filesystem or run a process. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<ClientToolName> = new Set<ClientToolName>([
  "read_file",
  "grep",
  "glob",
  "web_scan",
]);

/** Meta tools mutate only loop state (plan/checkpoint), never the workspace. */
export const META_TOOL_NAMES: ReadonlySet<ClientToolName> = new Set<ClientToolName>([
  "update_plan",
  "update_working_checkpoint",
  "exit_plan_mode",
]);

export interface ScheduledBatch {
  mode: "parallel" | "serial";
  /** Indexes into the original request array. */
  indexes: number[];
}

export interface ToolSchedulerOptions {
  /** Max concurrent read-only calls in one parallel batch. */
  readConcurrency?: number;
}

export function isReadOnlyTool(tool: ClientToolName): boolean {
  return READ_ONLY_TOOL_NAMES.has(tool);
}

export function isMetaTool(tool: ClientToolName): boolean {
  return META_TOOL_NAMES.has(tool);
}

/**
 * Group requests into execution batches.
 *
 * - contiguous read-only calls → one `parallel` batch (split if above the cap)
 * - every other call (write, bash, plan, checkpoint) → its own `serial` batch
 *
 * Meta tools are serial so two plan updates in one turn cannot race on loop state.
 */
export function planToolBatches(
  requests: readonly { tool: ClientToolName }[],
  options: ToolSchedulerOptions = {},
): ScheduledBatch[] {
  const cap = Math.max(1, Math.floor(options.readConcurrency ?? 6));
  const batches: ScheduledBatch[] = [];
  let reads: number[] = [];

  const flushReads = () => {
    while (reads.length) {
      batches.push({ mode: "parallel", indexes: reads.slice(0, cap) });
      reads = reads.slice(cap);
    }
  };

  requests.forEach((request, index) => {
    if (isReadOnlyTool(request.tool)) {
      reads.push(index);
      return;
    }
    flushReads();
    batches.push({ mode: "serial", indexes: [index] });
  });
  flushReads();
  return batches;
}

/**
 * Run batches with a caller-provided executor, preserving input order.
 * A parallel batch settles with `Promise.allSettled` semantics: one failing read
 * must not cancel its siblings (its own executor is expected to return an error
 * result rather than throw).
 */
export async function runToolBatches<T>(
  batches: readonly ScheduledBatch[],
  run: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(batches.reduce((max, batch) => Math.max(max, ...batch.indexes), -1) + 1);
  for (const batch of batches) {
    if (batch.mode === "parallel") {
      const settled = await Promise.allSettled(batch.indexes.map((index) => run(index)));
      settled.forEach((entry, offset) => {
        const index = batch.indexes[offset]!;
        if (entry.status === "fulfilled") {
          results[index] = entry.value;
        } else {
          throw entry.reason;
        }
      });
      continue;
    }
    for (const index of batch.indexes) {
      results[index] = await run(index);
    }
  }
  return results;
}
