import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  brainModelCallTimeoutMs,
  defaultModelCallTimeoutMs,
  createTimedSignal,
} from "../core/agent-runtime/session-openai-adapter.js";
import { resolveModelCallTimeouts } from "../core/agent-runtime/model-call-timeouts.js";

beforeEach(() => {
  for (const name of ["LYNN_MODEL_CALL_TIMEOUT_MS", "LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS", "LYNN_MODEL_TOTAL_TIMEOUT_MS", "LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS", "LYNN_MODEL_IDLE_TIMEOUT_MS"]) vi.stubEnv(name, "");
});

const savedShared = process.env.LYNN_MODEL_CALL_TIMEOUT_MS;
const savedBrain = process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (savedShared === undefined) delete process.env.LYNN_MODEL_CALL_TIMEOUT_MS;
  else process.env.LYNN_MODEL_CALL_TIMEOUT_MS = savedShared;
  if (savedBrain === undefined) delete process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS;
  else process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS = savedBrain;
});

describe("agent runtime model timeout policy", () => {
  it("does not impose a default total deadline on continuously active streams", () => {
    delete process.env.LYNN_MODEL_CALL_TIMEOUT_MS;
    delete process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS;
    expect(defaultModelCallTimeoutMs()).toBe(0);
    expect(brainModelCallTimeoutMs()).toBe(0);
    expect(resolveModelCallTimeouts()).toEqual({ firstChunkMs: 300_000, idleMs: 120_000, totalMs: 0 });
  });

  it("honors new overrides over saved values and rejects invalid or overflowing timers", () => {
    vi.stubEnv("LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS", "9000");
    vi.stubEnv("LYNN_MODEL_IDLE_TIMEOUT_MS", "2147483648");
    vi.stubEnv("LYNN_MODEL_CALL_TIMEOUT_MS", "700");
    vi.stubEnv("LYNN_MODEL_TOTAL_TIMEOUT_MS", "0");
    expect(resolveModelCallTimeouts({ firstChunkMs: 500, idleMs: 600, totalMs: 800 })).toEqual({ firstChunkMs: 9000, idleMs: 600, totalMs: 0 });
  });

  it("starts with a first-chunk deadline, then resets idle on every chunk", async () => {
    vi.useFakeTimers();
    const timed = createTimedSignal(undefined, { firstChunkMs: 300, idleMs: 120, totalMs: 0 });
    await vi.advanceTimersByTimeAsync(299);
    expect(timed.signal.aborted).toBe(false);
    for (let chunk = 0; chunk < 100; chunk++) { timed.activity(); await vi.advanceTimersByTimeAsync(119); }
    expect(timed.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timed.timeoutError()).toMatchObject({ kind: "idle", timeoutMs: 120 });
    expect(timed.signal.reason.message).toContain("LYNN_MODEL_IDLE_TIMEOUT_MS");
    timed.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes first-chunk and explicit total timeouts", async () => {
    vi.useFakeTimers();
    const first = createTimedSignal(undefined, { firstChunkMs: 30, idleMs: 12, totalMs: 0 });
    await vi.advanceTimersByTimeAsync(30);
    expect(first.timeoutError()).toMatchObject({ kind: "firstChunk" });
    expect(first.signal.reason.message).toContain("设置");
    const total = createTimedSignal(undefined, { firstChunkMs: 300, idleMs: 120, totalMs: 50 });
    total.activity();
    await vi.advanceTimersByTimeAsync(50);
    expect(total.timeoutError()).toMatchObject({ kind: "total" });
    first.cleanup(); total.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("preserves cancellation without timeout and removes timers (already aborted=%s)", async (alreadyAborted) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    if (alreadyAborted) parent.abort("user cancelled");
    const timed = createTimedSignal(parent.signal, { firstChunkMs: 300, idleMs: 120, totalMs: 500 });
    if (!alreadyAborted) parent.abort("user cancelled");
    timed.activity();
    await vi.advanceTimersByTimeAsync(1000);
    expect(timed.signal.reason).toBe("user cancelled");
    expect(timed.didTimeout()).toBe(false);
    timed.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not rearm after cleanup", () => {
    vi.useFakeTimers();
    const timed = createTimedSignal(undefined, { firstChunkMs: 300, idleMs: 120, totalMs: 0 });
    timed.cleanup(); timed.activity();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors shared and Brain-specific operator overrides", () => {
    process.env.LYNN_MODEL_CALL_TIMEOUT_MS = "1200";
    delete process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS;
    expect(brainModelCallTimeoutMs()).toBe(1200);

    process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS = "2400";
    expect(brainModelCallTimeoutMs()).toBe(2400);
  });
});
