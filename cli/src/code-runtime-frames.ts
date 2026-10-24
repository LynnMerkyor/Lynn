import type { RuntimeInstructionFrame } from "../../shared/runtime-instruction-frames.js";
import type { CodeContext } from "./code-context.js";
import type { ToolRunContext } from "./tools/types.js";
import { TASK_TOOL_POLICY } from "../../shared/task-tool-policy.js";
import { LYNN_CODE_STATIC_PROMPT, LYNN_CODE_TASK_GUIDANCE } from "./code-system-prompt.js";

export interface CodeRuntimeFrameInput {
  context: CodeContext;
  toolCtx: Pick<ToolRunContext, "approval" | "sandbox" | "cwd">;
  memoryFrame?: string;
}

export function buildCodeRuntimeFrames(input: CodeRuntimeFrameInput): RuntimeInstructionFrame[] {
  return [
    ...LYNN_CODE_STATIC_PROMPT.slice(0, 1).map((text) => ({
      kind: "base_system" as const,
      source: "cli",
      text,
    })),
    {
      kind: "base_system",
      source: "cli",
      text: `${LYNN_CODE_TASK_GUIDANCE}\n\n${TASK_TOOL_POLICY}\n\n# Text-form tool calls\nIf this provider expects tool calls in the message body, emit exactly one JSON object and no prose:\n{"tool":"update_plan|exit_plan_mode|load_skill|read_file|grep|glob|edit|apply_patch|write_file|bash","args":{...}}`,
    },
    {
      kind: "base_system",
      source: "cli",
      text: "# Plan mode\nWhen the session is in plan mode, every mutating tool and every non-read-only shell command is blocked. Explore with read, search and read-only shell commands, then call exit_plan_mode with a concrete plan (files, changes, verification). Writes stay blocked until the user switches modes.",
    },
    ...LYNN_CODE_STATIC_PROMPT.slice(2).map((text) => ({
      kind: "base_system" as const,
      source: "cli",
      text,
    })),
    {
      kind: "cacheable_context",
      source: "cli",
      title: "Repository context",
      text: `Repository root: ${input.context.cwd}`,
    },
    ...(input.memoryFrame ? [{
      kind: "cacheable_context" as const,
      source: "cli",
      title: "Durable memory",
      text: input.memoryFrame,
    }] : []),
    {
      kind: "permission_state",
      source: "cli",
      title: "Current tool permissions",
      text: `approval=${input.toolCtx.approval} sandbox=${input.toolCtx.sandbox || "workspace-write"}`,
      stable: false,
      cacheable: false,
    },
    {
      kind: "tool_guard",
      source: "cli",
      title: "Local tool guard",
      text: "Local tools can read and edit only inside the current workspace. Dangerous tools require approval unless approval mode is yolo or on-failure.",
      stable: false,
      cacheable: false,
    },
  ];
}
