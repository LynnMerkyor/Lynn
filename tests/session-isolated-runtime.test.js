import { describe, expect, it } from "vitest";
import {
  PATROL_TOOLS_DEFAULT,
  prepareIsolatedToolRuntime,
  resolveIsolatedExecutionModel,
} from "../core/session-isolated-runtime.js";

describe("session isolated runtime helpers", () => {
  const availableModels = [
    { id: "preferred", provider: "openai" },
    { id: "fallback", provider: "openai" },
  ];

  it("uses an explicit model without consulting agent preferences", () => {
    const explicitModel = { id: "explicit", provider: "test" };
    expect(resolveIsolatedExecutionModel({
      explicitModel,
      targetAgent: { config: { models: { chat: "missing" } } },
      availableModels,
      defaultModel: { id: "default" },
    })).toEqual({
      model: explicitModel,
      requestedModelId: null,
      usedFallback: false,
    });
  });

  it("falls back from a missing agent model to the global default then reports fallback", () => {
    const resolved = resolveIsolatedExecutionModel({
      targetAgent: {
        yuan: "lynn",
        config: { models: { chat: { id: "missing", provider: "openai" } } },
      },
      availableModels,
      defaultModel: { id: "fallback", provider: "openai" },
    });

    expect(resolved.model.id).toBe("fallback");
    expect(resolved.requestedModelId).toBe("missing");
    expect(resolved.usedFallback).toBe(true);
  });

  it("filters isolated custom and builtin tools", () => {
    const runtime = prepareIsolatedToolRuntime({
      execCwd: "/tmp/work",
      targetAgent: {
        agentDir: "/tmp/agent",
        tools: [{ name: "unused" }],
        config: { desk: { patrol_tools: ["web_search"] } },
      },
      execModel: { id: "m", provider: "openai" },
      buildTools: (_cwd, customTools, opts) => ({
        tools: [{ name: "read" }, { name: "write" }],
        customTools: [{ name: "web_search" }, { name: "todo" }],
        customToolsArg: customTools,
        opts,
      }),
      getSessionPath: () => "/tmp/session.jsonl",
      builtinFilter: ["read"],
    });

    expect(runtime.suppressClientTools).toBe(false);
    expect(runtime.tools).toEqual([{ name: "read" }]);
    expect(runtime.customTools).toEqual([{ name: "web_search" }]);
  });

  it("keeps isolated local tools for Brain but drops Brain-managed realtime custom tools", () => {
    const runtime = prepareIsolatedToolRuntime({
      execCwd: "/tmp/work",
      targetAgent: {
        agentDir: "/tmp/agent",
        tools: [],
        config: { desk: { patrol_tools: ["web_search", "weather", "notify"] } },
      },
      execModel: { id: "lynn-brain-router", provider: "brain" },
      buildTools: () => ({
        tools: [{ name: "read" }, { name: "bash" }],
        customTools: [{ name: "web_search" }, { name: "weather" }, { name: "notify" }],
      }),
      getSessionPath: () => "/tmp/session.jsonl",
    });

    expect(runtime.suppressClientTools).toBe(false);
    expect(runtime.tools).toEqual([{ name: "read" }, { name: "bash" }]);
    expect(runtime.customTools).toEqual([{ name: "notify" }]);
  });

  it("exposes a stable default patrol tool allowlist", () => {
    expect(PATROL_TOOLS_DEFAULT).toContain("web_search");
    expect(PATROL_TOOLS_DEFAULT).toContain("message_agent");
  });
});
