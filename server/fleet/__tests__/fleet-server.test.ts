import { describe, expect, it } from "vitest";
import { matchAnyGlob, evaluateScope, annotateChangedFiles } from "../forbidden-guard.js";
import { createLineParser } from "../worker-manager.js";
import { parseWorktreePorcelain } from "../worktree-manager.js";
import { FleetHub, type FleetBrief } from "../fleet-hub.js";

describe("forbidden-guard", () => {
  it("matches ** across segments and * within one", () => {
    expect(matchAnyGlob("server/routes/chat.ts", ["server/**"])).toBe(true);
    expect(matchAnyGlob("brain-v2-mirror/router.ts", ["brain-v2-mirror/**"])).toBe(true);
    expect(matchAnyGlob("core/engine.ts", ["core/engine*.ts"])).toBe(true);
    expect(matchAnyGlob("desktop/src/x.ts", ["server/**"])).toBe(false);
    expect(matchAnyGlob("server.ts", ["server/**"])).toBe(false);
  });

  it("flags forbidden + center-lock from the actual changed paths (not self-report)", () => {
    const v = evaluateScope(
      ["desktop/src/a.tsx", "server/routes/chat.ts"],
      ["server/**"],
      ["server/routes/chat.ts"],
    );
    expect(v.ok).toBe(false);
    expect(v.forbiddenPaths).toContain("server/routes/chat.ts");
    expect(v.centerLockPaths).toContain("server/routes/chat.ts");
  });

  it("annotateChangedFiles sets the forbidden flag for the GUI", () => {
    const out = annotateChangedFiles(
      [{ path: "server/routes/chat.ts" }, { path: "desktop/src/a.tsx" }],
      ["server/**"],
    );
    expect(out[0].forbidden).toBe(true);
    expect(out[1].forbidden).toBeUndefined();
  });
});

describe("worker line parser", () => {
  it("reassembles chunked JSONL, stamps workerId, wraps non-JSON as progress", () => {
    const parse = createLineParser("w1");
    const events = [
      ...parse('{"type":"worker.progress","message":"a"}\n{"type":"tool.started","na'),
      ...parse('me":"read"}\nplain log line\n'),
    ];
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "worker.progress", message: "a", workerId: "w1" });
    expect(events[1]).toMatchObject({ type: "tool.started", name: "read", workerId: "w1" });
    expect(events[2]).toMatchObject({ type: "worker.progress", message: "plain log line", workerId: "w1" });
  });
});

describe("worktree porcelain parser", () => {
  it("parses git worktree list --porcelain output", () => {
    const out =
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt-1\nHEAD def\nbranch refs/heads/cli-1/x\n";
    const list = parseWorktreePorcelain(out);
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({ path: "/repo/wt-1", head: "def", branch: "cli-1/x" });
  });
});

describe("FleetHub.dispatch", () => {
  it("registers a worker and broadcasts started -> claims -> progress as fleet:event", async () => {
    const sent: Array<{ type: string; event: { type: string } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { type: string; event: { type: string } }), () => "T");
    const brief: FleetBrief = {
      title: "split ComposerTextarea",
      agent: "claude-code",
      objective: "extract component",
      owned: ["desktop/src/react/components/input/**"],
      forbidden: ["server/**"],
      branch: "cli-2/inputarea",
      worktree: "worktrees/cli-2",
    };
    const rec = await hub.dispatch(brief);

    expect(rec.workerId).toBe("w1");
    expect(hub.listWorkers()).toHaveLength(1);
    expect(sent.every((m) => m.type === "fleet:event")).toBe(true);
    expect(sent.map((m) => m.event.type)).toEqual(["worker.started", "worker.claims", "worker.progress"]);
  });
});
