import { describe, expect, it, vi } from "vitest";
import { evaluateRetained } from "../scripts/cdp-evaluate.js";

describe("retained CDP evaluation", () => {
  it("pins a Promise, waits once and releases its object group", async () => {
    const call = vi.fn().mockResolvedValueOnce({ result: { objectId: "promise-1", subtype: "promise" } })
      .mockResolvedValueOnce({ result: { value: "ready" } }).mockResolvedValueOnce({});
    expect(await evaluateRetained(call, "window.clickCount++; document.fonts.ready")).toBe("ready");
    expect(call.mock.calls.map(([method]) => method)).toEqual(["Runtime.evaluate", "Runtime.awaitPromise", "Runtime.releaseObjectGroup"]);
    expect(call.mock.calls[0][1]).toMatchObject({ awaitPromise: false, returnByValue: false });
    expect(call.mock.calls[1][1]).toEqual({ promiseObjectId: "promise-1", returnByValue: true });
    expect(call.mock.calls[2][1].objectGroup).toBe(call.mock.calls[0][1].objectGroup);
  });

  it("preserves plain values and object snapshots", async () => {
    const scalar = vi.fn().mockResolvedValueOnce({ result: { value: false } }).mockResolvedValueOnce({});
    expect(await evaluateRetained(scalar, "false")).toBe(false);
    const object = vi.fn().mockResolvedValueOnce({ result: { objectId: "snapshot" } })
      .mockResolvedValueOnce({ result: { value: { overflow: 0 } } }).mockResolvedValueOnce({});
    expect(await evaluateRetained(object, "({overflow: 0})")).toEqual({ overflow: 0 });
    expect(object.mock.calls[1][0]).toBe("Runtime.callFunctionOn");
  });

  it("releases rejected promises without repeating side effects", async () => {
    const call = vi.fn().mockResolvedValueOnce({ result: { objectId: "promise-1", subtype: "promise" } })
      .mockResolvedValueOnce({ exceptionDetails: { text: "Uncaught", exception: { description: "Error: rejected" } } })
      .mockResolvedValueOnce({});
    await expect(evaluateRetained(call, "startOperation()" )).rejects.toThrow("rejected");
    expect(call.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(1);
    expect(call.mock.calls.at(-1)?.[0]).toBe("Runtime.releaseObjectGroup");
  });
});
