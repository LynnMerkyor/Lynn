import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { matchAnyGlob, evaluateScope, annotateChangedFiles } from "../forbidden-guard.js";
import { createLineParser } from "../worker-manager.js";
import type { SpawnWorkerOptions } from "../worker-manager.js";
import { parseWorktreePorcelain, WorktreeManager } from "../worktree-manager.js";
import { FleetHub, type FleetBrief } from "../fleet-hub.js";
import { DEFAULT_FLEET_REGISTRY, withFleetRegistryAvailability } from "../registry.js";

const execFileAsync = promisify(execFile);

async function makeGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-fleet-server-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  return dir;
}

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

  it("renders tracked and untracked file diffs safely", async () => {
    const repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, "tracked.txt"), "old\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
    await fs.writeFile(path.join(repo, "tracked.txt"), "new\n");
    await fs.writeFile(path.join(repo, "new.txt"), "hello\n");
    const manager = new WorktreeManager(repo);

    await expect(manager.fileDiff(repo, "../escape")).rejects.toThrow("escapes worktree");
    expect(await manager.fileDiff(repo, "tracked.txt")).toContain("-old");
    expect(await manager.fileDiff(repo, "new.txt")).toContain("new file mode");
  });
});

describe("fleet registry availability", () => {
  it("marks the bundled Lynn CLI available and missing external CLIs unavailable", () => {
    const agents = withFleetRegistryAvailability(DEFAULT_FLEET_REGISTRY, {
      pathEnv: "/bin",
      fileExists: (file) => file === "/bin/codex",
    });
    expect(agents.find((a) => a.id === "lynn-cli")).toMatchObject({ available: true, availability: "bundled" });
    expect(agents.find((a) => a.id === "codex-cli")).toMatchObject({ available: true, availability: "/bin/codex" });
    expect(agents.find((a) => a.id === "claude-code")).toMatchObject({ available: false, availability: "not found on PATH" });
  });
});

describe("FleetHub.dispatch", () => {
  it("registers a worker and broadcasts started -> claims -> progress as fleet:event", async () => {
    const sent: Array<{ type: string; event: { type: string } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { type: string; event: { type: string } }), () => "T", { mode: "stub" });
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

  it("spawns Lynn worker run in integration mode", async () => {
    const sent: Array<{ type: string; event: { type: string } }> = [];
    const spawned: SpawnWorkerOptions[] = [];
    const hub = new FleetHub(
      "/repo",
      (m) => sent.push(m as { type: string; event: { type: string } }),
      () => "T",
      {
        createWorktree: false,
        runnerCommand: "/node",
        runnerArgsPrefix: ["/cli/lynn.mjs"],
        runnerEnv: { ELECTRON_RUN_AS_NODE: "1" },
        spawnWorker: (opts, onEvent) => {
          spawned.push(opts);
          queueMicrotask(() => {
            onEvent({ type: "worker.started", workerId: opts.workerId, cwd: "/repo", worktree: "worktrees/fleet-test", branch: "fleet/test" });
            onEvent({ type: "worker.claims", workerId: opts.workerId, owned: ["cli/**"], forbidden: ["server/**"] });
            onEvent({ type: "worker.finished", workerId: opts.workerId, ok: true, exitCode: 0, summary: "done" });
          });
          return { workerId: opts.workerId, pid: 123, kill: () => undefined };
        },
      },
    );
    const brief: FleetBrief = {
      title: "real spawn",
      agent: "lynn-cli",
      objective: "run a real worker adapter",
      owned: ["cli/**"],
      forbidden: ["server/**"],
      branch: "fleet/test",
      worktree: "worktrees/fleet-test",
    };

    const rec = await hub.dispatch(brief);
    const deadline = Date.now() + 1000;
    while (spawned.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(spawned).toHaveLength(1);
    const call = spawned[0]!;
    expect(call.command).toBe("/node");
    expect(call.args.slice(0, 3)).toEqual(["/cli/lynn.mjs", "worker", "run"]);
    expect(call.args).toContain("--id");
    expect(call.args).toContain(rec.workerId);
    expect(call.env?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(hub.getWorker(rec.workerId)?.status).toBe("completed");
    expect(hub.getWorker(rec.workerId)?.events.filter((e) => e.type === "worker.started")).toHaveLength(1);
    expect(hub.getWorker(rec.workerId)?.events.filter((e) => e.type === "worker.claims")).toHaveLength(1);
    expect(sent.some((m) => m.event.type === "worker.finished")).toBe(true);
  });
});

const sampleBrief: FleetBrief = {
  title: "t",
  agent: "codex-cli",
  objective: "o",
  owned: ["a/**"],
  forbidden: ["server/**"],
  branch: "cli-1/x",
  worktree: "worktrees/cli-1",
};

describe("FleetHub.retry", () => {
  it("re-dispatches a brief as a fresh worker", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    const first = await hub.dispatch(sampleBrief);
    const again = await hub.retry(first.workerId);
    expect(again).not.toBeNull();
    expect(again && again.workerId).not.toBe(first.workerId);
    expect(hub.listWorkers()).toHaveLength(2);
  });

  it("returns null for an unknown worker", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    expect(await hub.retry("nope")).toBeNull();
  });
});

describe("FleetHub.getWorkerFileDiff path guard", () => {
  it("rejects path traversal without touching git", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    const rec = await hub.dispatch(sampleBrief);
    expect(await hub.getWorkerFileDiff(rec.workerId, "../../etc/passwd")).toEqual({
      file: "../../etc/passwd",
      diff: "",
      error: "invalid path",
    });
  });

  it("returns null for an unknown worker", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    expect(await hub.getWorkerFileDiff("nope", "a.ts")).toBeNull();
  });
});
