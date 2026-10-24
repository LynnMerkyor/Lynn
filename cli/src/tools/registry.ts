import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { applyPatchTool } from "./apply-patch.js";
import { editFileTool } from "./edit.js";
import { readSkillBody } from "../skills.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { bashTool } from "./bash.js";
import { webScanTool } from "./web-scan.js";
import { CLIENT_TOOL_DEFINITIONS, type ClientToolName, type ClientToolResult, type ToolRunContext } from "./types.js";
import { normalizePlanItems } from "../plan-tool.js";

export { CLIENT_TOOL_DEFINITIONS };

export interface ToolRunInput {
  name: ClientToolName;
  path?: string;
  text?: string;
  query?: string;
  pattern?: string;
  command?: string;
  run_in_background?: boolean;
  plan?: unknown;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  maxBytes?: number;
  offset?: number;
  url?: string;
  skill?: string;
}

export async function runClientTool(ctx: ToolRunContext, input: ToolRunInput): Promise<ClientToolResult> {
  ctx.signal?.throwIfAborted();
  if (ctx.sandbox === "read-only" && CLIENT_TOOL_DEFINITIONS.some((tool) => tool.name === input.name && tool.dangerous)) {
    throw new Error(`${input.name} is blocked by read-only sandbox`);
  }
  switch (input.name) {
    case "read_file":
      return readFileTool(ctx, input.path || ".", input.maxBytes, input.offset);
    case "write_file":
      return writeFileTool(ctx, input.path || "", input.text || "");
    case "apply_patch":
      return applyPatchTool(ctx, input.text || "");
    case "edit":
      return editFileTool(ctx, {
        path: input.path || "",
        old_string: input.old_string || "",
        new_string: input.new_string || "",
        replace_all: input.replace_all === true,
      });
    case "grep":
      return grepTool(ctx, input.query || "", input.path || ".");
    case "glob":
      return globTool(ctx, input.pattern || "**", input.path || ".");
    case "bash":
      return bashTool(ctx, input.command || "", { background: input.run_in_background === true });
    case "web_scan":
      return webScanTool(ctx, input.url || "");
    case "update_plan":
      return {
        ok: true,
        tool: "update_plan",
        output: { items: normalizePlanItems(input.plan) },
      };
    case "load_skill": {
      const found = await readSkillBody(input.skill || "", ctx.cwd);
      if (!found) throw new Error(`unknown skill: ${input.skill || "(missing name)"}. Use a name from the available-skills list.`);
      return {
        ok: true,
        tool: "load_skill",
        output: { name: found.skill.name, description: found.skill.description, body: found.body, source: found.skill.source },
      };
    }
    case "exit_plan_mode":
      return {
        ok: true,
        tool: "exit_plan_mode",
        output: {
          plan: typeof input.plan === "string" ? input.plan : "",
          note: "Plan recorded. Writes remain blocked in plan mode; ask the user to approve and switch modes (Shift+Tab or /ask).",
        },
      };
    default:
      throw new Error(`unknown client tool: ${String(input.name)}`);
  }
}
