import { describe, expect, it } from "vitest";
import { detectCliAgents } from "../src/agent-registry.js";

describe("agent registry", () => {
  it("marks Lynn CLI as current and detects external binaries on PATH", () => {
    const agents = detectCliAgents({
      pathEnv: "/bin",
      fileExists: (file) => file === "/bin/codex",
    });
    expect(agents.find((agent) => agent.id === "lynn-cli")).toMatchObject({ available: true, availability: "current binary" });
    expect(agents.find((agent) => agent.id === "codex-cli")).toMatchObject({ available: true, availability: "/bin/codex" });
    expect(agents.find((agent) => agent.id === "claude-code")).toMatchObject({ available: false, availability: "not found on PATH" });
  });
});
