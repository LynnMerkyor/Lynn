import { describe, expect, it } from "vitest";

import { buildCodeVerificationPostscript } from "../server/chat/code-verification-postscript.js";

describe("code verification postscript", () => {
  it("returns empty string for empty prompt", () => {
    expect(buildCodeVerificationPostscript("", "")).toBe("");
    expect(buildCodeVerificationPostscript("   ", "some output")).toBe("");
  });

  it("returns empty string when prompt does not look like a code failure", () => {
    expect(buildCodeVerificationPostscript("今天天气如何？", "深圳晴天")).toBe("");
  });

  it("returns empty string when prompt references code errors but not main.py", () => {
    expect(buildCodeVerificationPostscript(
      "Traceback in app.py, fix the TypeError",
      "Here is the fix...",
    )).toBe("");
  });

  it("skips postscript when verification is already in visible text", () => {
    expect(buildCodeVerificationPostscript(
      "main.py 报错了,Traceback 里有 TypeError",
      "已修复。请运行验证\npython3 main.py 确认通过。",
    )).toBe("");
  });

  it("appends verification prompt for short visible text about main.py errors", () => {
    const result = buildCodeVerificationPostscript(
      "main.py 报错 TraceError,帮我修一下",
      "好的，已修复。",
    );
    expect(result).toContain("python main.py");
    expect(result).toContain("ComfyUI");
  });

  it("omits ComfyUI guidance for long visible text", () => {
    const longText = "x".repeat(200);
    const result = buildCodeVerificationPostscript(
      "main.py 有 SyntaxError,帮我修",
      longText,
    );
    expect(result).toContain("python main.py");
    expect(result).not.toContain("ComfyUI");
  });
});
