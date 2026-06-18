import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelManager } from "../core/model-manager.ts";

function makeManager(rawProviders, availableModels) {
  const tempDir = mkdtempSync(join(tmpdir(), "lynn-model-manager-metadata-"));
  const manager = new ModelManager({ lynnHome: tempDir });
  manager._modelRegistry = {
    getAvailable: vi.fn(async () => availableModels),
  };
  manager.providerRegistry = {
    getAllProvidersRaw: () => rawProviders,
    getAuthJsonKey: (name) => name,
  };
  return {
    manager,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

describe("ModelManager metadata enrichment", () => {
  it("preserves provider-declared vision metadata after runtime discovery", async () => {
    const { manager, cleanup } = makeManager({
      mimo: {
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api: "openai-completions",
        models: [{
          id: "mimo-v2.5",
          name: "MiMo V2.5",
          context: 262144,
          maxOutput: 32000,
          vision: true,
          reasoning: true,
        }],
      },
    }, [{
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      provider: "mimo",
      input: ["text"],
      contextWindow: 128000,
      vision: false,
      reasoning: false,
    }]);

    try {
      const [model] = await manager.refreshAvailable();
      expect(model.provider).toBe("mimo");
      expect(model.id).toBe("mimo-v2.5");
      expect(model.vision).toBe(true);
      expect(model.reasoning).toBe(true);
      expect(model.input).toContain("image");
      expect(model.contextWindow).toBe(262144);
      expect(model.maxTokens).toBe(32000);
    } finally {
      cleanup();
    }
  });

  it("fills known-model vision metadata for string provider entries", async () => {
    const { manager, cleanup } = makeManager({
      mimo: {
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api: "openai-completions",
        models: ["mimo-v2.5"],
      },
    }, [{
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      provider: "mimo",
      input: ["text"],
      contextWindow: 128000,
      vision: false,
      reasoning: false,
    }]);

    try {
      const [model] = await manager.refreshAvailable();
      expect(model.vision).toBe(true);
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(["text", "image"]);
      expect(model.contextWindow).toBe(262144);
      expect(model.maxTokens).toBe(32000);
    } finally {
      cleanup();
    }
  });

  it("does not mark MiMo V2.5 Pro as vision-capable from known metadata", async () => {
    const { manager, cleanup } = makeManager({
      mimo: {
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api: "openai-completions",
        models: ["mimo-v2.5-pro"],
      },
    }, [{
      id: "mimo-v2.5-pro",
      name: "MiMo V2.5 Pro",
      provider: "mimo",
      input: ["text"],
      contextWindow: 128000,
      vision: false,
      reasoning: false,
    }]);

    try {
      const [model] = await manager.refreshAvailable();
      expect(model.vision).toBe(false);
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(["text"]);
      expect(model.contextWindow).toBe(262144);
      expect(model.maxTokens).toBe(64000);
    } finally {
      cleanup();
    }
  });
});
