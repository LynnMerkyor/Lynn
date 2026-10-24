/**
 * permission-rules.ts — allow / ask / deny rules for tool calls.
 *
 * The shape follows Claude Code's rules closely enough that muscle memory carries
 * over: `bash(git status *)`, `write_file(src/**)`, `web_scan(domain:docs.rs)`.
 * Precedence is deny > ask > allow > mode default, and an evaluation error denies
 * (fail-closed) rather than silently allowing a call.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClientToolName } from "./tools/types.js";

export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface ParsedRule {
  raw: string;
  tool: string;
  arg?: string;
}

export interface PermissionRuleSet {
  allow: ParsedRule[];
  ask: ParsedRule[];
  deny: ParsedRule[];
  errors: string[];
}

export interface PermissionVerdict {
  decision: "allow" | "ask" | "deny";
  reason: string;
  rule?: string;
}

export interface LoadedPermissionRules {
  rules: PermissionRuleSet;
  sources: string[];
}

export interface LoadPermissionOptions {
  /** Honour `allow` rules from the repository's `.lynn/settings.json`. */
  trustProject?: boolean;
}

const RULE_LIMIT = 500;

/**
 * Parse `tool`, `tool(arg)`, or `tool(*)`.
 * Throws on malformed input so callers can surface the offending rule verbatim.
 */
export function parsePermissionRule(raw: string): ParsedRule {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("empty permission rule");
  const match = text.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$/s);
  if (!match) throw new Error(`invalid permission rule "${text}"`);
  const tool = normalizeToolName(match[1]!);
  const arg = match[2];
  if (arg !== undefined && arg.trim() === "") throw new Error(`permission rule "${text}" has an empty argument pattern`);
  return { raw: text, tool, ...(arg !== undefined ? { arg: arg.trim() } : {}) };
}

