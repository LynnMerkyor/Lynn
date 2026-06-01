import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getStringFlag, type ParsedArgs } from "./args.js";
import { parseImageList } from "./media.js";
import { t } from "./i18n.js";

const pExecFile = promisify(execFile);

export interface CodeContext {
  cwd: string;
  gitStatus: string;
  gitDiffStat: string;
  topFiles: string[];
  packageScripts: Record<string, string>;
}

export async function collectCodeContext(repoCwd: string): Promise<CodeContext> {
  const [gitStatus, gitDiffStat, topFiles, packageScripts] = await Promise.all([
    runGit(["status", "--short"], repoCwd),
    runGit(["diff", "--stat"], repoCwd),
    listTopFiles(repoCwd),
    readPackageScripts(repoCwd),
  ]);
  return { cwd: repoCwd, gitStatus, gitDiffStat, topFiles, packageScripts };
}

export function codeMediaPaths(args: ParsedArgs, inlineMediaPaths: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mediaPath of [...codeImagePaths(args), ...inlineMediaPaths]) {
    if (!mediaPath || seen.has(mediaPath)) continue;
    seen.add(mediaPath);
    out.push(mediaPath);
  }
  return out;
}

export function buildCodePrompt(task: string, context: CodeContext, imagePaths?: readonly string[]): string {
  const scripts = Object.entries(context.packageScripts)
    .slice(0, 20)
    .map(([name, command]) => `- ${name}: ${command}`)
    .join("\n") || "(none)";
  return [
    `Task: ${task}`,
    imagePaths?.length ? `Attached images: ${imagePaths.join(", ")}` : "",
    "",
    `CWD: ${context.cwd}`,
    "",
    "Git status:",
    context.gitStatus || "(clean)",
    "",
    "Git diff stat:",
    context.gitDiffStat || "(none)",
    "",
    "Top-level files:",
    context.topFiles.join("\n") || "(unavailable)",
    "",
    "Package scripts:",
    scripts,
  ].filter((line, index, all) => line || all[index - 1] !== "").join("\n");
}

export function renderMockCodeTask(task: string, context: CodeContext): string {
  return [
    t("mock.code", { task }),
    t("mock.code.cwd", { cwd: context.cwd }),
    t("mock.code.git", { status: context.gitStatus ? t("git.dirty") : t("git.clean") }),
  ].join("\n");
}

async function runGit(args: string[], repoCwd: string): Promise<string> {
  try {
    const { stdout } = await pExecFile("git", args, { cwd: repoCwd, maxBuffer: 256 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function listTopFiles(repoCwd: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(repoCwd, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".") && !["node_modules", "dist", "dist-renderer", "dist-server-bundle"].includes(entry.name))
      .slice(0, 80)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

async function readPackageScripts(repoCwd: string): Promise<Record<string, string>> {
  try {
    const text = await fs.readFile(path.join(repoCwd, "package.json"), "utf8");
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    return parsed.scripts || {};
  } catch {
    return {};
  }
}

function codeImagePaths(args: ParsedArgs): string[] {
  return [
    ...parseImageList(getStringFlag(args.flags, "images")),
    ...parseImageList(getStringFlag(args.flags, "image", "shot")),
  ];
}
