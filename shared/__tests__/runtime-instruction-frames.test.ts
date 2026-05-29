import { describe, expect, it } from "vitest";
import {
  renderRuntimeInstructionFrame,
  serializeRuntimeInstructionFrames,
  stableRuntimePrefix,
  type RuntimeInstructionFrame,
} from "../runtime-instruction-frames.js";

const frames: RuntimeInstructionFrame[] = [
  { kind: "base_system", text: "You are Lynn, a coding assistant.", source: "cli" },
  { kind: "runtime_policy", text: "From this turn, use fast mode.", sinceTurn: 3, source: "cli" },
  { kind: "permission_state", text: "approval=ask sandbox=workspace-write", source: "fleet" },
];

describe("runtime instruction frames", () => {
  it("keeps base system top-level and downgrades dynamic frames for DeepSeek Anthropic compatibility", () => {
    const serialized = serializeRuntimeInstructionFrames(frames, {
      supportsTopLevelSystem: true,
      supportsSystemMessages: false,
      supportsMidConversationSystemMessages: false,
    });

    expect(serialized.system).toBe("You are Lynn, a coding assistant.");
    expect(serialized.messages).toHaveLength(2);
    expect(serialized.messages.every((message) => message.role !== "system")).toBe(true);
    expect(serialized.messages[0].role).toBe("user");
    expect(serialized.messages[0].content).toContain("lynn_runtime_frame");
    expect(serialized.warnings.join("\n")).toContain("runtime_policy downgraded");
  });

  it("uses mid-conversation system frames only when the adapter opts in", () => {
    const serialized = serializeRuntimeInstructionFrames(frames, {
      supportsTopLevelSystem: true,
      supportsSystemMessages: true,
      supportsMidConversationSystemMessages: true,
    });

    expect(serialized.system).toBe("You are Lynn, a coding assistant.");
    expect(serialized.messages.map((message) => message.role)).toEqual(["system", "system"]);
    expect(serialized.warnings).toEqual([]);
  });

  it("uses developer messages for OpenAI-compatible adapters that support them", () => {
    const serialized = serializeRuntimeInstructionFrames(frames.slice(1), {
      supportsTopLevelSystem: false,
      supportsDeveloperMessages: true,
    });

    expect(serialized.messages.map((message) => message.role)).toEqual(["developer", "developer"]);
    expect(serialized.warnings).toEqual([]);
  });

  it("exposes a stable prefix string for cache discipline", () => {
    expect(stableRuntimePrefix(frames)).toBe("base_system:You are Lynn, a coding assistant.");
    expect(stableRuntimePrefix([
      frames[0],
      { kind: "cacheable_context", text: "Repository root: /repo" },
      { kind: "ephemeral_context", text: "Current progress: 20%" },
    ])).toContain("cacheable_context:Repository root: /repo");
  });

  it("protects user-role downgraded frames from prompt injection confusion", () => {
    const rendered = renderRuntimeInstructionFrame({
      kind: "tool_guard",
      title: "YOLO guard",
      text: "Do not run rm -rf.",
    });

    expect(rendered).toContain("runtime control data");
    expect(rendered).toContain("kind=\"tool_guard\"");
  });
});

