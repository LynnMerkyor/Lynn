import { describe, expect, it } from "vitest";
import { lookupKnown } from "../shared/known-models.js";

describe("known GLM models", () => {
  it("marks glm-5.1 as a reasoning model", () => {
    const model = lookupKnown("glm", "glm-5.1");
    expect(model).toBeTruthy();
    expect(model.reasoning).toBe(true);
  });

  it("marks glm-5-turbo as a reasoning model", () => {
    const model = lookupKnown("glm", "glm-5-turbo");
    expect(model).toBeTruthy();
    expect(model.reasoning).toBe(true);
  });
});

describe("known DeepSeek thinking variants", () => {
  it("matches DeepSeek V4 Pro suffix variants as deepseek reasoning models", () => {
    const model = lookupKnown("deepseek", "deepseek-v4-pro-202606");
    expect(model).toBeTruthy();
    expect(model.reasoning).toBe(true);
    expect(model.thinkingFormat).toBe("deepseek");
  });

  it("matches DeepSeek Reasoner suffix variants as deepseek reasoning models", () => {
    const model = lookupKnown("custom-byok", "deepseek-reasoner:latest");
    expect(model).toBeTruthy();
    expect(model.reasoning).toBe(true);
    expect(model.thinkingFormat).toBe("deepseek");
  });
});
