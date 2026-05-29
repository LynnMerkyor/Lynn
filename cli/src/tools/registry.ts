import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { applyPatchTool } from "./apply-patch.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { bashTool } from "./bash.js";
import { CLIENT_TOOL_DEFINITIONS, type ClientToolName, type ClientToolResult, type ToolRunContext } from "./types.js";

export { CLIENT_TOOL_DEFINITIONS };

export interface ToolRunInput {
  name: ClientToolName;
  path?: string;
  text?: string;
  query?: string;
  pattern?: string;
  command?: string;
  maxBytes?: number;
}

export async function runClientTool(ctx: ToolRunContext, input: ToolRunInput): Promise<ClientToolResult> {
  switch (input.name) {
    case "read_file":
      return readFileTool(ctx, input.path || ".", input.maxBytes);
    case "write_file":
      return writeFileTool(ctx, input.path || "", input.text || "");
    case "apply_patch":
      return applyPatchTool(ctx, input.text || "");
    case "grep":
      return grepTool(ctx, input.query || "", input.path || ".");
    case "glob":
      return globTool(ctx, input.pattern || "**", input.path || ".");
    case "bash":
      return bashTool(ctx, input.command || "");
    default:
      throw new Error(`unknown client tool: ${String(input.name)}`);
  }
}
