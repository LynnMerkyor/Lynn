import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeCodexAppServer,
  probeBrainHarnessSupport,
  resolveCodeHarnessSelection,
} from "../src/codex-harness-selection.js";

const fixture = fileURLToPath(new URL("../../tests/fixtures/fake-codex-app-server.mjs", import.meta.url));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex harness auto selection", () => {
  it("selects Codex only after a successful protocol probe", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    const brainProbe = vi.fn(async () => ({ supported: true, reason: "ready" }));
    await expect(resolveCodeHarnessSelection({ requested: "auto", cwd: ".", brainUrl: "http://brain", ultra: false, probe, brainProbe })).resolves.toMatchObject({
      requested: "auto",
      selected: "codex",
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("falls back before a run when the protocol probe fails", async () => {
    const probe = vi.fn(async (): Promise<"v2-camel"> => { throw new Error("unsupported protocol"); });
    await expect(resolveCodeHarnessSelection({ requested: "auto", cwd: ".", brainUrl: "http://brain", ultra: false, probe, brainProbe: async () => ({ supported: true, reason: "ready" }) })).resolves.toMatchObject({
      requested: "auto",
      selected: "legacy",
      reason: expect.stringContaining("unsupported protocol"),
    });
  });

  it("keeps ultra on the legacy loop without probing", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({ requested: "auto", cwd: ".", brainUrl: "http://brain", ultra: true, probe })).resolves.toMatchObject({ selected: "legacy" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps attached media on Lynn's verified multimodal bridge without probing", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      hasMedia: true,
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("multimodal bridge") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps JSON tool auditing and strict approval modes on the legacy loop", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      machineReadable: true,
      approval: "yolo",
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("per-tool audit") });
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      approval: "ask",
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("strict tool-approval") });
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      approval: "never",
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("strict tool-approval") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated remote BYOK route before probing", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      provider: { provider: "openai-compatible", baseUrl: "https://example.com/v1", model: "test" },
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("no API key") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("allows a keyless loopback provider to use the protocol probe", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      provider: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:18098/v1", model: "local" },
      probe,
    })).resolves.toMatchObject({ selected: "codex" });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("preserves explicit modes and validates the explicit Codex/ultra conflict", async () => {
    await expect(resolveCodeHarnessSelection({ requested: "legacy", cwd: ".", brainUrl: "http://brain", ultra: false })).resolves.toMatchObject({ selected: "legacy" });
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, probe: async () => "v2-camel" })).resolves.toMatchObject({ selected: "codex", protocol: "v2-camel" });
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: true })).rejects.toThrow(/cannot be combined/);
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, hasMedia: true })).rejects.toThrow(/multimodal attachment bridge/);
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, machineReadable: true })).rejects.toThrow(/JSON audit stream/);
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, approval: "ask" })).rejects.toThrow(/approval semantics/);
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, approval: "never" })).rejects.toThrow(/approval semantics/);
  });

  it("falls back when the current Brain does not declare Responses compatibility", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://legacy-brain",
      ultra: false,
      probe,
      brainProbe: async () => ({ supported: false, reason: "Brain does not declare compatibility" }),
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("does not declare") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("accepts only a usable Brain route with explicit harness capabilities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      route: ["stepfun"],
      providers: [{
        id: "stepfun",
        model: "step-3.7-flash",
        endpoint: "https://example.invalid",
        wire: "openai",
        credential: "set",
        configured: true,
        local: false,
        inRoute: true,
      }],
      capabilities: { responses: true, appServerHarness: true },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(probeBrainHarnessSupport("http://127.0.0.1:3950")).resolves.toEqual({
      supported: true,
      reason: "Brain Responses route is ready",
    });
  });

  it("performs a real initialize/initialized handshake with the shared client", async () => {
    await expect(probeCodexAppServer({
      command: process.execPath,
      commandArgs: [fixture],
      cwd: path.dirname(fixture),
      requestTimeoutMs: 2_000,
    })).resolves.toMatch(/^(v2-camel|hybrid-kebab-thread|legacy-kebab)$/);
  });
});
