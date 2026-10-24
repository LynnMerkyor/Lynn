import { describe, expect, it } from "vitest";
import { afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { looksLikeSlashCommand } from "../src/completion.js";
import { setLang } from "../src/i18n.js";
import {
  analyzePastedContext,
  appendPastedText,
  normalizePastedText,
  parseImagePromptCommand,
  summarizeImageRefs,
  summarizePastedContext,
} from "../src/pasted-context.js";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

describe("pasted context helpers", () => {
  const slash = (value: string) => value.replace(/\\/g, "/");

  it("normalizes CRLF and appends pasted blocks without losing lines", () => {
    expect(normalizePastedText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(appendPastedText("prefix", "line1\nline2")).toBe("prefix\nline1\nline2");
  });

  it("extracts image paths and keeps surrounding prompt text", () => {
    const info = analyzePastedContext('请看 "./screens/a.png"\n以及 /tmp/b.webp', "/repo");

    expect(info.text).toBe("请看\n以及");
    expect(info.imageRefs.map((ref) => slash(ref.path))).toEqual([
      slash(path.resolve("/repo", "screens/a.png")),
      slash(path.resolve("/tmp/b.webp")),
    ]);
    expect(summarizePastedContext(info)).toContain("2 attachments");
    expect(summarizePastedContext(info)).toContain("a.png");
    expect(summarizePastedContext(info)).toContain("b.webp");
    expect(summarizePastedContext(info)).toContain("2 lines");
  });

  it("summarizes multi-line text as context", () => {
    const info = analyzePastedContext("第一段\n第二行\n\n第二段");

    expect(info.hasContext).toBe(true);
    expect(info.lineCount).toBe(3);
    expect(info.segmentCount).toBe(2);
    expect(summarizePastedContext(info)).toBe("3 lines · 2 segments");
  });

  it("parses explicit image slash commands with prompt text", () => {
    const command = parseImagePromptCommand('/image "./screen shot.png" explain this', "/repo");

    expect(command).toMatchObject({
      command: "/image",
      prompt: "explain this",
    });
    expect(command?.imageRefs.map((ref) => slash(ref.path))).toEqual([slash(path.resolve("/repo", "screen shot.png"))]);
    expect(summarizeImageRefs(command?.imageRefs || [])).toBe("1 attachment: screen shot.png");
  });

  it("uses a default prompt for image commands without text", () => {
    const command = parseImagePromptCommand("/attach /tmp/a.png");

    expect(command?.prompt).toBe("Please analyze these images.");
    expect(command?.imageRefs.map((ref) => slash(ref.path))).toEqual([slash(path.resolve("/tmp/a.png"))]);
  });

  it("summarizes pasted context in Chinese when the CLI language is zh", () => {
    setLang("zh");
    const info = analyzePastedContext("第一段\n第二行\n/tmp/a.png");

    expect(summarizePastedContext(info)).toBe("1 个附件: a.png · 2 行");
  });

  it("extracts a dragged path that contains spaces", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-drag-"));
    try {
      const file = path.join(tmp, "screen shot.png");
      await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const alone = analyzePastedContext(file, tmp);
      expect(alone.imageRefs).toHaveLength(1);
      expect(alone.imageRefs[0]!.path).toBe(file);
      expect(alone.text).toBe("");

      const withPrompt = analyzePastedContext(`看这个 ${file}`, tmp);
      expect(withPrompt.imageRefs).toHaveLength(1);
      expect(withPrompt.imageRefs[0]!.path).toBe(file);
      expect(withPrompt.text).toBe("看这个");

      const withTrailingPrompt = analyzePastedContext(`${file} describe it`, tmp);
      expect(withTrailingPrompt.imageRefs).toHaveLength(1);
      expect(withTrailingPrompt.imageRefs[0]!.path).toBe(file);
      expect(withTrailingPrompt.text).toBe("describe it");

      const command = parseImagePromptCommand(`/image ${file} describe it`, tmp);
      expect(command?.imageRefs).toHaveLength(1);
      expect(command?.imageRefs[0]!.path).toBe(file);
      expect(command?.prompt).toBe("describe it");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("treats a dragged absolute image path as pasted context, not a slash command", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-drag-"));
    try {
      const file = path.join(dir, "screen shot.png");
      await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const info = analyzePastedContext(`看这个 ${file}`, dir);
      expect(info.imageRefs).toHaveLength(1);
      expect(info.imageRefs[0]!.path).toBe(file);
      expect(info.text).toBe("看这个");
      expect(looksLikeSlashCommand(file)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
