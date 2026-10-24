import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decidePermission, loadPermissionRules } from "../src/permission-rules.js";
import { loadHookConfig, runHooks } from "../src/hooks.js";
import { killAllBackgroundJobs, killBackgroundJob, startBackgroundJob, drainCompletedJobs } from "../src/background-jobs.js";
import { bashTool } from "../src/tools/bash.js";
import { recordFileRead, wasFileRead, withReadState } from "../src/tools/read-state.js";

let workspace = "";
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-review-")); });
afterEach(async () => { killAllBackgroundJobs(); await fs.rm(workspace, { recursive: true, force: true }); });

describe("review safety regressions", () => {
  it.each(['{', '[]', '{"deny":"bash(*)"}', '{"permissions":null}', '{"deny":[42]}', '{"deny":[""]}'])("fails closed for malformed permission data %s", async contents => {
    await fs.mkdir(path.join(workspace, "permissions"));
    await fs.writeFile(path.join(workspace, "permissions/cli.json"), contents);
    const loaded = await loadPermissionRules(workspace, workspace);
    expect(decidePermission("bash", { command: "echo test" }, loaded.rules).decision).toBe("deny");
    expect(loaded.rules.errors.length).toBeGreaterThan(0);
  });

  it.each(['{', '{"hooks":{"PreToolUse":"false"}}', '{"hooks":{"PreToolUse":[{"command":"echo test","matcher":"["}]}}'])("blocks invalid trusted hook configuration %s", async contents => {
    await fs.writeFile(path.join(workspace, "hooks.json"), contents);
    const configuration = await loadHookConfig(workspace, workspace);
    expect((await runHooks("PreToolUse", { event: "PreToolUse", cwd: workspace, timestamp: "", tool: "bash" }, configuration)).blocked).toBe(true);
  });

  it("blocks malformed guard output", async () => {
    expect((await runHooks("UserPromptSubmit", { event: "UserPromptSubmit", cwd: workspace, timestamp: "" }, {
      hooks: { UserPromptSubmit: [{ command: 'node -e "console.log(\'invalid\')"' }] }, sources: [], errors: [],
    })).blocked).toBe(true);
  });

  it("isolates concurrent task read caches", async () => {
    await Promise.all([
      withReadState(async () => {
        recordFileRead("first", { mtimeMs: 1, size: 1 }, { offset: 0, nextOffset: 1, truncated: false });
        await pause(20);
        expect(wasFileRead("first")).toBe(true);
        expect(wasFileRead("second")).toBe(false);
      }),
      withReadState(async () => {
        recordFileRead("second", { mtimeMs: 1, size: 1 }, { offset: 0, nextOffset: 1, truncated: false });
        await pause(10);
        expect(wasFileRead("first")).toBe(false);
      }),
    ]);
    withReadState(() => expect(wasFileRead("first")).toBe(false));
  });

  it("stops a background command's descendants", async () => {
    await fs.writeFile(path.join(workspace, "child.cjs"), "require('fs').writeFileSync('ready', 'yes'); setTimeout(() => require('fs').writeFileSync('escaped', 'bad'), 800);");
    await fs.writeFile(path.join(workspace, "parent.cjs"), "require('child_process').spawn(process.execPath, ['child.cjs'], {stdio:'inherit'}); setInterval(() => {}, 1000);");
    const job = startBackgroundJob({ command: 'node parent.cjs', cwd: workspace });
    for (let attempt = 0; attempt < 100 && !(await fs.access(path.join(workspace, "ready")).then(() => true, () => false)); attempt++) await pause(20);
    await expect(fs.access(path.join(workspace, "ready"))).resolves.toBeUndefined();
    expect(killBackgroundJob(job.id)).toBe(true);
    await pause(1000);
    await expect(fs.access(path.join(workspace, "escaped"))).rejects.toThrow();
    const completed = await drainCompletedJobs();
    expect(completed.some(entry => entry.job.id === job.id)).toBe(true);
  });

  it("does not start an already-cancelled foreground or background command", async () => {
    for (const background of [false, true]) {
      const result = await bashTool({ cwd: workspace, approval: "yolo", sandbox: "danger-full-access", signal: AbortSignal.abort() }, 'node -e "require(\'fs\').writeFileSync(\'escaped\',\'bad\')"', { background });
      expect(result).toMatchObject({ ok: false, output: { aborted: true } });
    }
    await expect(fs.access(path.join(workspace, "escaped"))).rejects.toThrow();
  });
});
