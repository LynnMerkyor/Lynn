import { describe, expect, it } from "vitest";
import { buildCodeContextMessages, computeCodeContextLayerDiagnostics } from "../src/context-layers.js";
import type { ChatMessage } from "../src/brain-client.js";
import type { RuntimeInstructionFrame } from "../../shared/runtime-instruction-frames.js";

const frames: RuntimeInstructionFrame[] = [
  { kind: "base_system", text: "You are Lynn CLI code mode." },
  { kind: "cacheable_context", text: "Repository root: /repo" },
  { kind: "permission_state", text: "approval=ask sandbox=workspace-write", stable: false, cacheable: false },
  { kind: "tool_guard", text: "Dangerous tools require approval.", stable: false, cacheable: false },
];

describe("code context layers", () => {
  it("keeps the stable cache prefix before resume history and volatile runtime frames", () => {
    const resumeMessages: ChatMessage[] = [
      { role: "user", content: "previous task" },
      { role: "assistant", content: "previous answer" },
    ];

    const built = buildCodeContextMessages({
      frames,
      resumeMessages,
      currentUserContent: "continue",
    });

    expect(built.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "user",
      "user",
    ]);
    expect(built.messages[0]?.content).toContain("base_system:You are Lynn CLI code mode.");
    expect(built.messages[0]?.content).toContain("cacheable_context:Repository root: /repo");
    expect(String(built.messages[3]?.content)).toContain("permission_state");
    expect(String(built.messages[4]?.content)).toContain("tool_guard");
    expect(built.messages[5]?.content).toBe("continue");
  });

  it("records stable, volatile, and resume layer diagnostics for cache drift audits", () => {
    expect(computeCodeContextLayerDiagnostics(frames, 2)).toMatchObject({
      schemaVersion: 1,
      stableFrameCount: 2,
      stableFrameKinds: ["base_system", "cacheable_context"],
      volatileFrameCount: 2,
      volatileFrameKinds: ["permission_state", "tool_guard"],
      resumeMessageCount: 2,
      layerOrder: ["stable_prefix", "resume_history", "volatile_runtime", "current_user"],
    });
  });
});
