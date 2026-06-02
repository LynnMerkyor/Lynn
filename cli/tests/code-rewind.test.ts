import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyCodeRewind, parseCodeRewindSpec, readCodeRewindSession, renderCodeRewindApply, renderCodeRewindPreview } from "../src/code-rewind.js";
import { createWorkspaceSnapshot, recordWorkspaceSnapshotForRequest } from "../src/code-snapshot.js";
import { appendSessionLine, appendSessionMetadata, readSessionLines } from "../src/session/store.js";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("code rewind sidecar snapshots", () => {
  it("previews and rewinds only files touched by Lynn", async () => {
    const root = await tmpDir("lynn-rewind-");
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "repo");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "a.txt"), "A0", "utf8");
    await fs.writeFile(path.join(cwd, "busy.bin"), "external-v1", "utf8");

    let sessionPath = await appendSessionLine({
      dataDir,
      cwd,
      title: "task A",
      line: { type: "user", content: "change a" },
    });
    let snapshot = createWorkspaceSnapshot(cwd);
    snapshot = recordWorkspaceSnapshotForRequest(cwd, snapshot, { tool: "write_file", args: { path: "a.txt", text: "A1" } });
    await fs.writeFile(path.join(cwd, "a.txt"), "A1", "utf8");
    sessionPath = await appendSessionLine({ dataDir, sessionPath, cwd, title: "task A", line: { type: "assistant", content: "changed a" } });
    await appendSessionMetadata({
      dataDir,
      sessionPath,
      data: { kind: "code_rewind_checkpoint", snapshotRef: snapshot.ref, restoreCommand: snapshot.restoreCommand, cwd, task: "change a", beforeLine: 0 },
    });

    const beforeSecondTurn = (await readSessionLines(sessionPath)).length;
    sessionPath = await appendSessionLine({ dataDir, sessionPath, cwd, title: "task B", line: { type: "user", content: "create b" } });
    let second = createWorkspaceSnapshot(cwd);
    second = recordWorkspaceSnapshotForRequest(cwd, second, { tool: "write_file", args: { path: "new.txt", text: "new" } });
    await fs.writeFile(path.join(cwd, "new.txt"), "new", "utf8");
    await fs.writeFile(path.join(cwd, "busy.bin"), "external-v2", "utf8");
    await appendSessionMetadata({
      dataDir,
      sessionPath,
      data: { kind: "code_rewind_checkpoint", snapshotRef: second.ref, restoreCommand: second.restoreCommand, cwd, task: "create b", beforeLine: beforeSecondTurn },
    });
    await fs.appendFile(sessionPath, "{torn", "utf8");

    const session = await readCodeRewindSession(sessionPath);
    expect(session.skippedLines).toBe(1);
    expect(session.checkpoints).toHaveLength(2);
    expect(renderCodeRewindPreview(session, 1, false)).toContain("delete created: new.txt");

    const applied = await applyCodeRewind({ sessionPath, ordinal: 1 });
    await expect(fs.readFile(path.join(cwd, "a.txt"), "utf8")).resolves.toBe("A1");
    await expect(fs.readFile(path.join(cwd, "busy.bin"), "utf8")).resolves.toBe("external-v2");
    await expect(fs.stat(path.join(cwd, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(applied.deletedFiles).toEqual(["new.txt"]);
    expect(applied.trimmedSessionPath).not.toBe(sessionPath);
    expect((await readSessionLines(applied.trimmedSessionPath)).at(-1)?.data?.kind).toBe("code_rewind_applied");

    await applyCodeRewind({ sessionPath, ordinal: 2 });
    await expect(fs.readFile(path.join(cwd, "a.txt"), "utf8")).resolves.toBe("A0");
    await expect(fs.readFile(path.join(cwd, "busy.bin"), "utf8")).resolves.toBe("external-v2");
  });

  it("reports skipped large files without overwriting them", async () => {
    const root = await tmpDir("lynn-rewind-large-");
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "repo");
    await fs.mkdir(cwd, { recursive: true });
    const largePath = path.join(cwd, "large.bin");
    await fs.writeFile(largePath, Buffer.alloc(6 * 1024 * 1024, 1));
    const snapshot = recordWorkspaceSnapshotForRequest(cwd, createWorkspaceSnapshot(cwd), { tool: "write_file", args: { path: "large.bin", text: "x" } });
    await fs.writeFile(largePath, "latest", "utf8");
    const sessionPath = await appendSessionLine({ dataDir, cwd, title: "large", line: { type: "user", content: "touch large" } });
    await appendSessionMetadata({
      dataDir,
      sessionPath,
      data: { kind: "code_rewind_checkpoint", snapshotRef: snapshot.ref, restoreCommand: snapshot.restoreCommand, cwd, task: "touch large", beforeLine: 0 },
    });
    const applied = await applyCodeRewind({ sessionPath, ordinal: 1 });
    expect(applied.skippedFiles).toEqual(["large.bin"]);
    await expect(fs.readFile(largePath, "utf8")).resolves.toBe("latest");
  });

  it("parses slash and headless specs", () => {
    expect(parseCodeRewindSpec("/rewind")).toEqual({ sessionRef: null, ordinal: null, apply: false });
    expect(parseCodeRewindSpec("/rewind 2 --apply")).toEqual({ sessionRef: null, ordinal: 2, apply: true });
    expect(parseCodeRewindSpec("last#3", true)).toEqual({ sessionRef: "last", ordinal: 3, apply: true });
  });

  it("restores the OLDEST content for a file edited across multiple checkpoints (last-write-wins)", async () => {
    const root = await tmpDir("lynn-rewind-overlap-");
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "repo");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "shared.txt"), "v0", "utf8");

    // Task A: v0 -> v1
    let sessionPath = await appendSessionLine({ dataDir, cwd, title: "A", line: { type: "user", content: "edit 1" } });
    let snapA = recordWorkspaceSnapshotForRequest(cwd, createWorkspaceSnapshot(cwd), { tool: "write_file", args: { path: "shared.txt", text: "v1" } });
    await fs.writeFile(path.join(cwd, "shared.txt"), "v1", "utf8");
    await appendSessionMetadata({ dataDir, sessionPath, data: { kind: "code_rewind_checkpoint", snapshotRef: snapA.ref, restoreCommand: snapA.restoreCommand, cwd, task: "edit 1", beforeLine: 0 } });

    // Task B: v1 -> v2 (SAME file)
    const beforeB = (await readSessionLines(sessionPath)).length;
    sessionPath = await appendSessionLine({ dataDir, sessionPath, cwd, title: "B", line: { type: "user", content: "edit 2" } });
    let snapB = recordWorkspaceSnapshotForRequest(cwd, createWorkspaceSnapshot(cwd), { tool: "write_file", args: { path: "shared.txt", text: "v2" } });
    await fs.writeFile(path.join(cwd, "shared.txt"), "v2", "utf8");
    await appendSessionMetadata({ dataDir, sessionPath, data: { kind: "code_rewind_checkpoint", snapshotRef: snapB.ref, restoreCommand: snapB.restoreCommand, cwd, task: "edit 2", beforeLine: beforeB } });

    const session = await readCodeRewindSession(sessionPath);
    expect(session.checkpoints).toHaveLength(2);

    // Rewind newest only -> v1
    await applyCodeRewind({ sessionPath, ordinal: 1 });
    await expect(fs.readFile(path.join(cwd, "shared.txt"), "utf8")).resolves.toBe("v1");
    // Rewind both -> v0 (oldest pre-state must win)
    const both = await applyCodeRewind({ sessionPath, ordinal: 2 });
    await expect(fs.readFile(path.join(cwd, "shared.txt"), "utf8")).resolves.toBe("v0");
    expect(both.missingSnapshots).toEqual([]);
  });

  it("flags a partial rewind when a checkpoint snapshot is missing", async () => {
    const root = await tmpDir("lynn-rewind-missing-");
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "repo");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "kept.txt"), "current", "utf8");

    const sessionPath = await appendSessionLine({ dataDir, cwd, title: "ghost", line: { type: "user", content: "edit" } });
    await appendSessionMetadata({
      dataDir,
      sessionPath,
      // snapshotRef points at a snapshot that does not exist on disk (e.g. cleaned ~/.lynn/cli-snapshots)
      data: { kind: "code_rewind_checkpoint", snapshotRef: "deadbeef-missing-ref", restoreCommand: null, cwd, task: "edit", beforeLine: 0 },
    });

    const session = await readCodeRewindSession(sessionPath);
    expect(session.checkpoints).toHaveLength(1);
    expect(session.checkpoints[0].missing).toBe(true);
    expect(renderCodeRewindPreview(session, 1, false)).toContain("missing");

    const applied = await applyCodeRewind({ sessionPath, ordinal: 1 });
    expect(applied.missingSnapshots).toEqual(["deadbeef-missing-ref"]);
    expect(renderCodeRewindApply(applied, false)).toContain("partial");
    // The file on disk is left untouched — we cannot restore what we do not have.
    await expect(fs.readFile(path.join(cwd, "kept.txt"), "utf8")).resolves.toBe("current");
  });
});
