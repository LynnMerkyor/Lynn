import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLocalExitText, isSafeReadOnlyShellCommand, parseLocalReadOnlyCommand, runLocalReadOnlyCommand } from "../src/local-command.js";

describe("local read-only command shortcuts", () => {
  it("recognizes local exit phrases without sending them to the model", () => {
    expect(isLocalExitText("exit")).toBe(true);
    expect(isLocalExitText("/quit")).toBe(true);
    expect(isLocalExitText("再见")).toBe(true);
    expect(isLocalExitText("再见 帮我总结")).toBe(false);
  });

  it("parses only narrow pwd/ls commands", () => {
    expect(parseLocalReadOnlyCommand("pwd")?.kind).toBe("command");
    expect(parseLocalReadOnlyCommand("ls")?.kind).toBe("command");
    expect(parseLocalReadOnlyCommand("ls -la docs")?.kind).toBe("command");
    expect(parseLocalReadOnlyCommand("ll")?.kind).toBe("command");
    expect(parseLocalReadOnlyCommand("ls /etc")?.kind).toBe("blocked");
    expect(parseLocalReadOnlyCommand("ls ..")?.kind).toBe("blocked");
    expect(parseLocalReadOnlyCommand("ls; rm -rf .")).toBeNull();
    expect(isSafeReadOnlyShellCommand("git status")).toBe(false);
  });

  it("runs pwd and ls without shelling out", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-local-cmd-"));
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "ok", "utf8");
      await fs.mkdir(path.join(dir, "sub"));
      const pwd = parseLocalReadOnlyCommand("pwd", dir);
      const ls = parseLocalReadOnlyCommand("ls", dir);
      if (pwd?.kind !== "command" || ls?.kind !== "command") throw new Error("parse failed");

      await expect(runLocalReadOnlyCommand(pwd.command)).resolves.toMatchObject({ ok: true, output: `${dir}\n` });
      const listed = await runLocalReadOnlyCommand(ls.command);
      expect(listed.ok).toBe(true);
      expect(listed.output).toContain("a.txt");
      expect(listed.output).toContain("sub/");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
