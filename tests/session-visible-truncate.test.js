import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { truncateSessionBeforeVisibleMessage } from "../core/session-visible-truncate.js";

function makeEntry(type, extra) {
  return { type, id: extra.id, parentId: extra.parentId ?? null, timestamp: "2026-06-13T00:00:00.000Z", ...extra };
}

function messagesFromEntries(entries) {
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

describe("session visible message truncation", () => {
  it("truncates persistent history before the edited user message and refreshes runtime messages", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-session-truncate-"));
    const sessionPath = path.join(tmpDir, "session.jsonl");
    const entries = [
      { type: "session", version: 3, id: "session-1", timestamp: "2026-06-13T00:00:00.000Z", cwd: tmpDir },
      makeEntry("message", { id: "u1", message: { role: "user", content: "旧问题" } }),
      makeEntry("message", { id: "a1", parentId: "u1", message: { role: "assistant", content: "旧回答" } }),
      makeEntry("message", { id: "u2", parentId: "a1", message: { role: "user", content: "要编辑的问题" } }),
      makeEntry("message", { id: "a2", parentId: "u2", message: { role: "assistant", content: "后续回答" } }),
    ];
    await fs.writeFile(sessionPath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const manager = {
      fileEntries: [...entries],
      _buildIndex: vi.fn(function buildIndex() {
        this.leafId = this.fileEntries.at(-1)?.id ?? null;
      }),
      buildSessionContext: vi.fn(function buildSessionContext() {
        return { messages: messagesFromEntries(this.fileEntries) };
      }),
    };
    const session = {
      sessionManager: manager,
      messages: messagesFromEntries(entries),
      agent: { replaceMessages: vi.fn() },
    };

    const result = truncateSessionBeforeVisibleMessage(session, sessionPath, "2");

    expect(result).toEqual({ ok: true });
    expect(manager.fileEntries.map(entry => entry.id)).toEqual(["session-1", "u1", "a1"]);
    expect(session.agent.replaceMessages).toHaveBeenCalledWith([
      { role: "user", content: "旧问题" },
      { role: "assistant", content: "旧回答" },
    ]);
    const persisted = (await fs.readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(persisted.map(entry => entry.id)).toEqual(["session-1", "u1", "a1"]);
  });

  it("refuses to truncate when the selected visible message is not a user message", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-session-truncate-"));
    const sessionPath = path.join(tmpDir, "session.jsonl");
    const entries = [
      { type: "session", version: 3, id: "session-1", timestamp: "2026-06-13T00:00:00.000Z", cwd: tmpDir },
      makeEntry("message", { id: "u1", message: { role: "user", content: "旧问题" } }),
      makeEntry("message", { id: "a1", parentId: "u1", message: { role: "assistant", content: "旧回答" } }),
    ];
    await fs.writeFile(sessionPath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const result = truncateSessionBeforeVisibleMessage({ sessionManager: { fileEntries: [...entries] } }, sessionPath, "1");

    expect(result).toEqual({ ok: false, reason: "target-not-user-message" });
    const persisted = await fs.readFile(sessionPath, "utf8");
    expect(persisted).toContain("旧回答");
  });
});
