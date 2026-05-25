import { describe, expect, it } from "vitest";
import { loadLocale } from "../server/i18n.js";
import {
  buildLocalSummary,
  containsPseudoToolCallSimulation,
  getToolArgs,
  isToolCallBlock,
  sanitizeAssistantTextContent,
} from "../core/llm-utils.js";

describe("llm-utils content helpers", () => {
  it("recognizes both SDK tool call block shapes", () => {
    expect(isToolCallBlock({ type: "tool_use", name: "Read" })).toBe(true);
    expect(isToolCallBlock({ type: "toolCall", name: "Bash" })).toBe(true);
    expect(isToolCallBlock({ type: "tool_use" })).toBe(false);
    expect(isToolCallBlock({ type: "text", text: "hello" })).toBe(false);
  });

  it("reads tool args from input before arguments", () => {
    expect(getToolArgs({ input: { file_path: "a" }, arguments: { file_path: "b" } })).toEqual({ file_path: "a" });
    expect(getToolArgs({ arguments: { command: "pwd" } })).toEqual({ command: "pwd" });
  });

  it("normalizes assistant text whitespace", () => {
    const raw = "Before   \n\n\nAfter   \n";

    expect(containsPseudoToolCallSimulation(raw)).toBe(false);
    expect(sanitizeAssistantTextContent(raw)).toBe("Before\n\nAfter");
  });
});

describe("buildLocalSummary", () => {
  it("summarizes unique tool calls in the active locale", () => {
    loadLocale("en");
    expect(buildLocalSummary("", ["Read", "Bash", "Read", "Edit"])).toBe("Ran Read, Bash, Edit");

    loadLocale("zh-CN");
    expect(buildLocalSummary("", ["Read", "Bash", "Edit", "Write"])).toBe("执行了 Read、Bash、Edit 等");
  });

  it("falls back to cleaned assistant text", () => {
    loadLocale("en");
    expect(buildLocalSummary("**Done**", [])).toBe("Done");
    expect(buildLocalSummary("", [])).toBeNull();
  });
});
