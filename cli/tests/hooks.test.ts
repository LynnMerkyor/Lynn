import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHookConfig, parseHookOutput, runHooks, type HookConfig } from "../src/hooks.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-hooks-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env.LYNN_TRUST_PROJECT_RULES;
});

function payload(event: "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit", tool?: string) {
  return {
    event,
    cwd: tmp,
    timestamp: new Date().toISOString(),
    ...(tool ? { tool, tool_input: { path: "a.ts" } } : {}),
  } as const;
}

const config = (hook: { command: string; matcher?: string; timeoutMs?: number }, event = "PreToolUse"): HookConfig => ({
  hooks: { [event]: [hook] },
  sources: [],
  errors: [],
});

describe("hook output parsing", () => {
  it("parses the last JSON object and nested additionalContext", () => {
    expect(parseHookOutput('log line\n{"decision":"deny","reason":"no"}')).toMatchObject({ decision: "deny", reason: "no" });
    expect(parseHookOutput('{"hookSpecificOutput":{"additionalContext":"ctx"}}')).toMatchObject({ additionalContext: "ctx" });
    expect(parseHookOutput("not json")).toBeNull();
    expect(parseHookOutput("")).toBeNull();
  });
});

describe("hook execution", () => {
  it("blocks on exit code 2 and uses stderr as the reason", async () => {
    const outcome = await runHooks("PreToolUse", payload("PreToolUse", "write_file"), config({
      command: 'node -e "console.error(\'nope\'); process.exit(2)"',
    }));
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("nope");
  });

  it.each(["PreToolUse", "UserPromptSubmit", "PostToolUse"] as const)("handles a failed %s hook safely", async (event) => {
    const outcome = await runHooks(event, payload(event, "write_file"), config({
      command: 'node -e "console.error(\'boom\'); process.exit(1)"',
    }, event));
    expect(outcome.blocked).toBe(event !== "PostToolUse");
    expect(outcome.warnings.join(" ")).toContain("boom");
  });

  it("supports allow/ask/deny decisions from stdout", async () => {
    const allow = await runHooks("PreToolUse", payload("PreToolUse", "read_file"), config({
      command: `node -e "console.log(JSON.stringify({decision:'allow'}))"`,
    }));
    expect(allow.decision).toBe("allow");
    const ask = await runHooks("PreToolUse", payload("PreToolUse", "read_file"), config({
      command: `node -e "console.log(JSON.stringify({permissionDecision:'ask'}))"`,
    }));
    expect(ask.decision).toBe("ask");
    const deny = await runHooks("PreToolUse", payload("PreToolUse", "read_file"), config({
      command: `node -e "console.log(JSON.stringify({continue:false,reason:'blocked by policy'}))"`,
    }));
    expect(deny.blocked).toBe(true);
  });

  it("collects additionalContext", async () => {
    const outcome = await runHooks("PostToolUse", payload("PostToolUse", "edit"), config({
      command: `node -e "console.log(JSON.stringify({additionalContext:'run the linter'}))"`,
    }, "PostToolUse"));
    expect(outcome.additionalContext).toBe("run the linter");
  });

  it("honours matchers", async () => {
    const cfg = config({ command: 'node -e "console.error(\'blocked\');process.exit(2)"', matcher: "^bash$" });
    const read = await runHooks("PreToolUse", payload("PreToolUse", "read_file"), cfg);
    expect(read.blocked).toBe(false);
    const bash = await runHooks("PreToolUse", payload("PreToolUse", "bash"), cfg);
    expect(bash.blocked).toBe(true);
  });

  it("fails closed when a PreToolUse hook times out", async () => {
    const outcome = await runHooks("PreToolUse", payload("PreToolUse", "bash"), config({
      command: 'node -e "setTimeout(()=>{},5000)"',
      timeoutMs: 150,
    }));
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("timed out");
  });
});

describe("hook config loading", () => {
  it("loads user hooks and ignores project hooks until the repo is trusted", async () => {
    const dataDir = path.join(tmp, "data");
    const repo = path.join(tmp, "repo");
    await fs.mkdir(path.join(repo, ".lynn"), { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ command: "true" }] } }));
    await fs.writeFile(path.join(repo, ".lynn", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ command: "false" }] } }));

    const untrusted = await loadHookConfig(repo, dataDir);
    expect(untrusted.hooks.SessionStart).toHaveLength(1);
    expect(untrusted.hooks.PreToolUse).toBeUndefined();
    expect(untrusted.errors.join(" ")).toContain("ignored");

    process.env.LYNN_TRUST_PROJECT_RULES = "1";
    const trusted = await loadHookConfig(repo, dataDir);
    expect(trusted.hooks.PreToolUse).toHaveLength(1);
    expect(trusted.sources.join(" ")).toContain("project:");
  });
});
