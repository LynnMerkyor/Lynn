import { describe, expect, it } from "vitest";
import { deriveProviderSnapshot } from "../core/provider-state-machine.ts";

describe("provider state machine", () => {
  it("derives unconfigured when no provider config is present", () => {
    const snapshot = deriveProviderSnapshot({
      id: "openai",
      displayName: "OpenAI",
      configured: false,
    });

    expect(snapshot.state).toBe("unconfigured");
    expect(snapshot.safeReason).toContain("not configured");
  });

  it("derives needs_auth for an API-key provider without auth", () => {
    const snapshot = deriveProviderSnapshot({
      id: "openai",
      displayName: "OpenAI",
      auth: { required: true, status: "missing", safeReason: "API key is missing." },
    });

    expect(snapshot.state).toBe("needs_auth");
    expect(snapshot.auth).toEqual({
      required: true,
      status: "missing",
      safeReason: "API key is missing.",
    });
  });

  it("derives ready for configured and healthy providers", () => {
    const snapshot = deriveProviderSnapshot({
      id: "local-qwen35-9b-q4km-imatrix",
      displayName: "Qwen3.5-9B",
      selectedModel: {
        id: "qwen35-9b-q4km-imatrix",
        providerId: "local-qwen35-9b-q4km-imatrix",
        displayName: "Qwen3.5-9B Q4_K_M imatrix",
      },
      auth: { required: false, status: "not_required" },
      health: { status: "healthy", lastCheckedAt: 1779724800000 },
    });

    expect(snapshot.state).toBe("ready");
    expect(snapshot.selectedModel?.id).toBe("qwen35-9b-q4km-imatrix");
    expect(snapshot.lastCheckedAt).toBe(1779724800000);
  });

  it("gives checking precedence over degraded or cooldown signals after auth is satisfied", () => {
    const snapshot = deriveProviderSnapshot({
      id: "brain",
      displayName: "Lynn Brain",
      auth: { required: true, status: "authenticated" },
      health: { status: "checking", safeReason: "Refreshing provider status." },
      cooldown: { active: true, reason: "429", safeReason: "Provider recently rate limited." },
      fallback: {
        active: true,
        activeProviderId: "spark",
        chain: [{ providerId: "mimo", reason: "cooldown", safeReason: "MiMo is cooling down." }],
      },
    });

    expect(snapshot.state).toBe("checking");
    expect(snapshot.safeReason).toBe("Refreshing provider status.");
  });

  it("keeps cooldown and fallback metadata on fallback_active snapshots", () => {
    const snapshot = deriveProviderSnapshot({
      id: "brain",
      displayName: "Lynn Brain",
      auth: { required: true, status: "authenticated" },
      health: { status: "healthy", lastCheckedAt: "2026-05-26T01:00:00.000Z" },
      cooldown: { active: true, reason: "429", safeReason: "MiMo is cooling down.", until: 1779725400000 },
      fallback: {
        active: true,
        activeProviderId: "spark",
        chain: [
          { providerId: "mimo", displayName: "MiMo", reason: "cooldown", safeReason: "MiMo is cooling down." },
          { providerId: "spark", displayName: "Spark", reason: "manual" },
        ],
      },
    });

    expect(snapshot.state).toBe("fallback_active");
    expect(snapshot.cooldown).toMatchObject({ active: true, reason: "429", until: 1779725400000 });
    expect(snapshot.fallback.activeProviderId).toBe("spark");
    expect(snapshot.fallback.chain.map((entry) => entry.providerId)).toEqual(["mimo", "spark"]);
  });

  it("derives disabled and error terminal states", () => {
    expect(deriveProviderSnapshot({
      id: "deepseek",
      displayName: "DeepSeek",
      disabled: true,
      health: { status: "healthy" },
    }).state).toBe("disabled");

    const errorSnapshot = deriveProviderSnapshot({
      id: "spark",
      displayName: "Spark",
      auth: { required: false, status: "not_required" },
      error: { active: true, code: "upstream_500", safeReason: "Upstream returned an error." },
    });

    expect(errorSnapshot.state).toBe("error");
    expect(errorSnapshot.safeReason).toBe("Upstream returned an error.");
  });

  it("does not copy secret fields into JSON snapshots", () => {
    const unsafeInput = {
      id: "openai",
      displayName: "OpenAI",
      auth: {
        required: true,
        status: "authenticated",
        apiKey: "sk-should-not-appear",
        token: "token-should-not-appear",
      },
      health: {
        status: "healthy",
        secret: "secret-should-not-appear",
      },
      selectedModel: {
        id: "gpt-5.4",
        providerId: "openai",
        apiKey: "model-secret-should-not-appear",
      },
    } as never;

    const json = JSON.stringify(deriveProviderSnapshot(unsafeInput));

    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("token-should-not-appear");
    expect(json).not.toContain("secret-should-not-appear");
    expect(json).not.toContain("model-secret-should-not-appear");
    expect(json).not.toContain("sk-should-not-appear");
  });
});
