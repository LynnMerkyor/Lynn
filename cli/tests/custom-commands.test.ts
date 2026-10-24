import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandCommand,
  loadCustomCommands,
  parseCommandFile,
  resolveCustomCommand,
} from "../src/custom-commands.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cmd-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("custom commands", () => {
  it("parses frontmatter and keeps the body", () => {
    const parsed = parseCommandFile("---\ndescription: Deploy it\nname: ship\n---\nDo $1 now", "fallback");
    expect(parsed).toEqual({ name: "ship", description: "Deploy it", body: "Do $1 now" });
    expect(parseCommandFile("plain body", "plain")).toEqual({ name: "plain", description: "", body: "plain body" });
  });

  it("expands $ARGUMENTS, positional args, and appends args without a placeholder", () => {
    expect(expandCommand({ body: "Deploy $1 to $2. All: $ARGUMENTS" }, "api staging")).toBe("Deploy api to staging. All: api staging");
    expect(expandCommand({ body: "Run the checks" }, "quick")).toBe("Run the checks\n\nArguments: quick");
    expect(expandCommand({ body: "Missing $3 here" }, "a b")).toBe("Missing  here");
  });

  it("loads user and project commands with project precedence", async () => {
    const dataDir = path.join(tmp, "data");
    await fs.mkdir(path.join(dataDir, "commands"), { recursive: true });
    await fs.mkdir(path.join(tmp, "repo", ".lynn", "commands"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "commands", "deploy.md"), "---\ndescription: user deploy\n---\nuser body", "utf8");
    await fs.writeFile(path.join(tmp, "repo", ".lynn", "commands", "deploy.md"), "---\ndescription: project deploy\n---\nproject body", "utf8");
    await fs.writeFile(path.join(tmp, "repo", ".lynn", "commands", "lint.md"), "---\ndescription: lint\n---\nlint body", "utf8");

    const commands = await loadCustomCommands(path.join(tmp, "repo"), dataDir);
    expect(commands.map((command) => command.name).sort()).toEqual(["deploy", "lint"]);
    expect(commands.find((command) => command.name === "deploy")).toMatchObject({ source: "project", body: "project body" });
  });

  it("resolves a submitted slash command into a prompt", async () => {
    const dataDir = path.join(tmp, "data");
    await fs.mkdir(path.join(dataDir, "commands"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "commands", "ship.md"), "Ship $ARGUMENTS", "utf8");

    await expect(resolveCustomCommand("/ship api", tmp, dataDir)).resolves.toMatchObject({
      command: { name: "ship" },
      prompt: "Ship api",
    });
    await expect(resolveCustomCommand("/missing api", tmp, dataDir)).resolves.toBeNull();
    await expect(resolveCustomCommand("no slash", tmp, dataDir)).resolves.toBeNull();
  });
});
