import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/args.js";
import { activeRouteLabel, renderProviderPresets, renderProvidersInfo, runProviders } from "../src/commands/providers.js";
import { providerProfilePath, readCliProviderProfile, resolveCliProviderProfile } from "../src/provider-profile.js";
import { setLang } from "../src/i18n.js";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

describe("providers command", () => {
  it("renders BYOK guidance without exposing keys", () => {
    const output = renderProvidersInfo({
      defaultRoute: "MiMo via local Brain router (auto)",
      byokEntry: "Open Lynn GUI > Settings > Providers",
      keyPolicy: "Provider keys stay private.",
      brainUrl: "http://127.0.0.1:8790",
      server: { status: "ok", url: "http://127.0.0.1:3000" },
      activeProvider: "openai",
      activeModel: "gpt-5.5",
      providers: [
        { id: "openai", displayName: "OpenAI", type: "api-key", configured: true, modelCount: 2 },
        { id: "deepseek", displayName: "DeepSeek", type: "api-key", configured: false, modelCount: 1 },
      ],
    });

    expect(output).toContain("Lynn Providers / BYOK");
    expect(output).toContain("MiMo");
    expect(output).toContain("OpenAI");
    expect(output).not.toContain("secret");
    expect(output).toContain("Settings > Providers");
    expect(output).toContain("CLI BYOK");
    expect(output).not.toContain("sk-");
  });

  it("prints JSON when requested", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "--json", "--data-dir", "/tmp/lynn-cli-missing-test"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"providers.info\"");
    expect(output).toContain("MiMo");
  });

  it("makes model a providers alias", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["model", "--data-dir", "/tmp/lynn-cli-missing-test"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("Default route");
    expect(output).toContain("BYOK");
  });

  it("renders localized provider guidance in Chinese", () => {
    setLang("zh");
    const output = renderProvidersInfo({
      defaultRoute: "MiMo via local Brain router (auto)",
      byokEntry: "Lynn 客户端 > 设置 > Providers",
      keyPolicy: "Provider keys stay private.",
      brainUrl: "http://127.0.0.1:8790",
      server: { status: "missing" },
      providers: [],
    });

    expect(output).toContain("当前路由");
    expect(output).toContain("默认模型");
    expect(output).toContain("三步配置 BYOK");
  });

  it("lists CLI BYOK presets so users can discover cloud backends", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "presets"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("stepfun");
    expect(output).toContain("step-3.7-flash");
    expect(output).toContain("Lynn providers set --preset stepfun --api-key <api-key>");
  });

  it("prints provider presets as JSON when requested", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "presets", "--json"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"providers.presets\"");
    expect(output).toContain("\"name\":\"stepfun\"");
    expect(output).not.toContain("apiKey");
  });

  it("renders provider presets without embedding keys", () => {
    const rendered = renderProviderPresets();

    expect(rendered).toContain("StepFun");
    expect(rendered).toContain("step-3.7-flash");
    expect(rendered).toContain("<api-key>");
    expect(rendered).not.toContain("sk-");
  });

  it("formats the active route for the startup banner", () => {
    expect(activeRouteLabel({
      defaultRoute: "MiMo via local Brain router (auto)",
      activeProvider: "mimo",
      activeModel: "mimo-v2.5-pro",
    })).toBe("mimo / mimo-v2.5-pro");
    expect(activeRouteLabel({
      defaultRoute: "MiMo via local Brain router (auto)",
    })).toBe("MiMo via local Brain router (auto)");
  });

  it("saves a CLI BYOK provider profile without printing the raw key", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-providers-"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs([
        "providers",
        "set",
        "--data-dir",
        dataDir,
        "--base-url",
        "https://api.example.com/v1",
        "--api-key",
        "sk-secret-1234",
        "--model",
        "example-model",
      ]), false)).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    await expect(readCliProviderProfile(dataDir)).resolves.toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      apiKey: "sk-secret-1234",
    });
    expect(output).toContain(providerProfilePath(dataDir));
    expect(output).toContain("sk-s…1234");
    expect(output).not.toContain("sk-secret-1234");
  });

  it("supports StepFun as a CLI BYOK preset without bundling a key", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-stepfun-"));
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs([
        "providers",
        "set",
        "--data-dir",
        dataDir,
        "--preset",
        "stepfun",
        "--api-key",
        "step-secret",
      ]), false)).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    await expect(readCliProviderProfile(dataDir)).resolves.toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      model: "step-3.7-flash",
      apiKey: "step-secret",
    });
    await expect(resolveCliProviderProfile(parseArgs([
      "code",
      "review this",
      "--data-dir",
      dataDir,
      "--preset",
      "stepfun",
    ]))).resolves.toMatchObject({
      source: "flags",
      profile: {
        provider: "openai-compatible",
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        model: "step-3.7-flash",
        apiKey: "step-secret",
      },
    });
  });

  it("does not reuse a stored key for a different provider preset", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-key-"));
    await fs.mkdir(path.dirname(providerProfilePath(dataDir)), { recursive: true });
    await fs.writeFile(providerProfilePath(dataDir), JSON.stringify({
      provider: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "deepseek-secret",
    }), "utf8");

    await expect(resolveCliProviderProfile(parseArgs([
      "code",
      "review this",
      "--data-dir",
      dataDir,
      "--preset",
      "stepfun",
    ]))).resolves.toMatchObject({
      source: "flags",
      profile: {
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        model: "step-3.7-flash",
        apiKey: undefined,
      },
    });
  });
});
