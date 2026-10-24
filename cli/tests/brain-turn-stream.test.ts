import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainStreamEvent } from "../src/brain-client.js";

const state = vi.hoisted(() => ({ script: [] as Array<BrainStreamEvent | Error> }));

vi.mock("../src/brain-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/brain-client.js")>();
  return {
    ...actual,
    streamBrainChat: async function* fakeStream() {
      for (const event of state.script) {
        if (event instanceof Error) throw event;
        yield event;
      }
    },
  };
});

const { streamBrainTurn } = await import("../src/brain-turn-stream.js");

function delta(index: number, args: string, name?: string, id?: string): BrainStreamEvent {
  return {
    type: "tool_call.delta",
    index,
    ...(name ? { name } : {}),
    ...(id ? { id } : {}),
    arguments: args,
  };
}

async function collect(script: Array<BrainStreamEvent | Error>) {
  state.script = script;
  const events = [];
  for await (const event of streamBrainTurn({
    brainUrl: "http://localhost",
    messages: [{ role: "user", content: "go" }],
    reasoning: { effort: "auto", display: "auto" } as never,
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  state.script = [];
});

describe("streamBrainTurn", () => {
  it("emits a tool call as soon as its arguments are valid JSON", async () => {
    const events = await collect([
      delta(0, '{"path":"a.ts"}', "read_file", "c1"),
      { type: "assistant.delta", text: "later text" },
      { type: "done" },
    ]);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "text", "done"]);
    expect(events[0]).toMatchObject({ index: 0, call: { id: "c1", name: "read_file" } });
  });

  it("waits for fragmented arguments to complete", async () => {
    const events = await collect([
      delta(0, '{"path":', "read_file", "c1"),
      delta(0, '"a.ts"}'),
      { type: "done" },
    ]);
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tool_call", call: { arguments: '{"path":"a.ts"}' } });
  });

  it("preserves declaration order when tool arguments are interleaved", async () => {
    const events = await collect([
      delta(0, '{"path":', "read_file", "c1"),
      delta(1, '{"pattern":"*.ts"}', "glob", "c2"),
      { type: "assistant.delta", text: "before arguments complete" },
      delta(0, '"a.ts"}'),
      { type: "done" },
    ]);
    const calls = events.filter((event) => event.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "text" });
    expect(calls[0]).toMatchObject({ index: 0, call: { arguments: '{"path":"a.ts"}' } });
    expect(calls[1]).toMatchObject({ index: 1, call: { name: "glob" } });
  });

  it("flushes an empty-argument call at the end of the stream", async () => {
    const events = await collect([delta(0, "", "update_plan", "c1"), { type: "done" }]);
    expect(events[0]).toMatchObject({ type: "tool_call", call: { arguments: "{}" } });
  });

  it("does not emit duplicate tool calls", async () => {
    const events = await collect([
      delta(0, '{"path":"a.ts"}', "read_file", "c1"),
      delta(0, " "),
      { type: "done" },
    ]);
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
  });

  it("flushes pending calls before rethrowing a transport error", async () => {
    await expect(collect([
      delta(0, '{"path":"a.ts"}', "read_file", "c1"),
      new Error("socket closed"),
    ])).rejects.toThrow("socket closed");
  });

  it("does not dispatch incomplete tools after transport failure", async () => {
    state.script = [delta(0, '{"command":"rm', "bash", "unsafe"), new Error("socket closed")];
    const events: Awaited<ReturnType<typeof collect>> = [];
    await expect((async () => {
      for await (const event of streamBrainTurn({ brainUrl: "http://localhost", messages: [], reasoning: {} as never })) events.push(event);
    })()).rejects.toThrow("socket closed");
    expect(events).toEqual([]);
  });
});
