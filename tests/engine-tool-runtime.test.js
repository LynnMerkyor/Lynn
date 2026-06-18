import { describe, expect, it, vi } from "vitest";
import {
  createToolAliases,
  detectSensitiveParams,
  selectMcpTools,
  wrapToolWithGuard,
} from "../core/engine-tool-runtime.ts";

describe("engine tool runtime helpers", () => {
  it("selects only session-activated MCP tools unless auto-load is enabled", () => {
    const tools = [
      { name: "mcp__files__read" },
      { name: "mcp__browser_tools__open" },
      { name: "web_search" },
    ];

    expect(selectMcpTools(tools, undefined, false)).toEqual([]);
    expect(selectMcpTools(tools, undefined, true).map((t) => t.name)).toEqual([
      "mcp__files__read",
      "mcp__browser_tools__open",
      "web_search",
    ]);
    expect(selectMcpTools(tools, new Set(["browser_tools"]), false).map((t) => t.name)).toEqual([
      "mcp__browser_tools__open",
    ]);
  });

  it("guards tool arguments by coercing types and reporting missing required params", async () => {
    const execute = vi.fn(async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(params) }] }));
    const guarded = wrapToolWithGuard({
      name: "demo",
      execute,
      parameters: {
        properties: {
          count: { type: "integer" },
          enabled: { type: "boolean" },
        },
        required: ["count"],
      },
    });

    const ok = await guarded.execute("call-1", { count: "7", enabled: "false" });
    expect(execute).toHaveBeenCalledWith("call-1", { count: 7, enabled: false });
    expect(ok.content[0].text).toContain('"count":7');

    const missing = await guarded.execute("call-2", {});
    expect(missing.content[0].text).toContain("Missing parameters: count");
  });

  it("adds warnings for sensitive path parameters without blocking execution", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "secret text" }] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const guarded = wrapToolWithGuard({ name: "read", execute });

    const result = await guarded.execute("call-1", { path: "/Users/me/.ssh/id_ed25519" });

    expect(detectSensitiveParams("read", { path: "/Users/me/.ssh/id_ed25519" })?.label).toBe("SSH 密钥目录");
    expect(result.content[0].text).toContain("安全提示");
    expect(result.content[0].text).toContain("secret text");
    warn.mockRestore();
  });

  it("deduplicates identical in-flight tool calls per session and releases after completion", async () => {
    let resolveFirst;
    const execute = vi.fn((toolCallId) => {
      if (toolCallId === "call-1") {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ content: [{ type: "text", text: `done:${toolCallId}` }] });
        });
      }
      return Promise.resolve({ content: [{ type: "text", text: `done:${toolCallId}` }] });
    });
    const guarded = wrapToolWithGuard({
      name: "web_search",
      execute,
      parameters: {
        properties: {
          query: { type: "string" },
        },
      },
    }, {
      getSessionPath: () => "/sessions/a",
    });

    const first = guarded.execute("call-1", { query: "世界杯" });
    const duplicate = await guarded.execute("call-2", { query: "世界杯" });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(duplicate.content[0].text).toContain("已跳过重复的并发工具调用");
    expect(duplicate.details).toMatchObject({
      deduped: true,
      tool: "web_search",
      sessionPath: "/sessions/a",
    });

    resolveFirst();
    const firstResult = await first;
    expect(firstResult.content[0].text).toBe("done:call-1");

    await guarded.execute("call-3", { query: "世界杯" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not deduplicate identical tool params across different sessions", async () => {
    const execute = vi.fn(async (toolCallId) => ({ content: [{ type: "text", text: `done:${toolCallId}` }] }));
    let sessionPath = "/sessions/a";
    const guarded = wrapToolWithGuard({
      name: "web_search",
      execute,
    }, {
      getSessionPath: () => sessionPath,
    });

    const first = guarded.execute("call-1", { query: "世界杯" });
    sessionPath = "/sessions/b";
    const second = guarded.execute("call-2", { query: "世界杯" });

    await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("creates weak-model aliases without clobbering existing tool names", () => {
    const tools = [{ name: "web_search" }, { name: "web-search" }, { name: "present_files" }];
    const aliases = createToolAliases(tools);

    expect(aliases.some((tool) => tool.name === "web-search")).toBe(false);
    expect(aliases.find((tool) => tool.name === "present-files")?._aliasOf).toBe("present_files");
  });
});
