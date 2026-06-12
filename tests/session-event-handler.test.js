import { describe, expect, it, vi } from "vitest";
import { createSessionEventHandler } from "../core/session-event-handler.js";

function makeHandler(overrides = {}) {
  const entry = {
    agentId: "hana",
    compactionCount: 0,
    relayInProgress: false,
  };
  const sessions = new Map([["/tmp/session.jsonl", entry]]);
  const emitEvent = vi.fn();
  const relaySession = vi.fn(async () => {});
  const handler = createSessionEventHandler({
    mapKey: "/tmp/session.jsonl",
    sessionPath: "/tmp/session.jsonl",
    sessions,
    getCurrentSessionPath: () => "/tmp/session.jsonl",
    getAgent: () => ({}),
    getAgentById: () => ({}),
    resolveSessionRelayConfig: () => ({ enabled: true, compactionThreshold: 2 }),
    relaySession,
    emitEvent,
    ...overrides,
  });
  return { entry, emitEvent, handler, relaySession };
}

describe("session event handler", () => {
  it("keeps forwarding all session events", () => {
    const { emitEvent, handler } = makeHandler();
    const event = { type: "message_delta", text: "hello" };

    handler(event);

    expect(emitEvent).toHaveBeenCalledWith(event, "/tmp/session.jsonl");
  });

  it("triggers relay only after compaction threshold on the active session", () => {
    const { entry, handler, relaySession } = makeHandler();

    handler({ type: "auto_compaction_end" });
    expect(entry.compactionCount).toBe(1);
    expect(relaySession).not.toHaveBeenCalled();

    handler({ type: "auto_compaction_end" });
    expect(entry.compactionCount).toBe(2);
    expect(relaySession).toHaveBeenCalledWith("/tmp/session.jsonl", 2);
  });

  it("records a bounded failure hint for missing files", () => {
    const { entry, handler } = makeHandler();

    handler({
      type: "tool_execution_end",
      toolName: "read",
      isError: true,
      result: {
        content: [{ type: "text", text: "ENOENT: no such file or directory, open '/tmp/missing.txt'" }],
      },
    });

    expect(entry._toolFailCount).toBe(1);
    expect(entry._toolFailDegraded).toBe(false);
    expect(entry._lastRecallContext).toContain("read");
    expect(entry._lastRecallContext).toContain("ENOENT");
  });

  it("suppresses Brain-managed local realtime tool echoes", () => {
    const { entry, emitEvent, handler } = makeHandler();
    entry.modelProvider = "brain";

    handler({
      type: "tool_execution_start",
      toolCallId: "tc-market",
      toolName: "stock_market",
      args: { query: "黄金价格" },
    });
    handler({
      type: "tool_execution_end",
      toolCallId: "tc-market",
      toolName: "stock_market",
      isError: true,
      result: {
        content: [{ type: "text", text: "Tool stock_market not found" }],
        isError: true,
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(entry._toolFailCount).toBeUndefined();
    expect(entry._lastRecallContext).toBeUndefined();
  });
});
