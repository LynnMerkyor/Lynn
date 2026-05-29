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
    });

    expect(output).toContain("Lynn Providers / BYOK");
    expect(output).toContain("MiMo");
    expect(output).toContain("Settings > Providers");
    expect(output).not.toContain("sk-");
  });

  it("prints JSON when requested", () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runProviders(parseArgs(["providers", "--json"]))).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"providers.info\"");
    expect(output).toContain("MiMo");
  });

  it("makes model a providers alias", () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runProviders(parseArgs(["model"]))).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("Default route");
    expect(output).toContain("BYOK");
  });
});
