import { describe, expect, it, vi } from "vitest";
import { Hub } from "../hub/index.js";

describe("Hub owner request provenance", () => {
  it("preserves the original request through both desktop routes", async () => {
    const engine = {
      agentsDir: "/tmp/agents", channelsDir: "/tmp/channels",
      productDir: "/tmp/product", userDir: "/tmp/user",
      getAgent: vi.fn(), setEventBus: vi.fn(),
      prompt: vi.fn(async () => "ok"), promptSession: vi.fn(async () => "ok"),
      executeExternalMessage: vi.fn(async () => null), executeIsolated: vi.fn(async () => null),
      abort: vi.fn(async () => null), abortSession: vi.fn(async () => null), dispose: vi.fn(async () => null),
    };
    const hub = new Hub({ engine });
    const originalUserText = "Summarize example.com";
    const augmented = `${originalUserText}\nRetrieved material: quoted third-party content`;
    await hub.send(augmented, { originalUserText });
    expect(engine.prompt).toHaveBeenCalledWith(augmented, expect.objectContaining({ originalUserText }));
    await hub.send(augmented, { sessionPath: "/tmp/session.jsonl", originalUserText });
    expect(engine.promptSession).toHaveBeenCalledWith("/tmp/session.jsonl", augmented, expect.objectContaining({ originalUserText }));
    await hub.send("ordinary request");
    expect(engine.prompt.mock.lastCall?.[1]).not.toHaveProperty("originalUserText");
  });
});
