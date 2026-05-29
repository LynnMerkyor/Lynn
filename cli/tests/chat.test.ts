import { describe, expect, it } from "vitest";
import { applyModeCommand, formatChatError, renderMode } from "../src/commands/chat.js";
import { BrainConnectionError } from "../src/brain-client.js";

describe("chat mode controls", () => {
  it("toggles between guarded and yolo modes", () => {
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(renderMode(mode)).toBe("ask / workspace-write");
    expect(applyModeCommand(mode, "yolo")).toBe("YOLO mode enabled.");
    expect(renderMode(mode)).toBe("yolo / danger-full-access");
    expect(applyModeCommand(mode, "ask")).toBe("Guarded mode enabled.");
    expect(renderMode(mode)).toBe("ask / workspace-write");
  });

  it("renders a short Brain recovery message for interactive chat", () => {
    const message = formatChatError(new BrainConnectionError("http://127.0.0.1:8790", new Error("fetch failed")));

    expect(message).toContain("Brain offline");
    expect(message).toContain("start the Lynn GUI");
    expect(message).not.toContain("For CLI-only smoke tests");
  });
});
