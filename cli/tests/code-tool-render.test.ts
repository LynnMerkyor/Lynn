import { describe, expect, it } from "vitest";
import { renderClientToolResult, renderClientToolStart } from "../src/code-tool-render.js";
import type { CodeToolRequest } from "../src/code-tool-protocol.js";
import type { ClientToolResult } from "../src/tools/types.js";

function capture(render: (stream: NodeJS.WriteStream) => void): string {
  let output = "";
  const stream = {
    isTTY: false,
    write(chunk: string | Uint8Array) {
      output += String(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  render(stream);
  return output;
}

describe("code tool render edit activity", () => {
  it("renders apply_patch as compact editing cards with +/- stats", () => {
    const patch = [
      "diff --git a/src/chat.ts b/src/chat.ts",
      "--- a/src/chat.ts",
      "+++ b/src/chat.ts",
      "@@",
      "-old",
      "+new",
      "+extra",
    ].join("\n");
    const request: CodeToolRequest = { tool: "apply_patch", args: { text: patch }, step: 0 };
    const result: ClientToolResult = { ok: true, tool: "apply_patch", output: { changed: true } };

    const start = capture((stream) => renderClientToolStart(request, stream));
    const done = capture((stream) => renderClientToolResult(result, stream, request));

    expect(start).toContain("正在编辑 src/chat.ts +2 -1");
    expect(done).toContain("已编辑 src/chat.ts +2 -1");
    expect(start).not.toContain("diff --git");
  });

  it("renders write_file as a compact created/edited card", () => {
    const request: CodeToolRequest = { tool: "write_file", args: { path: "notes.md", text: "a\nb\n" }, step: 0 };
    const result: ClientToolResult = { ok: true, tool: "write_file", output: { path: "notes.md" } };

    const done = capture((stream) => renderClientToolResult(result, stream, request));

    expect(done).toContain("已编辑 notes.md +2");
  });
});
