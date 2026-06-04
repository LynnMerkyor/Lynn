import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createWakeLockController } = require("../wake-lock-controller.cjs");

function fakeBlocker() {
  const started = new Set<number>();
  let next = 1;
  return {
    started,
    start: () => { const id = next++; started.add(id); return id; },
    stop: (id: number) => { started.delete(id); },
    isStarted: (id: number) => started.has(id),
  };
}
const quietLogger = { log() {}, warn() {} };

describe("createWakeLockController", () => {
  it("starts a blocker when the first reason is added, stops it when the last clears", () => {
    const pb = fakeBlocker();
    const c = createWakeLockController({ powerSaveBlocker: pb, logger: quietLogger });
    expect(c.state().active).toBe(false);

    let st = c.set("voice", true);
    expect(st.active).toBe(true);
    expect(st.reasons).toEqual(["voice"]);
    expect(pb.started.size).toBe(1);

    st = c.set("voice", false);
    expect(st.active).toBe(false);
    expect(st.reasons).toEqual([]);
    expect(pb.started.size).toBe(0);
  });

  it("ref-counts multiple reasons under a single blocker", () => {
    const pb = fakeBlocker();
    const c = createWakeLockController({ powerSaveBlocker: pb, logger: quietLogger });
    c.set("voice", true);
    c.set("download", true);
    expect(pb.started.size).toBe(1); // still one blocker
    expect(c.state().reasons.sort()).toEqual(["download", "voice"]);

    c.set("voice", false);
    expect(c.state().active).toBe(true); // download still holds it
    c.set("download", false);
    expect(c.state().active).toBe(false);
  });

  it("clear() drops all reasons and releases the blocker", () => {
    const pb = fakeBlocker();
    const c = createWakeLockController({ powerSaveBlocker: pb, logger: quietLogger });
    c.set("a", true); c.set("b", true);
    const st = c.clear();
    expect(st.active).toBe(false);
    expect(st.reasons).toEqual([]);
    expect(pb.started.size).toBe(0);
  });

  it("ignores empty reasons", () => {
    const pb = fakeBlocker();
    const c = createWakeLockController({ powerSaveBlocker: pb, logger: quietLogger });
    expect(c.set("  ", true).active).toBe(false);
    expect(pb.started.size).toBe(0);
  });
});
