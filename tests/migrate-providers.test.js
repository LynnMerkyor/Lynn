import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDeprecatedMimoLlmToBrain, migrateLocalQwenDefaultTo9B, migrateToProvidersYaml } from "../core/migrate-providers.js";

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-migrate-providers-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeYaml(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.dump(value, { lineWidth: 120, noRefs: true, quotingType: "\"" }), "utf-8");
}

function readYaml(filePath) {
  return YAML.load(fs.readFileSync(filePath, "utf-8"));
}

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("migrateToProvidersYaml", () => {
  it("writes _migrated when there is no legacy provider data", () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, ".lynn");
    const agentsDir = path.join(lynnHome, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    migrateToProvidersYaml(lynnHome, agentsDir);

    expect(readYaml(path.join(lynnHome, "added-models.yaml"))).toEqual({
      _migrated: true,
    });
  });

  it("migrates agent provider blocks and inline api credentials", () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, ".lynn");
    const agentsDir = path.join(lynnHome, "agents");

    writeYaml(path.join(agentsDir, "lynn", "config.yaml"), {
      providers: {
        dashscope: {
          api_key: "sk-dashscope",
          base_url: "https://dashscope.example/v1",
          api: "openai-completions",
        },
      },
      api: {
        provider: "openai",
        api_key: "sk-openai",
        base_url: "https://api.openai.com/v1",
      },
    });
    writeJson(path.join(lynnHome, "user", "preferences.json"), {});

    migrateToProvidersYaml(lynnHome, agentsDir);

    const added = readYaml(path.join(lynnHome, "added-models.yaml"));
    expect(added._migrated).toBe(true);
    expect(added.providers.dashscope).toMatchObject({
      api_key: "sk-dashscope",
      base_url: "https://dashscope.example/v1",
      api: "openai-completions",
    });
    expect(added.providers.openai).toMatchObject({
      api_key: "sk-openai",
      base_url: "https://api.openai.com/v1",
    });

    const cleaned = readYaml(path.join(agentsDir, "lynn", "config.yaml"));
    expect(cleaned.providers).toBeUndefined();
    expect(cleaned.api).toEqual({ provider: "openai" });
  });

  it("assigns favorites to explicit, existing-model, and default-model providers", () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, ".lynn");
    const agentsDir = path.join(lynnHome, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    writeYaml(path.join(lynnHome, "added-models.yaml"), {
      providers: {
        customProvider: {
          models: [{ id: "custom-model", name: "Custom Model" }],
        },
      },
    });
    writeJson(path.join(lynnHome, "user", "preferences.json"), {
      favorites: [
        { id: "gpt-4o", provider: "openai" },
        { id: "custom-model" },
        "deepseek-chat",
      ],
    });

    migrateToProvidersYaml(lynnHome, agentsDir);

    const added = readYaml(path.join(lynnHome, "added-models.yaml"));
    expect(added.providers.openai.models).toEqual(["gpt-4o"]);
    expect(added.providers.customProvider.models).toEqual([{ id: "custom-model", name: "Custom Model" }]);
    expect(added.providers.deepseek.models).toEqual(["deepseek-chat"]);
    expect(readJson(path.join(lynnHome, "user", "preferences.json")).favorites).toBeUndefined();
  });
});

