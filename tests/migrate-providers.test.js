import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLocalQwenDefaultTo9B, migrateToProvidersYaml, repairRetiredModelReferences } from "../core/migrate-providers.js";

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

describe("repairRetiredModelReferences", () => {
  it("repairs retired OpenHanako model refs without deleting provider credentials", () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, ".lynn");
    const agentsDir = path.join(lynnHome, "agents");
    const sessionMetaPath = path.join(agentsDir, "lynn", "sessions", "session-meta.json");
    const logs = [];

    writeYaml(path.join(lynnHome, "added-models.yaml"), {
      _migrated: true,
      providers: {
        mimo: {
          api_key: "sk-mimo",
          base_url: "https://token-plan-cn.xiaomimimo.com/v1",
          api: "openai-completions",
          models: ["mimo-v2.5-pro", "still-valid-model"],
        },
        deepseek: {
          api_key: "sk-deepseek",
          base_url: "https://api.deepseek.com/v1",
          api: "openai-completions",
          models: ["deepseek-chat"],
        },
      },
    });
    writeYaml(path.join(agentsDir, "lynn", "config.yaml"), {
      api: { provider: "mimo" },
      models: {
        chat: { id: "mimo-v2.5-pro", provider: "mimo" },
        utility: "token-plan-cn",
        summarizer: { id: "deepseek-chat", provider: "deepseek" },
      },
    });
    writeJson(path.join(lynnHome, "user", "preferences.json"), {
      utility_model: { id: "mimo-v2.5-pro", provider: "mimo" },
      compiler_model: "deepseek-chat",
      favorites: [
        { id: "mimo-v2.5-pro", provider: "mimo" },
        { id: "deepseek-chat", provider: "deepseek" },
      ],
      oauth_custom_models: {
        mimo: ["mimo-v2.5-pro", "still-valid-model"],
      },
    });
    writeJson(sessionMetaPath, {
      "old.jsonl": {
        memoryEnabled: true,
        model: { id: "mimo-v2.5-pro", provider: "mimo" },
      },
    });

    repairRetiredModelReferences(lynnHome, agentsDir, (msg) => logs.push(msg));

    const config = readYaml(path.join(agentsDir, "lynn", "config.yaml"));
    expect(config.api.provider).toBe("mimo");
    expect(config.models.chat).toEqual({ id: "mimo-v2.5-pro", provider: "mimo" });
    expect(config.models.utility).toEqual({ id: "lynn-brain-router", provider: "brain" });
    expect(config.models.summarizer).toEqual({ id: "deepseek-chat", provider: "deepseek" });

    const added = readYaml(path.join(lynnHome, "added-models.yaml"));
    expect(added.providers.mimo.api_key).toBe("sk-mimo");
    expect(added.providers.mimo.models).toEqual(["mimo-v2.5-pro", "still-valid-model"]);
    expect(added.providers.deepseek.models).toEqual(["deepseek-chat"]);

    const prefs = readJson(path.join(lynnHome, "user", "preferences.json"));
    expect(prefs.utility_model).toEqual({ id: "mimo-v2.5-pro", provider: "mimo" });
    expect(prefs.compiler_model).toBe("deepseek-chat");
    expect(prefs.favorites).toEqual([
      { id: "mimo-v2.5-pro", provider: "mimo" },
      { id: "deepseek-chat", provider: "deepseek" },
    ]);
    expect(prefs.oauth_custom_models).toEqual({ mimo: ["mimo-v2.5-pro", "still-valid-model"] });
    expect(prefs.retired_hanako_model_refs_repaired_v1).toBeUndefined();

    const meta = readJson(sessionMetaPath);
    expect(meta["old.jsonl"].model).toEqual({ id: "mimo-v2.5-pro", provider: "mimo" });
    expect(meta["old.jsonl"].modelId).toBeUndefined();
    expect(meta["old.jsonl"].modelProvider).toBeUndefined();
    expect(logs.join("\n")).toContain("repaired retired OpenHanako model references");
  });
});
