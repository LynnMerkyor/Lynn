import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { renderProvidersInfo, runProviders } from "../src/commands/providers.js";

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
});
