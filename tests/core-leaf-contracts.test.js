import { describe, expect, it } from "vitest";

import { WELL_KNOWN_SKILL_PATHS } from "../core/constants.js";
import { LynnProgressParser, MoodParser } from "../core/events.js";

describe("core leaf contracts", () => {
  it("keeps well-known skill path entries stable", () => {
    expect(WELL_KNOWN_SKILL_PATHS).toEqual(
      expect.arrayContaining([
        { suffix: ".codex/skills", label: "Codex" },
        { suffix: ".claude/skills", label: "Claude Code" },
      ]),
    );
  });

  it("parses split mood tags without leaking held prefixes", () => {
    const parser = new MoodParser();
    const events = [];
    const emit = (evt) => events.push(evt);

    parser.feed("hello <mo", emit);
    parser.feed("od>inner</mood>\nworld", emit);
    parser.flush(emit);

    expect(events).toEqual([
      { type: "text", data: "hello " },
      { type: "mood_start" },
      { type: "mood_text", data: "inner" },
      { type: "mood_end" },
      { type: "text", data: "world" },
    ]);
  });

  it("extracts Lynn progress markers while preserving visible text", () => {
    const parser = new LynnProgressParser();
    const events = [];
    const emit = (evt) => events.push(evt);

    parser.feed("a <lynn_tool_progress event=\"start\" name=\"web_search\"></lynn_tool_progress>b", emit);
    parser.flush(emit);

    expect(events).toEqual([
      { type: "text", data: "a " },
      { type: "tool_progress", event: "start", name: "web_search", ms: undefined, ok: undefined },
      { type: "text", data: "b" },
    ]);
  });
});
