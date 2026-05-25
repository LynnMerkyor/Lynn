/**
 * tools.js — 暴露插件工具给前端直接调用（v0.77）
 *
 * POST /api/tools/:toolName
 * 支持两种匹配：
 *   1. 精确匹配完整工具名（如 tts-bridge.tts_speak）
 *   2. 唯一后缀匹配（如 tts_speak → 查找唯一以 .tts_speak 结尾的工具）
 */

import { Hono } from "hono";

type PluginTool = {
  name: string;
  execute(body: unknown): Promise<unknown> | unknown;
};

type ToolResolution =
  | { tool: PluginTool; ambiguous: false; matches?: string[] }
  | { tool: null; ambiguous: boolean; matches: string[] };

interface ToolsRouteEngine {
  pluginManager?: {
    getAllTools(): PluginTool[];
  } | null;
}

function resolveToolByName(tools: PluginTool[], toolName: string): ToolResolution {
  const exact = tools.find((t) => t.name === toolName);
  if (exact) return { tool: exact, ambiguous: false };

  const suffixMatches = tools.filter((t) => t.name.endsWith("." + toolName));
  if (suffixMatches.length === 1) {
    return { tool: suffixMatches[0], ambiguous: false };
  }
  if (suffixMatches.length > 1) {
    return {
      tool: null,
      ambiguous: true,
      matches: suffixMatches.map((t) => t.name).sort(),
    };
  }
  return { tool: null, ambiguous: false, matches: [] };
}

export function createToolsRoute(engine: ToolsRouteEngine): Hono {
  const route = new Hono();

  route.post("/:toolName", async (c) => {
    const toolName = c.req.param("toolName");
    const body = await c.req.json().catch(() => ({}));

    const tools = engine.pluginManager?.getAllTools() || [];
    const resolved = resolveToolByName(tools, toolName);

    if (resolved.ambiguous) {
      return c.json({
        error: `Tool alias "${toolName}" is ambiguous`,
        matches: resolved.matches,
      }, 409);
    }

    const tool = resolved.tool;
    if (!tool) {
      return c.json({ error: `Tool "${toolName}" not found` }, 404);
    }

    try {
      const result = await tool.execute(body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return route;
}
