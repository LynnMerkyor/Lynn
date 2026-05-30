import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBrainProjectDir } from "../src/commands/brain.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-brain-command-"));
  tmpDirs.push(dir);
  return dir;
}

describe("brain command", () => {
  it("resolves an explicit brain-v2-mirror project directory", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(dir, "server.ts"), "export {};\n");

    expect(resolveBrainProjectDir(dir)).toMatchObject({ dir });
  });

  it("reports all checked candidates when no brain project exists", () => {
    const dir = makeDir();
    const result = resolveBrainProjectDir(path.join(dir, "missing"));
    expect(result.dir).toBe(null);
    expect(result.checked[0]).toBe(path.join(dir, "missing"));
  });
});
