import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpertManager } from "../core/expert-manager.js";

function writePreset(presetsDir, slug) {
  const dir = path.join(presetsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "expert.yaml"),
    [
      `slug: ${slug}`,
      "name:",
      "  en: Analyst",
      "  zh: Analyst ZH",
      "  ja: Analyst JA",
      "description:",
      "  en: Finance expert",
      "  ja: Finance expert JA",
      "icon: A",
      "category: finance",
      "model_binding:",
      "  preferred: preferred-model",
      "  fallback: fallback-model",
      "credit_cost:",
      "  per_session: 7",
      "  per_extra_round: 2",
      "skills:",
      "  - calc",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "identity.md"), "preset identity", "utf-8");
  fs.writeFileSync(path.join(dir, "ishiki.md"), "preset ishiki", "utf-8");
}

function makeManager(tmpDir) {
  const presetsDir = path.join(tmpDir, "presets");
  const agentDir = path.join(tmpDir, "agents", "agent-1");
  fs.mkdirSync(agentDir, { recursive: true });
  writePreset(presetsDir, "analyst");

  const agent = {
    agentDir,
    updateConfig: vi.fn(),
    buildSystemPrompt: vi.fn(() => "rebuilt prompt"),
  };
  const agentManager = {
    createAgent: vi.fn(async ({ name }) => ({ id: "agent-1", name })),
    getAgent: vi.fn(() => agent),
  };
  const modelManager = {
    availableModels: [
      { id: "fallback-model", provider: "fallback-provider" },
      { id: "explicit-model", provider: "explicit-provider" },
    ],
    defaultModel: { id: "default-model", provider: "default-provider" },
    providerRegistry: {
      getAllProvidersRaw: vi.fn(() => ({})),
    },
  };
  const creditInterface = {
    getBalance: vi.fn(async () => 100),
    canAfford: vi.fn(async () => true),
    consume: vi.fn(async () => true),
  };
  const manager = new ExpertManager({
    presetsDir,
    getAgentManager: () => agentManager,
    getModelManager: () => modelManager,
    getSkillManager: () => ({}),
    creditInterface,
  });

  return { manager, agent, agentManager, modelManager, creditInterface, agentDir };
}

describe("ExpertManager", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-expert-manager-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads localized expert summaries and details", () => {
    const { manager } = makeManager(tmpDir);

    expect(manager.listExperts("ja-JP")).toEqual([
      expect.objectContaining({
        slug: "analyst",
        name: "Analyst JA",
        description: "Finance expert JA",
        avatarUrl: "/api/experts/analyst/avatar",
        model_binding: { preferred: "preferred-model", fallback: "fallback-model" },
        skills: ["calc"],
      }),
    ]);
    expect(manager.getExpert("analyst", "en-US")).toMatchObject({
      slug: "analyst",
      name: "Analyst",
      identity: "preset identity",
      ishiki: "preset ishiki",
    });
    expect(manager.getExpertCost("analyst")).toEqual({ per_session: 7, per_extra_round: 2 });
    expect(manager.getExpertSkills("analyst")).toEqual(["calc"]);
  });

  it("spawns an expert with fallback model, config injection, prompt rebuild, and credit usage", async () => {
    const { manager, agent, agentManager, creditInterface, agentDir } = makeManager(tmpDir);

    await expect(manager.spawnExpert("analyst", {
      userId: "user-1",
      channelId: "strategy",
    })).resolves.toEqual({ agentId: "agent-1", name: "Analyst ZH" });

    expect(manager.resolveModelForExpert("analyst")).toBe("fallback-model");
    expect(creditInterface.canAfford).toHaveBeenCalledWith("user-1", 7);
    expect(creditInterface.consume).toHaveBeenCalledWith("user-1", 7, "expert:analyst");
    expect(agentManager.createAgent).toHaveBeenCalledWith({ name: "Analyst ZH", yuan: "lynn" });
    expect(agent.updateConfig).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agent: { tier: "expert" },
      expert: expect.objectContaining({
        slug: "analyst",
        category: "finance",
        spawnedForChannel: "strategy",
      }),
    }));
    expect(agent.updateConfig).toHaveBeenNthCalledWith(2, {
      models: { chat: "fallback-model" },
      api: { provider: "fallback-provider" },
    });
    expect(agent.updateConfig).toHaveBeenNthCalledWith(3, {
      capabilities: { learn_skills: { enabled: true, allow_github_fetch: true } },
    });
    expect(agent._systemPrompt).toBe("rebuilt prompt");
    expect(fs.readFileSync(path.join(agentDir, "identity.md"), "utf-8")).toBe("preset identity");
    expect(fs.readFileSync(path.join(agentDir, "ishiki.md"), "utf-8")).toBe("preset ishiki");
  });

  it("uses an explicit provider and model when supplied", async () => {
    const { manager, agent } = makeManager(tmpDir);

    await manager.spawnExpert("analyst", {
      modelId: "explicit-model",
      provider: "explicit-provider",
    });

    expect(agent.updateConfig).toHaveBeenNthCalledWith(2, {
      models: { chat: "explicit-model" },
      api: { provider: "explicit-provider" },
    });
  });
});
