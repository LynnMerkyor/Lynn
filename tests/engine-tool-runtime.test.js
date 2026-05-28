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

  it("creates weak-model aliases without clobbering existing tool names", () => {
    const tools = [{ name: "web_search" }, { name: "web-search" }, { name: "present_files" }];
    const aliases = createToolAliases(tools);

    expect(aliases.some((tool) => tool.name === "web-search")).toBe(false);
    expect(aliases.find((tool) => tool.name === "present-files")?._aliasOf).toBe("present_files");
  });
});
