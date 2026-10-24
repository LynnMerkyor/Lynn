import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFileTool } from "../src/tools/edit.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { clearReadState } from "../src/tools/read-state.js";

let tmp = "";
const ctx = () => ({ cwd: tmp, approval: "yolo" as const });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-edit-"));
  clearReadState();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  clearReadState();
  delete process.env.LYNN_CLI_SKIP_READ_GATE;
});

async function seed(relative: string, text: string): Promise<string> {
  const file = path.join(tmp, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
  return file;
}

describe("edit tool", () => {
  it("refuses to edit a file the model has not read", async () => {
    await seed("a.ts", "export const a = 1;\n");
    await expect(editFileTool(ctx(), { path: "a.ts", old_string: "1", new_string: "2" }))
      .rejects.toThrow(/read a\.ts with read_file/);
  });

  it("edits a read file and reports a preview", async () => {
    await seed("a.ts", "const a = 1;\nconst b = 2;\n");
    await readFileTool(ctx(), "a.ts");
    const result = await editFileTool(ctx(), { path: "a.ts", old_string: "const b = 2;", new_string: "const b = 3;" });
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");
    const output = result.output as { preview: string; replacements: number; line: number; mtimeMs: number; mtime: string };
    expect(output.replacements).toBe(1);
    expect(output.line).toBe(2);
    expect(output.preview).toContain("- const b = 2;");
    expect(output.preview).toContain("+ const b = 3;");
    const stat = await fs.stat(path.join(tmp, "a.ts"));
    expect(output.mtimeMs).toBe(stat.mtimeMs);
    expect(output.mtime).toBe(new Date(stat.mtimeMs).toISOString());
  });

  it("refuses an ambiguous old_string unless replace_all is set", async () => {
    await seed("a.ts", "x\nx\n");
    await readFileTool(ctx(), "a.ts");
    await expect(editFileTool(ctx(), { path: "a.ts", old_string: "x", new_string: "y" }))
      .rejects.toThrow(/appears 2 times/);
    const result = await editFileTool(ctx(), { path: "a.ts", old_string: "x", new_string: "y", replace_all: true });
    expect((result.output as { replacements: number }).replacements).toBe(2);
    expect(await fs.readFile(path.join(tmp, "a.ts"), "utf8")).toBe("y\ny\n");
  });

  it("fails with a useful message when the context does not match", async () => {
    await seed("a.ts", "const a = 1;\n");
    await readFileTool(ctx(), "a.ts");
    await expect(editFileTool(ctx(), { path: "a.ts", old_string: "const a = 99;", new_string: "x" }))
      .rejects.toThrow(/old_string does not appear/);
  });

  it("refuses an edit when the file changed after the read", async () => {
    await seed("a.ts", "one\n");
    await readFileTool(ctx(), "a.ts");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(tmp, "a.ts"), "two\n", "utf8");
    await expect(editFileTool(ctx(), { path: "a.ts", old_string: "one", new_string: "three" }))
      .rejects.toThrow(/changed on disk/);
  });

  it("preserves CRLF line endings", async () => {
    await seed("a.ts", "a\r\nb\r\n");
    await readFileTool(ctx(), "a.ts");
    await editFileTool(ctx(), { path: "a.ts", old_string: "b", new_string: "c" });
    expect(await fs.readFile(path.join(tmp, "a.ts"), "utf8")).toBe("a\r\nc\r\n");
  });

  it("requires approval", async () => {
    await seed("a.ts", "a\n");
    await expect(editFileTool({ cwd: tmp, approval: "ask" }, { path: "a.ts", old_string: "a", new_string: "b" }))
      .rejects.toThrow(/requires approval/);
  });
});

describe("read dedupe", () => {
  it("returns a stub for an unchanged re-read", async () => {
    await seed("a.ts", "hello\n");
    const first = await readFileTool(ctx(), "a.ts");
    expect((first.output as { text?: string }).text).toBe("hello\n");
    const second = await readFileTool(ctx(), "a.ts");
    expect(second.output).toMatchObject({ unchanged: true });
    expect((second.output as { text?: string }).text).toBeUndefined();
  });

  it("returns fresh content after the file changes", async () => {
    const file = await seed("a.ts", "one\n");
    await readFileTool(ctx(), "a.ts");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(file, "two\n", "utf8");
    const result = await readFileTool(ctx(), "a.ts");
    expect((result.output as { text?: string }).text).toBe("two\n");
  });

  it("does not dedupe a truncated read", async () => {
    await seed("a.ts", "0123456789");
    const first = await readFileTool(ctx(), "a.ts", 4);
    expect((first.output as { truncated: boolean }).truncated).toBe(true);
    const second = await readFileTool(ctx(), "a.ts", 4);
    expect((second.output as { text?: string }).text).toBe("0123");
  });
});

describe("write safety", () => {
  it("warns when overwriting a file that was never read", async () => {
    await seed("a.ts", "old\n");
    const result = await writeFileTool(ctx(), "a.ts", "new\n");
    expect((result.output as { warning?: string }).warning).toMatch(/without reading it/);
  });

  it("does not warn for a freshly created file", async () => {
    const result = await writeFileTool(ctx(), "new.ts", "x\n");
    expect((result.output as { warning?: string }).warning).toBeUndefined();
  });
});
