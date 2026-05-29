import { describe, expect, it } from "vitest";
import { runWorker, parseWorkerBrief, parseWorkerEventLine } from "../src/commands/worker-run.js";
import { parseArgs } from "../src/args.js";

const workerBriefPath = new URL("../fixtures/worker-brief.md", import.meta.url).pathname;

describe("worker-run scaffold", () => {
  it("parses task brief ownership and tests", () => {
    const brief = parseWorkerBrief([
      "# Task: Split input",
      "",
      "## Objective",
      "Make InputArea smaller.",
      "",
      "## Owned files",
      "- desktop/src/react/components/InputArea.tsx",
      "- desktop/src/react/components/input/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm run typecheck",
    ].join("\n"));

    expect(brief.title).toBe("Task: Split input");
    expect(brief.objective).toBe("Make InputArea smaller.");
    expect(brief.owned).toEqual([
      "desktop/src/react/components/InputArea.tsx",
      "desktop/src/react/components/input/**",
    ]);
    expect(brief.forbidden).toEqual(["server/**"]);
    expect(brief.tests).toEqual(["npm run typecheck"]);
  });

  it("parses fleet JSONL event lines", () => {
    const parsed = parseWorkerEventLine(JSON.stringify({
      type: "worker.progress",
      message: "hello",
    }));

    expect(parsed.ok).toBe(true);
    expect(parsed.event?.type).toBe("worker.progress");
  });

  it("wraps external worker output as fleet progress", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        workerBriefPath,
        "--worktree",
        process.cwd(),
        "--agent",
        "custom",
        "--agent-command",
        "node -e \"console.log('external hello')\"",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(lines.some((line) => line.type === "shell.started")).toBe(true);
    expect(lines.some((line) => line.type === "worker.progress" && line.message === "external hello")).toBe(true);
    expect(lines.at(-1)?.type).toBe("worker.finished");
  });
});
