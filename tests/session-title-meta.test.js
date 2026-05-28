import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSessionTitlesFor,
  saveSessionMetaFile,
  saveSessionTitleFile,
} from "../core/session-title-meta.js";

describe("session title/meta helpers", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempAgent() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-session-title-meta-"));
    dirs.push(root);
    const agentsDir = path.join(root, "agents");
    const sessionDir = path.join(agentsDir, "agent-a", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    return {
      root,
      agentsDir,
      sessionDir,
      currentAgent: { id: "agent-a", sessionDir },
      agentIdFromSessionPath: () => "agent-a",
    };
  }

  it("loads titles through a copy-on-read cache", async () => {
    const agent = tempAgent();
    fs.writeFileSync(path.join(agent.sessionDir, "session-titles.json"), JSON.stringify({ a: "Alpha" }));
    const cache = new Map();

    const first = await loadSessionTitlesFor(agent.sessionDir, cache);
    first.a = "Mutated";
    const second = await loadSessionTitlesFor(agent.sessionDir, cache);

    expect(second).toEqual({ a: "Alpha" });
  });

  it("writes session titles and refreshes the title cache", async () => {
    const agent = tempAgent();
    const cache = new Map();
    const sessionPath = path.join(agent.sessionDir, "a.jsonl");

    await saveSessionTitleFile(sessionPath, "New Title", { ...agent, titlesCache: cache });

    const raw = JSON.parse(fs.readFileSync(path.join(agent.sessionDir, "session-titles.json"), "utf-8"));
    expect(raw[sessionPath]).toBe("New Title");
    expect(cache.get(agent.sessionDir).titles[sessionPath]).toBe("New Title");
  });

  it("merges session meta without dropping existing fields", async () => {
    const agent = tempAgent();
    const sessionPath = path.join(agent.sessionDir, "a.jsonl");
    fs.writeFileSync(path.join(agent.sessionDir, "session-meta.json"), JSON.stringify({
      [sessionPath]: { memoryEnabled: true, modelId: "old" },
    }));

    await saveSessionMetaFile(sessionPath, { modelId: "new" }, agent);

    const raw = JSON.parse(fs.readFileSync(path.join(agent.sessionDir, "session-meta.json"), "utf-8"));
    expect(raw[sessionPath]).toEqual({ memoryEnabled: true, modelId: "new" });
  });
});
