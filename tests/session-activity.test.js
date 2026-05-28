import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promoteActivitySessionFile } from "../core/session-activity.js";

describe("session activity helpers", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempAgent() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-session-activity-"));
    dirs.push(root);
    const agentDir = path.join(root, "agent");
    const activityDir = path.join(agentDir, "activity");
    const sessionDir = path.join(agentDir, "sessions");
    fs.mkdirSync(activityDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    return { agentDir, activityDir, sessionDir };
  }

  it("promotes an activity session into normal sessions and notifies memory", () => {
    const agent = tempAgent();
    const notifyPromoted = vi.fn();
    fs.writeFileSync(path.join(agent.activityDir, "a.jsonl"), "{}\n");

    const result = promoteActivitySessionFile("a.jsonl", {
      ...agent,
      _memoryTicker: { notifyPromoted },
    });

    expect(result).toBe(path.join(agent.sessionDir, "a.jsonl"));
    expect(fs.existsSync(path.join(agent.activityDir, "a.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(agent.sessionDir, "a.jsonl"))).toBe(true);
    expect(notifyPromoted).toHaveBeenCalledWith(path.join(agent.sessionDir, "a.jsonl"));
  });

  it("returns null when the activity session does not exist", () => {
    const agent = tempAgent();
    expect(promoteActivitySessionFile("missing.jsonl", agent)).toBe(null);
  });
});
