import { describe, expect, it, vi } from "vitest";
import {
  formatRelaySummaryContext,
  resolveSessionRelayConfig,
  runSessionRelay,
} from "../core/session-relay.js";

describe("session relay helpers", () => {
  it("uses smaller auto-relay thresholds for smaller context windows", () => {
    expect(resolveSessionRelayConfig({}, { contextWindow: 8_000 }).compactionThreshold).toBe(1);
    expect(resolveSessionRelayConfig({}, { contextWindow: 24_000 }).compactionThreshold).toBe(2);
    expect(resolveSessionRelayConfig({}, { contextWindow: 64_000 }).compactionThreshold).toBe(3);
  });

  it("lets explicit preferences override defaults", () => {
    expect(resolveSessionRelayConfig({
      enabled: false,
      compaction_threshold: 7,
      summary_max_tokens: 1200,
    }, { contextWindow: 8_000 })).toMatchObject({
      enabled: false,
      compactionThreshold: 7,
      summaryMaxTokens: 1200,
    });
  });

  it("formats localized relay context without overlong summaries", () => {
    const zh = formatRelaySummaryContext("继续做 A", "zh-CN");
    expect(zh).toContain("自动接力摘要");
    expect(zh).toContain("继续做 A");

    const en = formatRelaySummaryContext("x".repeat(4100), "en-US");
    expect(en).toContain("Automatic Session Relay Summary");
    expect(en.length).toBeLessThan(4300);
  });

  it("creates a relay session and resets relay state", async () => {
    const sessions = new Map([
      ["old.jsonl", {
        session: { sessionManager: { getCwd: () => "/tmp/workspace" } },
        memoryEnabled: true,
        planMode: true,
        securityMode: "safe",
        relayInProgress: false,
        compactionCount: 3,
      }],
    ]);
    const emitEvent = vi.fn();
    const applySessionToolRuntime = vi.fn();

    const ok = await runSessionRelay({
      sessionPath: "old.jsonl",
      compactionCount: 3,
      sessions,
      currentSessionPath: "old.jsonl",
      getCurrentSessionPath: () => "new.jsonl",
      relayConfig: { enabled: true, compactionThreshold: 3, summaryMaxTokens: 800 },
      defaultSecurityMode: "execute",
      summarize: vi.fn(async () => "keep going"),
      resolveModel: vi.fn(() => ({ id: "m" })),
      resolveCwd: (entry) => entry.session.sessionManager.getCwd(),
      createSession: vi.fn(async () => {
        sessions.set("new.jsonl", {});
        return { sessionManager: { getSessionFile: () => "new.jsonl" } };
      }),
      formatSummaryContext: (summary) => `ctx:${summary}`,
      applySessionToolRuntime,
      emitEvent,
    });

    expect(ok).toBe(true);
    expect(sessions.get("new.jsonl")).toMatchObject({
      _relaySummaryContext: "ctx:keep going",
      compactionCount: 0,
      securityMode: "safe",
      planMode: true,
      memoryEnabled: true,
    });
    expect(sessions.get("old.jsonl")).toMatchObject({
      relayInProgress: false,
      compactionCount: 0,
    });
    expect(applySessionToolRuntime).toHaveBeenCalledWith("new.jsonl", "safe");
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "session_relay",
      oldSessionPath: "old.jsonl",
      newSessionPath: "new.jsonl",
    }), "new.jsonl");
  });
});