export function parseRuleSet(input: Partial<PermissionRules> | undefined): PermissionRuleSet {
  const rules: PermissionRuleSet = { allow: [], ask: [], deny: [], errors: [] };
  for (const key of ["allow", "ask", "deny"] as const) {
    if (input?.[key] !== undefined && (!Array.isArray(input[key]) || input[key]!.some(entry => typeof entry !== "string" || !entry.trim()))) {
      rules.errors.push(`${key} must be an array of nonempty permission rules`);
      continue;
    }
    for (const raw of asStringArray(input?.[key])) {
      try {
        rules[key].push(parsePermissionRule(raw));
      } catch (error) {
        rules.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return rules;
}

/** Subject of a rule: which piece of the tool input the pattern is compared to. */
export function ruleSubject(tool: ClientToolName | string, args: Record<string, unknown> = {}): string | undefined {
  const value = (key: string) => (typeof args[key] === "string" ? String(args[key]) : undefined);
  switch (normalizeToolName(tool)) {
    case "bash":
      return value("command");
    case "read_file":
    case "write_file":
    case "edit":
      return value("path");
    case "grep":
    case "glob":
      return value("path") ?? ".";
    case "web_scan":
      return value("url");
    default:
      return undefined;
  }
}

export function decidePermission(
  tool: ClientToolName | string,
  args: Record<string, unknown> | undefined,
  rules: PermissionRuleSet,
): PermissionVerdict {
  try {
    if (rules.errors.length) return { decision: "deny", reason: `Invalid permission configuration: ${rules.errors.join("; ")}` };
    const subject = ruleSubject(tool, args);
    for (const [decision, list] of [["deny", rules.deny], ["ask", rules.ask], ["allow", rules.allow]] as const) {
      const hit = list.find((rule) => {
        if (decision === "allow" && normalizeToolName(tool) === "bash" && subject
          && /[;&|`$<>\r\n]/.test(subject) && rule.arg !== undefined && rule.arg !== "*" && rule.arg !== subject) return false;
        return ruleMatches(rule, tool, subject);
      });
      if (hit) {
        return {
          decision,
          rule: hit.raw,
          reason: decision === "deny"
            ? `blocked by rule ${hit.raw}`
            : decision === "ask"
              ? `rule ${hit.raw} requires approval`
              : `allowed by rule ${hit.raw}`,
        };
      }
    }
    return { decision: "ask", reason: "no matching permission rule" };
  } catch (error) {
    return { decision: "deny", reason: `permission evaluation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function ruleMatches(rule: ParsedRule, tool: ClientToolName | string, subject: string | undefined): boolean {
  if (rule.tool !== normalizeToolName(tool)) return false;
  if (rule.arg === undefined || rule.arg === "*") return true;
  if (subject === undefined) return false;
  return matchPattern(rule.arg, subject, rule.tool === "bash");
}

/**
 * A rule the "don't ask again" action can persist. Kept deliberately narrow:
 * the broadest prefix that still covers the approved invocation.
 */
export function alwaysAllowRule(tool: ClientToolName | string, args: Record<string, unknown> = {}): string | null {
  const name = normalizeToolName(tool);
  const subject = ruleSubject(tool, args);
  if (name === "bash") {
    const command = String(args.command ?? "").trim();
    if (!command || /[*?\r\n]/.test(command)) return null;
    return `bash(${command})`;
  }
  if (name === "web_scan") {
    try {
      return `web_scan(domain:${new URL(String(subject)).host})`;
    } catch {
      return null;
    }
  }
  if (subject && !/[*?\r\n]/.test(subject)) return `${name}(${subject})`;
  return null;
}

export async function loadPermissionRules(
  cwd: string,
  explicitDataDir?: string,
  options: LoadPermissionOptions = {},
): Promise<LoadedPermissionRules> {
  const errors: string[] = [];
  const invalidRules: string[] = [];
  const merged: PermissionRules = { allow: [], ask: [], deny: [] };
  const sources: string[] = [];
  const userPath = permissionRulesPath(explicitDataDir);
  const projectPath = path.join(cwd, ".lynn", "settings.json");
  const trustProject = options.trustProject ?? await isProjectTrusted(cwd, explicitDataDir);

  for (const [label, file] of [["user", userPath], ["project", projectPath]] as const) {
    const parsed = await readRulesFile(file);
    if (!parsed) continue;
    sources.push(`${label}:${file}`);
    // A cloned repository must not be able to pre-approve commands. Project
    // settings may always narrow (deny/ask) but may only widen when the user has
    // explicitly trusted this checkout.
    const projectAllowBlocked = label === "project" && !trustProject;
    for (const key of ["allow", "ask", "deny"] as const) {
      if (key === "allow" && projectAllowBlocked) continue;
      merged[key].push(...parsed[key]);
    }
    if (projectAllowBlocked && parsed.allow.length) {
      errors.push(
        `ignored ${parsed.allow.length} allow rule(s) from ${file}: repository-controlled rules cannot grant approval. `
        + "Approve once with the `d` option to save a user rule, run `Lynn permissions trust`, or set LYNN_TRUST_PROJECT_RULES=1 after reviewing the file.",
      );
    }
    errors.push(...parsed.errors);
    invalidRules.push(...parsed.errors);
  }

  const rules = parseRuleSet(merged);
  rules.errors.push(...invalidRules);
  return { rules, sources: [...sources, ...errors.map((error) => `error:${error}`)] };
}

export function trustedProjectsPath(explicitDataDir?: string): string {
  return path.join(path.dirname(permissionRulesPath(explicitDataDir)), "trusted-projects.json");
}

export async function isProjectTrusted(cwd: string, explicitDataDir?: string): Promise<boolean> {
  if (process.env.LYNN_TRUST_PROJECT_RULES === "1") return true;
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const json = await readJson(trustedProjectsPath(explicitDataDir));
  const trusted = Array.isArray(json?.trusted) ? json.trusted.filter((entry): entry is string => typeof entry === "string") : [];
  return trusted.includes(root);
}

/** Persist trust for one checkout after the user has reviewed its settings. */
export async function trustProject(cwd: string, explicitDataDir?: string): Promise<string> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const file = trustedProjectsPath(explicitDataDir);
  const json = (await readJson(file)) || {};
  const trusted = new Set(Array.isArray(json.trusted) ? json.trusted.filter((entry): entry is string => typeof entry === "string") : []);
  trusted.add(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...json, trusted: [...trusted] }, null, 2)}\n`, "utf8");
  return file;
}

/** Persist a rule from the "don't ask again" approval action. */
export async function saveAlwaysAllowRule(rule: string, explicitDataDir?: string): Promise<string> {
  const file = permissionRulesPath(explicitDataDir);
  const existing = (await readJson(file)) || {};
  const allow = new Set(asStringArray(existing.allow));
  allow.add(rule);
  const next = { ...existing, allow: [...allow].slice(-RULE_LIMIT) };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}

export function permissionRulesPath(explicitDataDir?: string): string {
  const dataDir = explicitDataDir?.trim()
    || process.env.LYNN_DATA_DIR?.trim()
    || path.join(os.homedir(), ".lynn");
  return path.join(dataDir, "permissions", "cli.json");
}

function matchPattern(pattern: string, subject: string, shell = false): boolean {
  if (pattern.startsWith("domain:")) {
    const domain = pattern.slice("domain:".length).trim().toLowerCase();
    try {
      const host = new URL(subject).hostname.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  }
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}:`);
  }
  if (pattern.includes("*") || pattern.includes("?")) {
    return globToRegExp(pattern, shell).test(subject);
  }
  return subject === pattern;
}

function globToRegExp(pattern: string, shell = false): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += shell ? ".*" : "[^/]*";
      }
    } else if (char === "?") {
      source += shell ? "." : "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "s");
}

function normalizeToolName(tool: string): string {
  const name = String(tool || "").trim().toLowerCase().replace(/-/g, "_");
  if (name === "shell" || name === "sh") return "bash";
  if (name === "read") return "read_file";
  if (name === "write") return "write_file";
  return name;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

async function readRulesFile(file: string): Promise<(PermissionRules & { errors: string[] }) | null> {
  try {
    const json: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isPlainObject(json)) throw new Error("permission settings must be an object");
    if (json.permissions !== undefined && !isPlainObject(json.permissions)) throw new Error("permissions must be an object");
    const nested = isPlainObject(json.permissions) ? json.permissions : json;
    const rules = parseRuleSet(nested);
    return {
      allow: asStringArray(nested.allow), ask: asStringArray(nested.ask), deny: asStringArray(nested.deny),
      errors: rules.errors.map(error => `${file}: ${error}`),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { allow: [], ask: [], deny: [], errors: [`Cannot load permission rules ${file}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
