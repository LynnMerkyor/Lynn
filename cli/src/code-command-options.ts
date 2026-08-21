import path from "node:path";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { bestEnabled } from "./code-best.js";
import type { CodeHarnessMode } from "./codex-harness-selection.js";
import type { ToolRunContext } from "./tools/types.js";

const DEFAULT_MAX_STEPS = 100;
const LONG_MAX_STEPS = 300;

export function approval(args: ParsedArgs): "ask" | "on-failure" | "never" | "yolo" {
  const value = getStringFlag(args.flags, "approval");
  if (value === "ask" || value === "on-failure" || value === "never" || value === "yolo") return value;
  return "ask";
}

export function codeCwd(args: ParsedArgs): string {
  return getStringFlag(args.flags, "cwd") || process.cwd();
}

export function timeoutMs(args: ParsedArgs): number | undefined {
  const raw = getStringFlag(args.flags, "timeout-ms", "timeout");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--timeout-ms must be a positive integer");
  return parsed;
}

export function sandbox(args: ParsedArgs): ToolRunContext["sandbox"] {
  const value = getStringFlag(args.flags, "sandbox");
  if (value === "read-only" || value === "danger-full-access") return value;
  return "workspace-write";
}

export function codeHarness(args: ParsedArgs): CodeHarnessMode {
  const value = (getStringFlag(args.flags, "harness") || process.env.LYNN_AGENT_HARNESS || "auto").trim().toLowerCase();
  if (value === "auto" || value === "legacy" || value === "codex") return value;
  throw new Error("--harness must be auto, legacy, or codex");
}

export function isLongRun(args: ParsedArgs): boolean {
  return hasFlag(args.flags, "long", "endurance");
}

export function withLongRunCodeFlags(flags: Record<string, string | boolean> = {}): Record<string, string | boolean> {
  return {
    ...flags,
    long: flags.long ?? true,
    "save-session": flags["save-session"] ?? true,
    "max-steps": flags["max-steps"] ?? String(LONG_MAX_STEPS),
  };
}

export function parseCodeResumeSlash(raw: string): { resume: string; task: string } {
  const text = raw.trim();
  const body = text.replace(/^\/(?:resume|continue)\b/i, "").trim();
  if (!body) return { resume: "last", task: "继续这个任务" };
  const [first = "", ...rest] = body.split(/\s+/);
  const looksLikeResumeRef = first === "last"
    || first === "latest"
    || first.endsWith(".jsonl")
    || first.startsWith("/")
    || first.startsWith("~")
    || first.includes(path.sep);
  if (!looksLikeResumeRef) return { resume: "last", task: body };
  return { resume: first, task: rest.join(" ").trim() || "继续这个任务" };
}

export function maxSteps(args: ParsedArgs): number {
  const raw = getStringFlag(args.flags, "max-steps", "steps");
  if (!raw) return bestEnabled(args) ? LONG_MAX_STEPS : DEFAULT_MAX_STEPS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > LONG_MAX_STEPS) {
    throw new Error(`--max-steps must be an integer from 1 to ${LONG_MAX_STEPS}`);
  }
  return parsed;
}
