import { describe, expect, it } from "vitest";
import { classifyDiffLine, parseInkInline, parseInkMarkdown } from "../src/ink-markdown.js";

describe("parseInkMarkdown", () => {
  it("parses markdown blocks used by the Ink chat and code shells", () => {
    expect(parseInkMarkdown([
      "# Title",
      "- use `read_file`",
      "1. run **tests**",
      "> note",
      "```diff",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "```",
    ].join("\n"))).toEqual([
      { kind: "heading", text: "Title" },
      { kind: "bullet", indent: "", text: "use `read_file`" },
      { kind: "numbered", indent: "", number: "1", text: "run **tests**" },
      { kind: "quote", text: "note" },
      { kind: "fence", open: true, lang: "diff" },
      { kind: "code", text: "@@ -1 +1 @@" },
      { kind: "code", text: "-old" },
      { kind: "code", text: "+new" },
      { kind: "fence", open: false, lang: undefined },
    ]);
  });
});

describe("parseInkInline", () => {
  it("extracts inline code and strong spans without losing plain text", () => {
    expect(parseInkInline("read `a.ts` then **test**")).toEqual([
      { kind: "text", text: "read " },
      { kind: "code", text: "a.ts" },
      { kind: "text", text: " then " },
      { kind: "bold", text: "test" },
    ]);
  });
});

describe("classifyDiffLine", () => {
  it("keeps unified diff coloring stable for Ink tool previews", () => {
    expect(classifyDiffLine("+new")).toBe("add");
    expect(classifyDiffLine("-old")).toBe("remove");
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("hunk");
    expect(classifyDiffLine("*** Begin Patch")).toBe("meta");
    expect(classifyDiffLine(" context")).toBe("context");
  });
});
