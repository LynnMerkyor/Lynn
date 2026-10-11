import { describe, expect, it } from "vitest";
import { TASK_TOOL_POLICY } from "../shared/task-tool-policy.js";
import { createSessionResourceLoader } from "../core/session-resource-loader.js";
import { buildCliRuntimeSystemMessage } from "../cli/src/runtime-context.js";
import { buildCodeRuntimeFrames } from "../cli/src/code-runtime-frames.js";

describe("model-decided tool necessity", () => {
  it("shares the policy across GUI, CLI chat and CLI code without filtering tool schemas", () => {
    const loader = createSessionResourceLoader({
      baseResourceLoader: { getAppendSystemPrompt: () => ["existing instruction"] },
      sessionEntry: {}, effectiveModel: null,
      getAgent: () => ({}), getHomeCwd: () => null,
    });
    const prompts = loader.getAppendSystemPrompt();
    expect(prompts).toContain("existing instruction");
    expect(prompts).toContain(TASK_TOOL_POLICY);
    expect(buildCliRuntimeSystemMessage("test route").content).toContain(TASK_TOOL_POLICY);
    const frames = buildCodeRuntimeFrames({ context: { cwd: "/tmp/policy-test" } as never, toolCtx: { approval: "ask", cwd: "/tmp/policy-test" } });
    expect(frames[0].text).toContain(TASK_TOOL_POLICY);
  });
  it("preserves supplied content while explicitly retaining research and file execution", () => {
    expect(TASK_TOOL_POLICY).toContain("Preserve relative dates, names and values as written");
    expect(TASK_TOOL_POLICY).toContain("include every action");
    expect(TASK_TOOL_POLICY).toContain("requested realtime research, fact checking, date conversion or local file operations");
    expect(TASK_TOOL_POLICY).not.toMatch(/OFFICE-01|李雷|韩梅梅|顺德|NBA/u);
  });
});
