import { describe, expect, it } from "vitest";
import { isMetaTool, isReadOnlyTool, planToolBatches, runToolBatches } from "../src/tool-scheduler.js";
import type { ClientToolName } from "../src/tools/types.js";

const req = (tool: ClientToolName) => ({ tool });

describe("tool scheduler", () => {
  it("classifies read-only and meta tools", () => {
    expect(isReadOnlyTool("read_file")).toBe(true);
    expect(isReadOnlyTool("grep")).toBe(true);
    expect(isReadOnlyTool("glob")).toBe(true);
    expect(isReadOnlyTool("write_file")).toBe(false);
    expect(isReadOnlyTool("bash")).toBe(false);
    expect(isMetaTool("update_plan")).toBe(true);
    expect(isMetaTool("update_working_checkpoint")).toBe(true);
    expect(isMetaTool("bash")).toBe(false);
  });

  it("groups consecutive reads into one parallel batch", () => {
    const batches = planToolBatches([req("read_file"), req("grep"), req("glob")]);
    expect(batches).toEqual([{ mode: "parallel", indexes: [0, 1, 2] }]);
  });

  it("treats a write as a barrier and runs it alone", () => {
    const batches = planToolBatches([req("read_file"), req("read_file"), req("write_file"), req("read_file")]);
    expect(batches).toEqual([
      { mode: "parallel", indexes: [0, 1] },
      { mode: "serial", indexes: [2] },
      { mode: "parallel", indexes: [3] },
    ]);
  });

  it("keeps meta tools serial so plan updates cannot race", () => {
    const batches = planToolBatches([req("update_plan"), req("read_file")]);
    expect(batches).toEqual([
      { mode: "serial", indexes: [0] },
      { mode: "parallel", indexes: [1] },
    ]);
  });

  it("splits a long read run at the concurrency cap", () => {
    const reads = Array.from({ length: 10 }, () => req("read_file"));
    const batches = planToolBatches(reads, { readConcurrency: 6 });
    expect(batches).toEqual([
      { mode: "parallel", indexes: [0, 1, 2, 3, 4, 5] },
      { mode: "parallel", indexes: [6, 7, 8, 9] },
    ]);
  });

  it("runs a parallel batch concurrently and preserves declaration order", async () => {
    const order: number[] = [];
    const results = await runToolBatches(
      [{ mode: "parallel", indexes: [0, 1, 2] }],
      async (index) => {
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 15 : 1));
        order.push(index);
        return `r${index}`;
      },
    );
    expect(results).toEqual(["r0", "r1", "r2"]);
    // index 0 sleeps longest, so completion order differs from declaration order.
    expect(order).toEqual([1, 2, 0]);
  });

  it("runs serial batches in order", async () => {
    const order: number[] = [];
    await runToolBatches(
      [{ mode: "serial", indexes: [0] }, { mode: "serial", indexes: [1] }],
      async (index) => {
        order.push(index);
        return index;
      },
    );
    expect(order).toEqual([0, 1]);
  });
});
