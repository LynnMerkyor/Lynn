import { describe, expect, it } from "vitest";
import { splitInkStaticHistory } from "../src/ink-static-history.js";

describe("Ink Static history", () => {
  it("does not insert a completed tool before earlier pending output", () => {
    const items = [
      { id: "user" },
      { id: "assistant", pending: true },
      { id: "reasoning", pending: true },
      { id: "tool", pending: false },
    ];

    const split = splitInkStaticHistory(items);
    expect(split.settledItems.map((item) => item.id)).toEqual(["user"]);
    expect(split.activeItems.map((item) => item.id)).toEqual(["assistant", "reasoning", "tool"]);
  });

  it("releases all items in order after the pending prefix settles", () => {
    const split = splitInkStaticHistory([
      { id: "user" },
      { id: "assistant", pending: false },
      { id: "reasoning", pending: false },
      { id: "tool", pending: false },
    ]);

    expect(split.settledItems.map((item) => item.id)).toEqual(["user", "assistant", "reasoning", "tool"]);
    expect(split.activeItems).toEqual([]);
  });
});
