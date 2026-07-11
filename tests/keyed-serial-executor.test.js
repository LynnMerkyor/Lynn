import { describe, expect, it, vi } from "vitest";

import { createKeyedSerialExecutor } from "../server/chat/keyed-serial-executor.js";

describe("keyed serial executor", () => {
  it("serializes work for one session while allowing another session to proceed", async () => {
    const runSerial = createKeyedSerialExecutor();
    let releaseFirst;
    const order = [];
    const first = runSerial("session-a", async () => {
      order.push("a1-start");
      await new Promise((resolve) => { releaseFirst = resolve; });
      order.push("a1-end");
    });
    const second = runSerial("session-a", async () => { order.push("a2"); });
    const other = runSerial("session-b", async () => { order.push("b1"); });

    await vi.waitFor(() => expect(order).toEqual(["a1-start", "b1"]));
    releaseFirst();
    await Promise.all([first, second, other]);

    expect(order).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });
});
