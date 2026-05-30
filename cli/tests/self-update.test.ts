import { describe, expect, it } from "vitest";
import { checkCliUpdate, isInteractiveUpdateCommand, isUpdateNewer } from "../src/self-update.js";

describe("self update", () => {
  it("only checks interactive chat and empty code TUI launches", () => {
    expect(isInteractiveUpdateCommand({ command: "chat", positionals: [], flags: {} })).toBe(true);
    expect(isInteractiveUpdateCommand({ command: "code", positionals: [], flags: {} })).toBe(true);
    expect(isInteractiveUpdateCommand({ command: "code", positionals: [], flags: { p: "fix tests" } })).toBe(false);
    expect(isInteractiveUpdateCommand({ command: "code", positionals: ["fix tests"], flags: {} })).toBe(false);
    expect(isInteractiveUpdateCommand({ command: "worker", positionals: ["run"], flags: { jsonl: true } })).toBe(false);
    expect(isInteractiveUpdateCommand({ command: "chat", positionals: [], flags: { json: true } })).toBe(false);
  });

  it("compares versions and build ids", () => {
    expect(isUpdateNewer(
      { name: "@lynn/cli", version: "0.80.0-alpha.0", build: "aaa" },
      { version: "0.80.0-alpha.1", build: "aaa", tarballUrl: "https://example.test/lynn.tgz" },
    )).toBe(true);
    expect(isUpdateNewer(
      { name: "@lynn/cli", version: "0.80.0-alpha.0", build: "aaa" },
      { version: "0.80.0-alpha.0", build: "bbb", tarballUrl: "https://example.test/lynn.tgz" },
    )).toBe(true);
    expect(isUpdateNewer(
      { name: "@lynn/cli", version: "0.80.0", build: "aaa" },
      { version: "0.80.0-alpha.9", build: "zzz", tarballUrl: "https://example.test/lynn.tgz" },
    )).toBe(false);
  });

  it("skips network checks when disabled", async () => {
    const result = await checkCliUpdate(
      { name: "@lynn/cli", version: "0.80.0-alpha.0" },
      {
        env: { LYNN_CLI_UPDATE_CHECK: "0" },
        fetchImpl: async () => {
          throw new Error("should not fetch");
        },
      },
    );
    expect(result).toMatchObject({ available: false, reason: "disabled" });
  });

  it("skips network checks under test runners", async () => {
    const result = await checkCliUpdate(
      { name: "@lynn/cli", version: "0.80.0-alpha.0" },
      {
        env: { VITEST: "true" },
        fetchImpl: async () => {
          throw new Error("should not fetch");
        },
      },
    );
    expect(result).toMatchObject({ available: false, reason: "disabled" });
  });

  it("normalizes a valid manifest", async () => {
    const result = await checkCliUpdate(
      { name: "@lynn/cli", version: "0.80.0-alpha.0", build: "aaa" },
      {
        env: {},
        fetchImpl: async () => new Response(JSON.stringify({
          version: "0.80.0-alpha.0",
          build: "bbb",
          tarballUrl: "https://download.example.test/lynn.tgz",
        })),
      },
    );
    expect(result.available).toBe(true);
    expect(result.manifest).toMatchObject({
      version: "0.80.0-alpha.0",
      build: "bbb",
      tarballUrl: "https://download.example.test/lynn.tgz",
    });
  });
});
