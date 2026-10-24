/**
 * custom-commands.ts — user/project slash commands that expand to a prompt.
 *
 * A command is a Markdown file with optional frontmatter:
 *
 *   ---
 *   description: Deploy the current branch to staging
 *   ---
 *   Deploy $1 to staging and verify the health check. Context: $ARGUMENTS
 *
 * Project commands (`<repo>/.lynn/commands`) win over user commands with the
 * same name. Commands are prompt text only — they never execute on their own,
 * which is why project commands do not require the repository to be trusted.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CustomCommand {
  name: string;
  description: string;
  body: string;
  source: "user" | "project";
  path: string;
}

const MAX_COMMAND_BYTES = 64 * 1024;

export async function loadCustomCommands(cwd: string, explicitDataDir?: string): Promise<CustomCommand[]> {
  const dataDir = explicitDataDir?.trim()
    || process.env.LYNN_DATA_DIR?.trim()
    || path.join(os.homedir(), ".lynn");
  const byName = new Map<string, CustomCommand>();
  for (const [source, dir] of [
    ["user", path.join(dataDir, "commands")],
    ["project", path.join(cwd, ".lynn", "commands")],
  ] as const) {
    for (const command of await readCommandDir(dir, source)) {
      byName.set(command.name, command);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveCustomCommand(
  text: string,
  cwd: string,
  explicitDataDir?: string,
): Promise<{ command: CustomCommand; prompt: string } | null> {
  if (!text.startsWith("/")) return null;
  const match = text.match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1]!;
  const args = (match[2] || "").trim();
  const commands = await loadCustomCommands(cwd, explicitDataDir);
  const command = commands.find((entry) => entry.name === name);
  if (!command) return null;
  return { command, prompt: expandCommand(command, args) };
}

export function expandCommand(command: Pick<CustomCommand, "body">, args: string): string {
  const parts = args.length ? args.split(/\s+/) : [];
  let expanded = command.body;
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9]\b/.test(expanded);
  expanded = expanded.replace(/\$ARGUMENTS/g, args);
  expanded = expanded.replace(/\$([1-9])\b/g, (_match, index: string) => parts[Number(index) - 1] || "");
  if (!hasPlaceholder && args) expanded = `${expanded.trimEnd()}\n\nArguments: ${args}`;
  return expanded.trim();
}

export function parseCommandFile(text: string, fallbackName: string): { name: string; description: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  let body = normalized;
  let description = "";
  let name = fallbackName;
  if (frontmatter) {
    body = normalized.slice(frontmatter[0].length);
    for (const line of frontmatter[1]!.split("\n")) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      if (match[1] === "description") description = match[2]!.trim();
      if (match[1] === "name" && match[2]!.trim()) name = match[2]!.trim();
    }
  }
  return { name, description, body: body.trim() };
}

async function readCommandDir(dir: string, source: "user" | "project"): Promise<CustomCommand[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const commands: CustomCommand[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = path.join(dir, entry);
    let text: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_COMMAND_BYTES) continue;
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseCommandFile(text, entry.slice(0, -3));
    if (!parsed.body.trim()) continue;
    commands.push({
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      source,
      path: file,
    });
  }
  return commands;
}
