import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runDoctor } from "../src/commands/doctor.js";

describe("doctor command", () => {
  it("supports offline diagnostics", async () => {
    const result = await runDoctor(parseArgs(["doctor", "--offline"]));

    expect(result.ok).toBe(true);
    expect(result.brain).toBe("skipped");
    expect(result.checks.some((check) => check.name === "node")).toBe(true);
  });
});
