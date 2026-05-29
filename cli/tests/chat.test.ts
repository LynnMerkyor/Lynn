import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyModeCommand, applyReasoningCommand, formatChatError, isModeToggleKeypress, renderMode, renderOfflineChatHint, toggleMode } from "../src/commands/chat.js";
import { BrainConnectionError } from "../src/brain-client.js";
import { setLang } from "../src/i18n.js";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

describe("chat mode controls", () => {
  it("toggles between guarded and yolo modes", () => {
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(renderMode(mode)).toBe("ask / workspace-write");
    expect(applyModeCommand(mode, "yolo")).toBe("YOLO mode enabled.");
    expect(renderMode(mode)).toBe("yolo / danger-full-access");
    expect(applyModeCommand(mode, "ask")).toBe("Guarded mode enabled.");
    expect(renderMode(mode)).toBe("ask / workspace-write");
  });

  it("supports the Shift+Tab hotkey shape used by terminals", () => {
    expect(isModeToggleKeypress({ sequence: "\u001b[Z" })).toBe(true);
    expect(isModeToggleKeypress({ name: "tab", shift: true })).toBe(true);
    expect(isModeToggleKeypress({ name: "tab" })).toBe(false);
  });

  it("toggles yolo mode with the hotkey action", () => {
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(toggleMode(mode)).toBe("YOLO mode enabled.");
    expect(renderMode(mode)).toBe("yolo / danger-full-access");
    expect(toggleMode(mode)).toBe("Guarded mode enabled.");
    expect(renderMode(mode)).toBe("ask / workspace-write");
  });

  it("renders a short Brain recovery message for interactive chat", () => {
    const message = formatChatError(new BrainConnectionError("http://127.0.0.1:8790", new Error("fetch failed")));

    expect(message).toContain("local Brain is offline");
    expect(message).toContain("CLI-only BYOK");
    expect(message).not.toContain("For CLI-only smoke tests");
  });

  it("renders a one-shot offline hint for bare startup", () => {
    const hint = renderOfflineChatHint({ approval: "ask", sandbox: "workspace-write" }, "http://127.0.0.1:8790");

    expect(hint).toContain("local Brain offline");
    expect(hint).toContain("CLI-only BYOK");
    expect(hint).toContain("lynn providers");
    expect(hint).toContain("--mock-brain");
  });

  it("renders CLI BYOK as usable when Brain is offline", () => {
    const hint = renderOfflineChatHint(
      { approval: "ask", sandbox: "workspace-write" },
      "http://127.0.0.1:8790",
      { provider: "openai-compatible", model: "deepseek-chat" },
    );

    expect(hint).toContain("using CLI BYOK provider directly");
    expect(hint).toContain("deepseek-chat");
  });

  it("updates reasoning mode for fast and deep MiMo turns", () => {
    const current = { effort: "auto" as const, display: "auto" as const };

    expect(applyReasoningCommand(current, "off").reasoning).toMatchObject({ effort: "off" });
    expect(applyReasoningCommand(current, "high").reasoning).toMatchObject({ effort: "high" });
    expect(applyReasoningCommand(current, "show").reasoning).toMatchObject({ display: "always" });
  });

  it("localizes reasoning command receipts", () => {
    setLang("zh");
    const current = { effort: "auto" as const, display: "auto" as const };

    expect(applyReasoningCommand(current, "high").message).toContain("推理强度");
    expect(applyReasoningCommand(current, "show").message).toContain("始终");
  });
});
