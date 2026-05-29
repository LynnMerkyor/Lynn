import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { renderDoctor, runDoctor } from "../src/commands/doctor.js";
import { writeCliProviderProfile } from "../src/provider-profile.js";

describe("doctor command", () => {
  it("supports offline diagnostics", async () => {
    const result = await runDoctor(parseArgs(["doctor", "--offline"]));

    expect(result.ok).toBe(true);
    expect(result.brain).toBe("skipped");
    expect(result.checks.some((check) => check.name === "node")).toBe(true);
    expect(result.cliProvider.configured).toBe(false);
    expect(result.presets).toContain("mimo:mimo-v2.5-pro");
    expect(renderDoctor(result)).toContain("Lynn providers set --preset mimo --api-key <api-key>");
    expect(renderDoctor(result)).toContain("mimo:mimo-v2.5-pro");
  });

  it("reports configured CLI BYOK without exposing the raw key", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-doctor-"));
    await writeCliProviderProfile(dataDir, {
      provider: "openai-compatible",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
      apiKey: "mimo-doctor-secret",
    });

    const result = await runDoctor(parseArgs(["doctor", "--offline", "--data-dir", dataDir]));
    const rendered = renderDoctor(result);

    expect(result.cliProvider).toMatchObject({
      configured: true,
      provider: "openai-compatible",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
    });
    expect(result.cliProvider.apiKey).not.toBe("mimo-doctor-secret");
    expect(rendered).toContain("mimo-v2.5-pro");
    expect(rendered).not.toContain("mimo-doctor-secret");
  });
});
