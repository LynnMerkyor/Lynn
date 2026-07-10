import { afterEach, describe, expect, it } from "vitest";

import {
  brainModelCallTimeoutMs,
  defaultModelCallTimeoutMs,
} from "../core/agent-runtime/session-openai-adapter.js";

const savedShared = process.env.LYNN_MODEL_CALL_TIMEOUT_MS;
const savedBrain = process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS;

afterEach(() => {
  if (savedShared === undefined) delete process.env.LYNN_MODEL_CALL_TIMEOUT_MS;
  else process.env.LYNN_MODEL_CALL_TIMEOUT_MS = savedShared;
  if (savedBrain === undefined) delete process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS;
  else process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS = savedBrain;
});

describe("agent runtime model timeout policy", () => {
  it("gives Brain enough total time to execute bounded provider fallbacks", () => {
    delete process.env.LYNN_MODEL_CALL_TIMEOUT_MS;
    delete process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS;
    expect(defaultModelCallTimeoutMs()).toBe(45_000);
    expect(brainModelCallTimeoutMs()).toBe(115_000);
  });

  it("honors shared and Brain-specific operator overrides", () => {
    process.env.LYNN_MODEL_CALL_TIMEOUT_MS = "1200";
    delete process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS;
    expect(brainModelCallTimeoutMs()).toBe(1200);

    process.env.LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS = "2400";
    expect(brainModelCallTimeoutMs()).toBe(2400);
  });
});
