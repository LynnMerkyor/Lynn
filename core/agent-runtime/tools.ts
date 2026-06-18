import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { Tool, ToolResult } from "./types.js";

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function resolveWithin(cwd: string, target: unknown): string {
  const value = String(target || ".");
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export function createReadTool(cwd = process.cwd(), options: { operations?: { readFile?: (absolutePath: string) => Promise<Buffer> | Buffer } } = {}): Tool {
  return {
    name: "read",
    description: "Read a UTF-8 text file.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) {
      const p = params as { path?: string; file_path?: string };
      const file = resolveWithin(cwd, p.path || p.file_path);
      if (options.operations?.readFile) {
        const value = await options.operations.readFile(file);
        return textResult(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
      }
      return textResult(await fs.readFile(file, "utf8"));
    },
  };
}

export function createWriteTool(cwd = process.cwd(), _options: unknown = {}): Tool {
  return {
    name: "write",
    description: "Write a UTF-8 text file.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_id, params) {
      const p = params as { path?: string; file_path?: string; content?: string };
      const file = resolveWithin(cwd, p.path || p.file_path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(p.content || ""), "utf8");
      return textResult(`Wrote ${file}`);
    },
  };
}

export function createEditTool(cwd = process.cwd(), _options: unknown = {}): Tool {
  return {
    name: "edit",
    description: "Replace text inside a UTF-8 file.",
    parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }),
    async execute(_id, params) {
      const p = params as { path?: string; file_path?: string; old?: string; old_string?: string; new?: string; new_string?: string };
      const file = resolveWithin(cwd, p.path || p.file_path);
      const oldText = String(p.old ?? p.old_string ?? "");
      const newText = String(p.new ?? p.new_string ?? "");
      const current = await fs.readFile(file, "utf8");
      if (!oldText || !current.includes(oldText)) return textResult(`Text not found in ${file}`, true);
      await fs.writeFile(file, current.replace(oldText, newText), "utf8");
      return textResult(`Edited ${file}`);
    },
  };
}

export function createLsTool(cwd = process.cwd(), _options: unknown = {}): Tool {
  return {
    name: "ls",
    description: "List directory entries.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const p = params as { path?: string };
      const dir = resolveWithin(cwd, p.path || ".");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return textResult(entries.map((entry) => `${entry.isDirectory() ? "dir " : "file"}\t${entry.name}`).join("\n"));
    },
  };
}

export function createFindTool(cwd = process.cwd(), _options: unknown = {}): Tool {
  return {
    name: "find",
    description: "Find files by substring.",
    parameters: Type.Object({ path: Type.Optional(Type.String()), pattern: Type.String() }),
    async execute(_id, params) {
      const p = params as { path?: string; pattern?: string; name?: string };
      const root = resolveWithin(cwd, p.path || ".");
      const pattern = String(p.pattern || p.name || "");
      const out: string[] = [];
      async function walk(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const full = path.join(dir, entry.name);
          if (entry.name.includes(pattern)) out.push(path.relative(cwd, full) || full);
          if (entry.isDirectory()) await walk(full);
        }
      }
      await walk(root);
      return textResult(out.slice(0, 1000).join("\n"));
    },
  };
}

export function createGrepTool(cwd = process.cwd(), _options: unknown = {}): Tool {
  return {
    name: "grep",
    description: "Search file contents using ripgrep when available.",
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const p = params as { pattern?: string; path?: string };
      const pattern = String(p.pattern || "");
      const target = resolveWithin(cwd, p.path || ".");
      const result = await runCommand("rg", ["--line-number", "--", pattern, target], cwd).catch(async () => {
        const out: string[] = [];
        async function walk(dir: string): Promise<void> {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (await exists(full)) {
              try {
                const text = await fs.readFile(full, "utf8");
                if (text.includes(pattern)) out.push(path.relative(cwd, full));
              } catch {
                // ignore binaries
              }
            }
          }
        }
        await walk(target);
        return out.join("\n");
      });
      return textResult(result);
    },
  };
}

export function createBashTool(cwd = process.cwd(), options: { operations?: { exec?: (...args: any[]) => Promise<unknown> | unknown } } = {}): Tool {
  return {
    name: "bash",
    description: "Run a shell command in the workspace.",
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params) {
      const command = String((params as { command?: string }).command || "");
      if (options.operations?.exec) {
        const value = await options.operations.exec(command, { cwd });
        if (typeof value === "string") return textResult(value);
        return textResult(JSON.stringify(value));
      }
      return textResult(await runShell(command, cwd));
    },
  };
}

async function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || stdout) resolve(stdout.trimEnd());
      else reject(new Error(stderr || `${cmd} exited ${code}`));
    });
  });
}

async function runShell(command: string, cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve((stdout || stderr || `exit ${code}`).trimEnd());
    });
  });
}

export const readTool = createReadTool();
export const writeTool = createWriteTool();
export const editTool = createEditTool();
export const bashTool = createBashTool();
export const grepTool = createGrepTool();
export const findTool = createFindTool();
export const lsTool = createLsTool();
export const codingTools = [readTool, bashTool, editTool, writeTool];
export const readOnlyTools = [readTool, grepTool, findTool, lsTool];
export const allBuiltInTools = [readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool];
export const allTools = allBuiltInTools;

export function createCodingTools(cwd = process.cwd()): Tool[] {
  return [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd)];
}

export function createReadOnlyTools(cwd = process.cwd()): Tool[] {
  return [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}