describe("migrateLocalQwenDefaultTo9B", () => {
  it("migrates local Qwen 4B defaults to the 9B provider and marks prefs", () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, ".lynn");
    const agentsDir = path.join(lynnHome, "agents");

    writeYaml(path.join(lynnHome, "added-models.yaml"), {
      providers: {
        "local-qwen3-4b-thinking-2507-q4km-imatrix": {
          base_url: "http://127.0.0.1:19099/v1",
          api: "openai-completions",
          models: [{ id: "qwen3-4b-thinking-2507-q4km-imatrix" }],
        },
      },
    });
    writeYaml(path.join(agentsDir, "lynn", "config.yaml"), {
      api: {
        provider: "local-qwen35-4b-q4km",
      },
      models: {
        chat: "qwen35-4b-q4km",
        utility: {
          id: "qwen3-4b-thinking-2507-q4km-imatrix",
          provider: "local-qwen3-4b-thinking-2507-q4km-imatrix",
        },
        utility_large: {
          id: "deepseek-chat",
          provider: "deepseek",
        },
      },
    });
    writeJson(path.join(lynnHome, "user", "preferences.json"), {});

    migrateLocalQwenDefaultTo9B(lynnHome, agentsDir);

    const added = readYaml(path.join(lynnHome, "added-models.yaml"));
    expect(added.providers["local-qwen35-9b-q4km-imatrix"]).toMatchObject({
      base_url: "http://127.0.0.1:19099/v1",
      api: "openai-completions",
      auth_type: "none",
    });
    expect(added.providers["local-qwen35-9b-q4km-imatrix"].models[0].id).toBe("qwen35-9b-q4km-imatrix");

    const config = readYaml(path.join(agentsDir, "lynn", "config.yaml"));
    expect(config.api.provider).toBe("local-qwen35-9b-q4km-imatrix");
    expect(config.models.chat).toBe("qwen35-9b-q4km-imatrix");
    expect(config.models.utility).toMatchObject({
      id: "qwen35-9b-q4km-imatrix",
      provider: "local-qwen35-9b-q4km-imatrix",
    });
    expect(config.models.utility_large).toEqual({
      id: "deepseek-chat",
      provider: "deepseek",
    });
    expect(readJson(path.join(lynnHome, "user", "preferences.json")).local_qwen_default_9b_mtp_default_v2).toBe(true);
  });
});

describe("migrateDeprecatedMimoLlmToBrain", () => {
  it("removes expired MiMo Token Plan LLM providers and migrates agent model refs to Brain", () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, ".lynn");
    const agentsDir = path.join(lynnHome, "agents");

    writeYaml(path.join(lynnHome, "added-models.yaml"), {
      providers: {
        mimo: {
          display_name: "MiMo Token Plan",
          base_url: "https://token-plan-cn.xiaomimimo.com/v1",
          api: "openai-completions",
          models: [{ id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" }],
        },
        zhipu: {
          models: ["glm-5.1"],
        },
      },
    });
    writeYaml(path.join(agentsDir, "lynn", "config.yaml"), {
      api: {
        provider: "mimo",
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api_key: "sk-old",
      },
      models: {
        chat: { id: "mimo-v2.5-pro", provider: "mimo" },
        utility: "xiaomi/mimo-v2.5-pro",
        utility_large: { id: "glm-5.1", provider: "zhipu" },
      },
    });
    writeJson(path.join(lynnHome, "user", "preferences.json"), {
      favorites: [
        { id: "mimo-v2.5-pro", provider: "mimo" },
        { id: "glm-5.1", provider: "zhipu" },
      ],
    });

    migrateDeprecatedMimoLlmToBrain(lynnHome, agentsDir);

    const added = readYaml(path.join(lynnHome, "added-models.yaml"));
    expect(added.providers.mimo).toBeUndefined();
    expect(added.providers.zhipu.models).toEqual(["glm-5.1"]);

    const config = readYaml(path.join(agentsDir, "lynn", "config.yaml"));
    expect(config.api).toEqual({ provider: "brain" });
    expect(config.models.chat).toEqual({ id: "lynn-brain-router", provider: "brain" });
    expect(config.models.utility).toEqual({ id: "lynn-brain-router", provider: "brain" });
    expect(config.models.utility_large).toEqual({ id: "glm-5.1", provider: "zhipu" });
    expect(readJson(path.join(lynnHome, "user", "preferences.json")).favorites).toEqual([
      { id: "glm-5.1", provider: "zhipu" },
    ]);
  });

  it("preserves explicit MiMo paid web-search configuration outside the LLM token-plan route", () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, ".lynn");
    const agentsDir = path.join(lynnHome, "agents");

    writeYaml(path.join(lynnHome, "added-models.yaml"), {
      providers: {
        "mimo-search": {
          display_name: "MiMo Search",
          base_url: "https://api.xiaomimimo.com/v1",
          api: "openai-completions",
          models: ["web-search"],
        },
      },
    });
    fs.mkdirSync(agentsDir, { recursive: true });
    writeJson(path.join(lynnHome, "user", "preferences.json"), {});

    migrateDeprecatedMimoLlmToBrain(lynnHome, agentsDir);

    const added = readYaml(path.join(lynnHome, "added-models.yaml"));
    expect(added.providers["mimo-search"]).toMatchObject({
      base_url: "https://api.xiaomimimo.com/v1",
      models: ["web-search"],
    });
  });
});
