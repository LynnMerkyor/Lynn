import fs from "node:fs/promises";
import path from "node:path";
import { dim, red, supportsColor } from "./terminal-style.js";
import { renderCard } from "./terminal-spinner.js";

export interface LocalReadOnlyCommand {
  name: "pwd" | "ls";
  display: string;
  cwd: string;
  target?: string;
  all?: boolean;
  long?: boolean;
}

export type LocalReadOnlyParseResult =
  | { kind: "command"; command: LocalReadOnlyCommand }
  | { kind: "blocked"; display: string; reason: string }
  | null;

const EXIT_TEXT = new Set(["/exit", "/quit", "exit", "quit", "bye", "再见", "拜拜", "退出", "结束"]);
const LS_FLAGS = new Set(["-a", "-l", "-la", "-al", "-1", "-h", "-lh", "-hl", "-lah", "-lha", "-alh", "-ahl"]);

export function isLocalExitText(raw: string): boolean {
  return EXIT_TEXT.has(raw.trim().toLowerCase());
}

export function parseLocalReadOnlyCommand(raw: string, cwd = process.cwd()): LocalReadOnlyParseResult {
  const tokens = splitCommand(raw);
  if (!tokens.length) return null;
  const head = tokens[0]?.toLowerCase();
  if (head !== "pwd" && head !== "ls" && head !== "ll") return null;
  const display = tokens.join(" ");
  if (head === "pwd") {
    return tokens.length === 1
      ? { kind: "command", command: { name: "pwd", display, cwd } }
      : { kind: "blocked", display, reason: "pwd does not accept arguments here" };
  }

  const args = head === "ll" ? ["-la", ...tokens.slice(1)] : tokens.slice(1);
  let all = false;
  let long = false;
  let target: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!LS_FLAGS.has(arg)) return { kind: "blocked", display, reason: `unsupported ls flag: ${arg}` };
      if (arg.includes("a")) all = true;
      if (arg.includes("l")) long = true;
      continue;
    }
    if (target) return { kind: "blocked", display, reason: "only one relative path is supported" };
    const checked = validateRelativeTarget(arg);
    if (!checked.ok) return { kind: "blocked", display, reason: checked.reason };
    target = arg;
  }
  return { kind: "command", command: { name: "ls", display, cwd, target, all, long } };
}

export function isSafeReadOnlyShellCommand(raw: string): boolean {
  return parseLocalReadOnlyCommand(raw)?.kind === "command";
}

export async function runLocalReadOnlyCommand(command: LocalReadOnlyCommand): Promise<{ ok: boolean; output: string; error?: string }> {
  if (command.name === "pwd") return { ok: true, output: `${command.cwd}\n` };
  const targetPath = command.target ? path.resolve(command.cwd, command.target) : command.cwd;
  if (!isInside(command.cwd, targetPath)) return { ok: false, output: "", error: "path is outside the current workspace" };
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) return { ok: true, output: `${path.basename(targetPath)}\n` };
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const rows = entries
      .filter((entry) => command.all || !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const suffix = entry.isDirectory() ? "/" : "";
        return command.long ? `${entry.isDirectory() ? "d" : "-"} ${entry.name}${suffix}` : `${entry.name}${suffix}`;
      });
    return { ok: true, output: rows.length ? `${rows.join("\n")}\n` : "(empty)\n" };
  } catch (error) {
    return { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export function renderLocalReadOnlyResult(command: LocalReadOnlyCommand, result: { ok: boolean; output: string; error?: string }, stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout): string {
  const color = supportsColor(stream);
  const lines = result.ok ? trimOutput(result.output) : [result.error || "command failed"];
  return renderCard({
    kind: result.ok ? "ok" : "error",
    title: `local ${command.display}`,
    body: lines,
  }, color);
}

export function renderLocalReadOnlyBlocked(blocked: Extract<LocalReadOnlyParseResult, { kind: "blocked" }>, stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout): string {
  const color = supportsColor(stream);
  return renderCard({
    kind: "error",
    title: `local ${blocked.display}`,
    body: [
      red("not run", color),
      dim(blocked.reason, color),
      "Supported here: pwd, ls, ls -la, ll, and one relative path inside the current workspace.",
    ],
  }, color);
}

function trimOutput(output: string): string[] {
  const rows = output.replace(/\s+$/g, "").split(/\r?\n/);
  if (rows.length <= 80) return rows;
  return [...rows.slice(0, 80), `... ${rows.length - 80} more line(s)`];
}

function validateRelativeTarget(value: string): { ok: true } | { ok: false; reason: string } {
  if (!value || value === ".") return { ok: true };
  if (path.isAbsolute(value)) return { ok: false, reason: "absolute paths are not allowed for this shortcut" };
  if (value === "~" || value.startsWith("~/")) return { ok: false, reason: "home paths are not allowed for this shortcut" };
  if (value.split(/[\\/]+/).includes("..")) return { ok: false, reason: "parent-directory traversal is not allowed" };
  return { ok: true };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (const char of raw.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}
