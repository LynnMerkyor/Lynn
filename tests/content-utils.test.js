import { describe, expect, it } from "vitest";

import { extractText } from "../server/chat/content-utils.js";

describe("content-utils extractText", () => {
  it("returns plain string content unchanged", () => {
    expect(extractText("hello world")).toBe("hello world");
  });

  it("returns empty string for null/undefined", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });

  it("concatenates text blocks from array content", () => {
    const content = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(extractText(content)).toBe("Hello world");
  });

  it("skips non-text blocks", () => {
    const content = [
      { type: "text", text: "visible" },
      { type: "image", url: "https://example.com/img.png" },
      { type: "text", text: " text" },
    ];
    expect(extractText(content)).toBe("visible text");
  });

  it("returns empty string for non-string non-array input", () => {
    expect(extractText(42)).toBe("");
    expect(extractText({})).toBe("");
  });
});
