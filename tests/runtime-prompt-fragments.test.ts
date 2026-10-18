import { describe, expect, it } from "vitest";
import { maybeString } from "../core/agent-runtime/session-fallback-helpers.js";

describe("runtime prompt fragments", () => {
  it("keeps string instructions intact", async () => {
    expect(await maybeString("Keep names intact.\nKeep dates intact.")).toBe("Keep names intact.\nKeep dates intact.");
  });

  it("joins synchronous and asynchronous instruction arrays in order", async () => {
    const fragments = ["Existing instruction", "保留原文", "Tool boundaries"];
    expect(await maybeString(fragments)).toBe(fragments.join("\n\n"));
    expect(await maybeString(Promise.resolve(fragments))).toBe(fragments.join("\n\n"));
  });

  it("ignores unsupported fragments rather than serializing objects into instructions", async () => {
    expect(await maybeString([null, {}, false, 42, "", "  ", "valid"])).toBe("valid");
    expect(await maybeString(undefined)).toBe("");
  });
});
