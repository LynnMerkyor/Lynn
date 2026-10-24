/**
 * hooks.ts — deterministic lifecycle hooks for the native coding loop.
 *
 * Four events, matching the shape that makes external tooling possible without
 * patching the CLI:
 *
 *   SessionStart      → inject context before the task
 *   UserPromptSubmit  → rewrite/block the submitted task
 *   PreToolUse        → allow/deny/ask before a tool runs (fail-closed)
 *   PostToolUse       → append context after a tool result
 *
 * A hook is a shell command. It receives one JSON object on stdin and may print
 * one JSON object on stdout. Exit code 2 blocks; any other non-zero exit is a
 * warning for notification hooks. PreToolUse and UserPromptSubmit failures block
 * so a guard that cannot run does not silently permit the action.
 *
 * Project hooks live in `<repo>/.lynn/hooks.json` and are ignored unless the
 * checkout is trusted — a cloned repository must not be able to run code on
 * tool use just by being opened.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stopProcessTree } from "./process-tree.js";
import { isProjectTrusted } from "./permission-rules.js";

export type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse";

export interface HookCommand {
  command: string;
  /** Optional regex matched against the tool name (PreToolUse / PostToolUse). */
  matcher?: string;
  timeoutMs?: number;
}

export interface HookConfig {
  hooks: Partial<Record<HookEventName, HookCommand[]>>;
  sources: string[];
  errors: string[];
  invalid?: boolean;
}

export interface HookPayload {
  event: HookEventName;
  cwd: string;
  timestamp: string;
  session_id?: string;
  permission_mode?: string;
  tool?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  prompt?: string;
}

export interface HookOutcome {
  blocked: boolean;
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  additionalContext?: string;
  warnings: string[];
}

