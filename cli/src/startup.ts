import os from "node:os";
import path from "node:path";
import { readVersionInfo } from "./version.js";

export function displayCwd(cwd: string): string {
  const home = os.homedir();
  const relative = path.relative(home, cwd);
  if (!relative) return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return `~/${relative}`;
  return cwd;
}

export function padLine(label: string, value: string, hint?: string): string {
  const left = `${label}:`.padEnd(11, " ");
  return `${left}${value}${hint ? `   ${hint}` : ""}`;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

export function box(lines: string[]): string {
  const width = Math.max(...lines.map((line) => visibleLength(line)), 51);
  const top = `╭${"─".repeat(width + 2)}╮`;
  const bottom = `╰${"─".repeat(width + 2)}╯`;
  const body = lines.map((line) => `│ ${padVisible(line, width)} │`);
  return [top, ...body, bottom].join("\n");
}

export function renderStartupBanner(input: {
  cwd?: string;
  brainUrl?: string;
  brainStatus?: "online" | "offline" | "unknown";
  modeLabel?: string;
  modelLabel?: string;
  byokLabel?: string;
} = {}): string {
  const version = readVersionInfo().version;
  const brainUrl = input.brainUrl || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const modelLabel = input.modelLabel || process.env.LYNN_CLI_MODEL_LABEL || "MiMo via Brain router (auto)";
  const byokLabel = input.byokLabel || process.env.LYNN_CLI_BYOK_LABEL || "GUI Settings > Providers";
  const brainLabel = input.brainStatus && input.brainStatus !== "unknown"
    ? `${input.brainStatus} · ${brainUrl}`
    : brainUrl;
  const lines = [
    `Lynn CLI (v${version})`,
    "",
    padLine("model", modelLabel, "/model to change"),
    padLine("mode", input.modeLabel || "ask / workspace-write", "Shift+Tab to toggle"),
    padLine("BYOK", byokLabel, "Lynn providers"),
    padLine("brain", brainLabel),
    padLine("directory", displayCwd(input.cwd || process.cwd())),
  ];
  return [
    box(lines),
    "",
    "  Tip: Lynn -p \"prompt\" uses the local Brain router, which defaults to MiMo unless you change it.",
    "       In chat/code, use /fast for low latency or /think for deeper reasoning.",
    "       Use Lynn providers for BYOK setup, or Lynn help to see every command.",
  ].join("\n");
}
