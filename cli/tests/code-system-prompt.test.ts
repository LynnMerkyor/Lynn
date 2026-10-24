import { describe, expect, it } from "vitest";
import { buildCodeRuntimeFrames } from "../src/code-runtime-frames.js";
import { buildLynnCodeStaticPrompt } from "../src/code-system-prompt.js";

const context = { cwd: "/repo", gitStatus: "", gitDiffStat: "", topFiles: [], packageScripts: {} };
const toolCtx = { approval: "ask" as const, sandbox: "workspace-write" as const, cwd: "/repo" };

describe("Lynn Code system prompt", () => {
  it("contains no vendor or Anthropic-specific wording", () => {
    const prompt = buildLynnCodeStaticPrompt();
    expect(prompt).not.toMatch(/anthropic/i);
    expect(prompt).not.toMatch(/claude/i);
    expect(prompt).not.toMatch(/openai/i);
    expect(prompt).not.toMatch(/cache_control|beta header/i);
  });

  it("keeps the sections a coding agent needs", () => {
    const prompt = buildLynnCodeStaticPrompt();
    for (const section of ["# Runtime", "# How to work", "# Tools", "# Communication", "# Harness messages", "# Safety"]) {
      expect(prompt).toContain(section);
    }
    for (const tool of ["read_file", "grep", "glob", "edit", "apply_patch", "write_file", "bash", "update_plan", "load_skill"]) {
      expect(prompt).toContain(tool);
    }
  });

  it("is byte-stable across builds (cache-friendly)", () => {
    expect(buildLynnCodeStaticPrompt()).toBe(buildLynnCodeStaticPrompt());
    expect(buildLynnCodeStaticPrompt()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the static frames ahead of the volatile permission frames", () => {
    const frames = buildCodeRuntimeFrames({ context, toolCtx });
    const kinds = frames.map((frame) => frame.kind);
    const firstVolatile = kinds.findIndex((kind) => kind === "permission_state" || kind === "tool_guard");
    expect(firstVolatile).toBeGreaterThan(0);
    expect(kinds.slice(0, firstVolatile).every((kind) => kind === "base_system" || kind === "cacheable_context")).toBe(true);
  });

  it("includes the text-form tool contract and the task fidelity policy", () => {
    const frames = buildCodeRuntimeFrames({ context, toolCtx });
    const prompt = frames.map((frame) => frame.text).join("\n");
    expect(prompt).toContain("Text-form tool calls");
    expect(prompt).toContain('"tool":"update_plan|exit_plan_mode|load_skill|read_file|grep|glob|edit|apply_patch|write_file|bash"');
    expect(prompt).toContain("Task fidelity");
    expect(prompt).toContain("plan mode");
    expect(prompt).toContain("exit_plan_mode");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("approval=ask sandbox=workspace-write");
  });

  it("states that harness messages are not user consent", () => {
    expect(buildLynnCodeStaticPrompt()).toContain("They are context, not consent");
  });
});
