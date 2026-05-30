import os from "node:os";
import path from "node:path";
import { readVersionInfo } from "./version.js";
import { t } from "./i18n.js";

export function displayCwd(cwd: string): string {
  const home = os.homedir();
  const relative = path.relative(home, cwd);
  if (!relative) return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return `~/${relative}`;
  return cwd;
}

export function padLine(label: string, value: string, hint?: string): string {
  const left = padVisible(`${label}:`, 11);
  return `${left}${value}${hint ? `   ${hint}` : ""}`;
}

export function visibleLength(value: string): number {
  let width = 0;
  for (const char of value.replace(/\x1b\[[0-9;]*m/g, "")) {
    width += charWidth(char);
  }
  return width;
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) || 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    )
  ) {
    return 2;
  }
  return 1;
}

function padVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function wrapVisible(line: string, width: number): string[] {
  if (visibleLength(line) <= width) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && visibleLength(candidate) > width) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

function compactFrameLine(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  const hintIndex = line.lastIndexOf("   ");
  if (hintIndex < 0) return line;
  const suffix = line.slice(hintIndex).trim();
  if (!isOptionalRowHint(suffix)) return line;
  const withoutHint = line.slice(0, hintIndex).trimEnd();
  return visibleLength(withoutHint) <= width ? withoutHint : line;
}

function isOptionalRowHint(value: string): boolean {
  return value === "Lynn providers"
    || value.startsWith("/model")
    || value.startsWith("Shift+Tab");
}

export function box(lines: string[]): string {
  // Cap width so one long line (e.g. BYOK guidance) can't blow the box out to
  // the full terminal width; wrap long lines instead of widening the frame.
  const cap = Math.min(Math.max((process.stdout.columns ?? 80) - 4, 44), 72);
  const wrapped = lines.flatMap((line) => wrapVisible(compactFrameLine(line, cap), cap));
  const width = Math.max(...wrapped.map((line) => visibleLength(line)), Math.min(51, cap));
  const top = `╭${"─".repeat(width + 2)}╮`;
  const bottom = `╰${"─".repeat(width + 2)}╯`;
  const body = wrapped.map((line) => `│ ${padVisible(line, width)} │`);
  return [top, ...body, bottom].join("\n");
}

export function renderStartupBanner(input: {
  cwd?: string;
  brainUrl?: string;
  brainStatus?: "online" | "offline" | "unknown";
  modeLabel?: string;
  modelLabel?: string;
  byokLabel?: string;
  showTips?: boolean;
} = {}): string {
  const version = readVersionInfo().version;
  const brainUrl = input.brainUrl || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const modelLabel = input.modelLabel || process.env.LYNN_CLI_MODEL_LABEL || "MiMo";
  const byokLabel = input.byokLabel || process.env.LYNN_CLI_BYOK_LABEL || t("startup.byok.default");
  const brainLabel = input.brainStatus && input.brainStatus !== "unknown"
    ? `${input.brainStatus} · ${brainUrl}`
    : brainUrl;
  const lines = [
    `Lynn CLI (v${version})`,
    "",
    padLine(t("startup.label.model"), modelLabel, t("startup.hint.model")),
    padLine(t("startup.label.mode"), compactModeLabel(input.modeLabel || "ask / workspace-write"), t("startup.hint.mode")),
    padLine(t("startup.label.byok"), byokLabel, "Lynn providers"),
    padLine(t("startup.label.brain"), brainLabel),
    padLine(t("startup.label.directory"), displayCwd(input.cwd || process.cwd())),
  ];
  const out = [box(lines)];
  if (input.showTips !== false) {
    out.push("", t("tips.banner"));
  }
  return out.join("\n");
}

function compactModeLabel(value: string): string {
  return value
    .replace(/\bworkspace-write\b/g, "workspace")
    .replace(/\bdanger-full-access\b/g, "yolo");
}
