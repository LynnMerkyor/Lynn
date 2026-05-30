import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addCodeInputMediaFlags, prepareCodeTaskInput } from "../src/code-input.js";

describe("prepareCodeTaskInput", () => {
  it("turns pasted media paths into code-mode attachment flags", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-code-input-"));
    try {
      fs.writeFileSync(path.join(cwd, "shot.png"), "");
      const prepared = prepareCodeTaskInput('fix this UI "./shot.png"', cwd, "Analyze the attachment.");

      expect(prepared.task).toBe("fix this UI");
      expect(prepared.mediaPaths).toEqual([path.join(cwd, "shot.png")]);
      expect(prepared.contextSummary).toContain("shot.png");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses a default task when the user only pasted an attachment", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-code-input-only-"));
    try {
      fs.writeFileSync(path.join(cwd, "clip.mp4"), "");
      const prepared = prepareCodeTaskInput("./clip.mp4", cwd, "Analyze the attachment.");

      expect(prepared.task).toBe("Analyze the attachment.");
      expect(prepared.mediaPaths).toEqual([path.join(cwd, "clip.mp4")]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("addCodeInputMediaFlags", () => {
  it("preserves existing --images values while adding pasted media", () => {
    expect(addCodeInputMediaFlags({ images: "/tmp/a.png", approval: "ask" }, ["/tmp/b.wav"])).toEqual({
      images: "/tmp/a.png;/tmp/b.wav",
      approval: "ask",
    });
  });
});
