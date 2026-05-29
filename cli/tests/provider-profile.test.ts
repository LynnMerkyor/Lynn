import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import {
  providerProfilePath,
  readCliProviderProfile,
  redactApiKey,
  resolveCliProviderProfile,
  writeCliProviderProfile,
} from "../src/provider-profile.js";

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-"));
}

describe("CLI provider profile", () => {
  it("stores CLI BYOK provider config under the Lynn data dir", async () => {
    const dataDir = await tempDir();
    await writeCliProviderProfile(dataDir, {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1/",
      model: "example-model",
      apiKey: "sk-test-secret",
    });

    await expect(readCliProviderProfile(dataDir)).resolves.toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      apiKey: "sk-test-secret",
    });
    await expect(fs.readFile(providerProfilePath(dataDir), "utf8")).resolves.toContain("example-model");
  });

  it("resolves explicit flags before file config", async () => {
    const dataDir = await tempDir();
    await writeCliProviderProfile(dataDir, {
      provider: "file",
      baseUrl: "https://file.example/v1",
      model: "file-model",
    });

    const resolved = await resolveCliProviderProfile(parseArgs([
      "prompt",
      "hello",
      "--data-dir",
      dataDir,
      "--provider",
      "flags",
      "--base-url",
      "https://flags.example/v1",
      "--model",
      "flag-model",
      "--api-key",
      "sk-flag-secret",
    ]));

    expect(resolved?.source).toBe("flags");
    expect(resolved?.profile).toMatchObject({
      provider: "flags",
      baseUrl: "https://flags.example/v1",
      model: "flag-model",
      apiKey: "sk-flag-secret",
    });
  });

  it("redacts API keys for display", () => {
    expect(redactApiKey("sk-1234567890")).toBe("sk-1…7890");
    expect(redactApiKey("short")).toBe("********");
    expect(redactApiKey(undefined)).toBe("(none)");
  });
});
