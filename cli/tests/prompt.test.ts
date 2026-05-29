import { describe, expect, it } from "vitest";
import { mergePromptAndStdin } from "../src/commands/prompt.js";

describe("prompt stdin handling", () => {
  it("uses stdin as the whole prompt for dash", () => {
    expect(mergePromptAndStdin("-", "file body\n")).toBe("file body");
  });

  it("appends piped stdin as context when a prompt is present", () => {
    expect(mergePromptAndStdin("summarize", "hello")).toBe("summarize\n\n--- stdin ---\nhello");
  });

  it("uses stdin when no prompt is present", () => {
    expect(mergePromptAndStdin("", "hello")).toBe("hello");
  });
});
