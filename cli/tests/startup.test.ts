import { describe, expect, it } from "vitest";
import { renderStartupBanner } from "../src/startup.js";

describe("startup banner", () => {
  it("renders model, brain route, and working directory", () => {
    const output = renderStartupBanner({
      cwd: process.env.HOME || "/tmp",
      brainUrl: "http://127.0.0.1:8790",
      brainStatus: "offline",
      modelLabel: "Brain router (auto)",
    });

    expect(output).toContain(">_ Lynn CLI");
    expect(output).toContain("model:");
    expect(output).toContain("Brain router");
    expect(output).toContain("mode:");
    expect(output).toContain("/mode to change");
    expect(output).toContain("BYOK:");
    expect(output).toContain("Lynn providers");
    expect(output).toContain("brain:");
    expect(output).toContain("offline");
    expect(output).toContain("http://127.0.0.1:8790");
    expect(output).toContain("directory:");
    expect(output).toContain("~");
    expect(output).toContain("Lynn help");
  });
});
