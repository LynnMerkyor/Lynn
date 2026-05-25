import { describe, expect, it } from "vitest";
import { deriveLocalQwen35ProviderState } from "../server/routes/local-qwen35.js";

describe("local qwen35 provider state", () => {
  it("marks the default endpoint ready only after provider registration", () => {
    expect(deriveLocalQwen35ProviderState({
      runtime: { endpoint_running: true },
      registered: true,
    })).toMatchObject({ state: "ready", canSwitch: true, severity: "ready" });

    expect(deriveLocalQwen35ProviderState({
      runtime: { endpoint_running: true },
      registered: false,
    })).toMatchObject({ state: "endpoint_ready_unregistered", canSetup: true, severity: "warning" });
  });

  it("treats a non-default endpoint as occupied", () => {
    expect(deriveLocalQwen35ProviderState({
      runtime: { endpoint_occupied: true },
      registered: true,
    })).toMatchObject({ state: "occupied", canSwitch: false, severity: "error" });
  });

  it("keeps active setup/loading in preparing state", () => {
    expect(deriveLocalQwen35ProviderState({
      runtime: { endpoint_loading: false },
      registered: false,
      job: { status: "running" },
    })).toMatchObject({ state: "preparing", canSetup: false, severity: "busy" });
  });

  it("distinguishes missing model from ready-to-start assets", () => {
    expect(deriveLocalQwen35ProviderState({
      status: { plan: { observed: { gguf: null, llama_server: "/bin/llama-server" } } },
    })).toMatchObject({ state: "needs_model", canSetup: true });

    expect(deriveLocalQwen35ProviderState({
      status: { plan: { observed: { gguf: "/models/qwen.gguf", llama_server: "/bin/llama-server" } } },
    })).toMatchObject({ state: "ready_to_start", canSetup: true, severity: "standby" });
  });
});