const EVENTS: HookEventName[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CONTEXT_CHARS = 8_000;

const EMPTY_CONFIG: HookConfig = { hooks: {}, sources: [], errors: [] };

export async function loadHookConfig(cwd: string, explicitDataDir?: string): Promise<HookConfig> {
  const sources: string[] = [];
  const errors: string[] = [];
  const hooks: HookConfig["hooks"] = {};
  let invalid = false;
  const userPath = hooksPath(explicitDataDir);
  const projectPath = path.join(cwd, ".lynn", "hooks.json");
  const projectTrusted = await isProjectTrusted(cwd, explicitDataDir);

  for (const [label, file, allowed] of [
    ["user", userPath, true],
    ["project", projectPath, projectTrusted],
  ] as const) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (allowed && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        invalid = true;
        errors.push(`cannot read hooks file ${file}`);
      }
      continue;
    }
    if (!allowed) {
      errors.push(`ignored ${file}: repository hooks require "Lynn permissions trust" or LYNN_TRUST_PROJECT_RULES=1`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      invalid = true;
      errors.push(`invalid hooks file ${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const entries = normalizeHookFile(parsed);
    if (!entries) {
      invalid = true;
      errors.push(`hooks file ${file} has no hooks object`);
      continue;
    }
    sources.push(`${label}:${file}`);
    for (const event of EVENTS) {
      const list = entries[event];
      if (!list?.length) continue;
      hooks[event] = [...(hooks[event] || []), ...list];
    }
  }

  return sources.length || errors.length ? { hooks, sources, errors, invalid } : EMPTY_CONFIG;
}

export function hooksPath(explicitDataDir?: string): string {
  const dataDir = explicitDataDir?.trim()
    || process.env.LYNN_DATA_DIR?.trim()
    || path.join(os.homedir(), ".lynn");
  return path.join(dataDir, "hooks.json");
}

export async function runHooks(
  event: HookEventName,
  payload: HookPayload,
  config: HookConfig,
): Promise<HookOutcome> {
  const outcome: HookOutcome = { blocked: false, warnings: [] };
  const hooks = (config.hooks[event] || []).filter((hook) => matchesHook(hook, payload.tool));
  const failClosed = event === "PreToolUse" || event === "UserPromptSubmit";
  if (failClosed && config.invalid) return { blocked: true, decision: "deny", reason: "Invalid hook configuration; correct the hooks file before continuing", warnings: config.errors };

  for (const hook of hooks) {
    const result = await runOneHook(hook, payload);
    if (result.warning) outcome.warnings.push(result.warning);
    if (failClosed && result.warning) {
      outcome.blocked = true;
      outcome.decision = "deny";
      outcome.reason = `${event} hook failed: ${result.warning}`;
      break;
    }
    if (result.blocked) {
      outcome.blocked = true;
      outcome.decision = "deny";
      outcome.reason = result.reason || `${event} hook blocked the action`;
      break;
    }
    if (result.decision === "deny") {
      outcome.blocked = true;
      outcome.decision = "deny";
      outcome.reason = result.reason || `denied by ${event} hook`;
      break;
    }
    if (result.decision === "ask") {
      outcome.decision = "ask";
      if (result.reason) outcome.reason = result.reason;
    }
    if (result.decision === "allow" && outcome.decision !== "ask") outcome.decision = "allow";
    if (result.additionalContext) {
      outcome.additionalContext = [outcome.additionalContext, result.additionalContext]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_CONTEXT_CHARS);
    }
  }

  return outcome;
}

interface OneHookResult {
  blocked: boolean;
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  additionalContext?: string;
  warning?: string;
}

async function runOneHook(hook: HookCommand, payload: HookPayload): Promise<OneHookResult> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      cwd: payload.cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_OUTPUT_BYTES ? current : (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopProcessTree(child);
      resolve({
        blocked: true,
        reason: `hook timed out after ${hook.timeoutMs || DEFAULT_TIMEOUT_MS}ms`,
      });
    }, hook.timeoutMs || DEFAULT_TIMEOUT_MS);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        resolve({ blocked: true, reason: `hook terminated by ${signal}` });
        return;
      }
      const parsed = parseHookOutput(stdout);
      if (code === 2) {
        resolve({ blocked: true, reason: (stderr || parsed?.reason || "blocked by hook").trim() });
        return;
      }
      if (code !== 0) {
        resolve({ blocked: false, warning: `hook exited ${code}: ${(stderr || "no output").trim().slice(0, 300)}` });
        return;
      }
      if (!parsed) {
        resolve({ blocked: false, ...(stdout.trim() ? { warning: "hook returned invalid JSON" } : stderr.trim() ? { warning: stderr.trim().slice(0, 300) } : {}) });
        return;
      }
      if (parsed.continue === false) {
        resolve({ blocked: true, reason: parsed.reason || parsed.stopReason || "blocked by hook" });
        return;
      }
      const decision = parsed.decision || parsed.permissionDecision;
      resolve({
        blocked: false,
        ...(decision ? { decision } : {}),
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        ...(parsed.additionalContext ? { additionalContext: parsed.additionalContext } : {}),
      });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ blocked: true, reason: `hook failed to start: ${error.message}` });
    });
    child.on("close", finish);
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

interface ParsedHookOutput {
  decision?: "allow" | "deny" | "ask";
  permissionDecision?: "allow" | "deny" | "ask";
  reason?: string;
  stopReason?: string;
  additionalContext?: string;
  continue?: boolean;
}

/** Hooks may log before their JSON; parse the last JSON object on stdout. */
export function parseHookOutput(stdout: string): ParsedHookOutput | null {
  const text = stdout.trim();
  if (!text) return null;
  const candidates = [text, ...text.split("\n").reverse().map((line) => line.trim())];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if ((parsed.decision !== undefined && !normalizeDecision(parsed.decision))
        || (parsed.permissionDecision !== undefined && !normalizeDecision(parsed.permissionDecision))
        || (parsed.continue !== undefined && typeof parsed.continue !== "boolean")) return null;
      const decision = normalizeDecision(parsed.decision ?? parsed.permissionDecision);
      const additionalContext = typeof parsed.additionalContext === "string"
        ? parsed.additionalContext
        : typeof parsed.hookSpecificOutput === "object" && parsed.hookSpecificOutput
          ? (parsed.hookSpecificOutput as Record<string, unknown>).additionalContext
          : undefined;
      return {
        ...(decision ? { decision } : {}),
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
        ...(typeof parsed.stopReason === "string" ? { stopReason: parsed.stopReason } : {}),
        ...(typeof additionalContext === "string" ? { additionalContext } : {}),
        ...(parsed.continue === false ? { continue: false } : {}),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeDecision(value: unknown): "allow" | "deny" | "ask" | undefined {
  if (value === "allow" || value === "deny" || value === "ask") return value;
  return undefined;
}

function matchesHook(hook: HookCommand, tool: string | undefined): boolean {
  if (!hook.matcher) return true;
  if (!tool) return false;
  try {
    return new RegExp(hook.matcher).test(tool);
  } catch {
    return false;
  }
}

function normalizeHookFile(value: unknown): Partial<Record<HookEventName, HookCommand[]>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source = record.hooks && typeof record.hooks === "object" && !Array.isArray(record.hooks)
    ? record.hooks as Record<string, unknown>
    : record;
  const out: Partial<Record<HookEventName, HookCommand[]>> = {};
  for (const event of EVENTS) {
    const list = source[event];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return null;
    const commands: HookCommand[] = [];
    for (const entry of list) {
      if (typeof entry === "string") {
        if (!entry.trim()) return null;
        commands.push({ command: entry });
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const recordEntry = entry as Record<string, unknown>;
      if (typeof recordEntry.command !== "string" || !recordEntry.command.trim()) return null;
      if (recordEntry.timeoutMs !== undefined && (typeof recordEntry.timeoutMs !== "number" || !Number.isFinite(recordEntry.timeoutMs) || recordEntry.timeoutMs <= 0)) return null;
      if (recordEntry.matcher !== undefined) {
        if (typeof recordEntry.matcher !== "string") return null;
        try { new RegExp(recordEntry.matcher); } catch { return null; }
      }
      commands.push({
        command: recordEntry.command,
        ...(typeof recordEntry.matcher === "string" ? { matcher: recordEntry.matcher } : {}),
        ...(typeof recordEntry.timeoutMs === "number" ? { timeoutMs: recordEntry.timeoutMs } : {}),
      });
    }
    if (commands.length) out[event] = commands;
  }
  return out;
}
