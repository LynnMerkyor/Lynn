import { describe, expect, it, vi } from "vitest";
import { generateSessionTitle } from "../server/chat/title-generator.js";

function makeEngine(overrides = {}) {
  return {
    currentSessionPath: "/sessions/current.jsonl",
    listSessions: vi.fn(async () => []),
    getSessionByPath: vi.fn(() => ({
      messages: [
        { role: "user", content: "帮我规划杭州两日游" },
        { role: "assistant", content: "可以安排西湖、滨江和良渚。" },
      ],
    })),
    summarizeTitle: vi.fn(async () => "杭州两日游规划"),
    saveSessionTitle: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("generateSessionTitle", () => {
  it("saves and broadcasts the summarized title", async () => {
    const engine = makeEngine();
    const notify = vi.fn();

    await expect(generateSessionTitle(engine, notify)).resolves.toBe(true);

    expect(engine.summarizeTitle).toHaveBeenCalledWith(
      "帮我规划杭州两日游",
      "可以安排西湖、滨江和良渚。",
      { timeoutMs: 15_000 },
    );
    expect(engine.saveSessionTitle).toHaveBeenCalledWith("/sessions/current.jsonl", "杭州两日游规划");
    expect(notify).toHaveBeenCalledWith({
      type: "session_title",
      title: "杭州两日游规划",
      path: "/sessions/current.jsonl",
    });
  });

  it("keeps existing titled sessions untouched", async () => {
    const engine = makeEngine({
      listSessions: vi.fn(async () => [{ path: "/sessions/current.jsonl", title: "Existing" }]),
    });
    const notify = vi.fn();

    await expect(generateSessionTitle(engine, notify)).resolves.toBe(true);

    expect(engine.getSessionByPath).not.toHaveBeenCalled();
    expect(engine.saveSessionTitle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("uses the original user-text fallback when summarization is empty", async () => {
    const engine = makeEngine({
      summarizeTitle: vi.fn(async () => ""),
    });
    const notify = vi.fn();

    await expect(generateSessionTitle(engine, notify)).resolves.toBe(true);

    expect(engine.saveSessionTitle).toHaveBeenCalledWith("/sessions/current.jsonl", "帮我规划杭州两日游");
    expect(notify).toHaveBeenCalledWith({
      type: "session_title",
      title: "帮我规划杭州两日游",
      path: "/sessions/current.jsonl",
    });
  });
});
