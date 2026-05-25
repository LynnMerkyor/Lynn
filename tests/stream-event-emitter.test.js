import { describe, expect, it, vi } from "vitest";

import { emitSessionStreamEvent } from "../server/chat/stream-event-emitter.js";

describe("stream event emitter", () => {
  it("appends stream events and broadcasts the public envelope", () => {
    const ss = {
      streamId: "stream-1",
      nextSeq: 7,
      isStreaming: true,
      startedAt: 0,
      endedAt: 0,
      events: [],
      maxEvents: 10,
    };
    const event = { type: "text_delta", text: "hello" };
    const broadcast = vi.fn();

    const entry = emitSessionStreamEvent("/tmp/session.jsonl", ss, event, broadcast);

    expect(entry).toMatchObject({
      streamId: "stream-1",
      seq: 7,
      event,
    });
    expect(ss.events).toEqual([entry]);
    expect(ss.nextSeq).toBe(8);
    expect(broadcast).toHaveBeenCalledWith({
      type: "text_delta",
      text: "hello",
      sessionPath: "/tmp/session.jsonl",
      streamId: "stream-1",
      seq: 7,
    });
  });

  it("uses session stream defaults when no stream has started", () => {
    const ss = {
      streamId: null,
      nextSeq: 1,
      isStreaming: false,
      startedAt: 0,
      endedAt: 0,
      events: [],
      maxEvents: 1,
    };
    const broadcast = vi.fn();

    const first = emitSessionStreamEvent("/tmp/session.jsonl", ss, { type: "start" }, broadcast);
    const second = emitSessionStreamEvent("/tmp/session.jsonl", ss, { type: "done" }, broadcast);

    expect(first.streamId).toMatch(/^s_/);
    expect(second.streamId).toBe(first.streamId);
    expect(ss.events).toEqual([second]);
    expect(broadcast).toHaveBeenLastCalledWith({
      type: "done",
      sessionPath: "/tmp/session.jsonl",
      streamId: first.streamId,
      seq: 2,
    });
  });
});
