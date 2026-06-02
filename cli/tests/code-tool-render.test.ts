import { describe, expect, it } from "vitest";
import { renderClientToolResult, renderClientToolStart, renderToolApprovalCard } from "../src/code-tool-render.js";
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

  it("renders dangerous tool approval as a readable card", () => {
    const card = renderToolApprovalCard({
      tool: "apply_patch",
      cwd: "/tmp/project",
      preview: "diff --git a/a.ts b/a.ts\n-old\n+new",
    }, false);

    expect(card).toContain("需要授权: apply_patch");
    expect(card).toContain("目录: /tmp/project");
    expect(card).toContain("预览:");
    expect(card).toContain("diff --git");
    expect(card).toContain("y 允许一次");
    expect(card).toContain("a 本次会话全部允许");
    expect(card).toContain("n 拒绝");
  });

  it("limits long approval previews", () => {
    const preview = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
    const card = renderToolApprovalCard({ tool: "write_file", cwd: "/tmp/project", preview }, false);

    expect(card).toContain("line 17");
    expect(card).not.toContain("line 18");
    expect(card).toContain("省略 7 行");
  });
});
