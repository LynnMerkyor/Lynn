import { describe, expect, it } from "vitest";
import { parseWorkerBrief, parseWorkerEventLine } from "../src/commands/worker-run.js";

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
});
