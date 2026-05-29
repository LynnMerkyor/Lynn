export type ClientToolName = "read_file" | "write_file" | "apply_patch" | "grep" | "glob" | "bash";

export interface ClientToolResult {
  ok: boolean;
  tool: ClientToolName;
  output?: unknown;
  error?: string;
}

export interface ToolRunContext {
  cwd: string;
  approval: "ask" | "on-failure" | "never" | "yolo";
  timeoutMs?: number;
}

export interface ClientToolDefinition {
  name: ClientToolName;
  description: string;
  dangerous?: boolean;
}

export const CLIENT_TOOL_DEFINITIONS: readonly ClientToolDefinition[] = Object.freeze([
  { name: "read_file", description: "Read a UTF-8 text file inside the workspace." },
  { name: "write_file", description: "Write a UTF-8 text file inside the workspace.", dangerous: true },
  { name: "apply_patch", description: "Apply a unified diff inside the workspace.", dangerous: true },
  { name: "grep", description: "Search UTF-8 files inside the workspace." },
  { name: "glob", description: "List files matching a simple glob pattern inside the workspace." },
  { name: "bash", description: "Run a shell command in the workspace.", dangerous: true },
]);
