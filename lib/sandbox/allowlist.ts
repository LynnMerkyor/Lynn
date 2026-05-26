/**
 * allowlist.js — 安全白名单（持久 + 会话）
 *
 * 持久化规则存储在 ~/.lynn/security-allowlist.json。
 * 会话规则只保存在内存中，由 SessionAllowlist 管理。
 */

import fs from "fs";
import path from "path";

interface RuleOptions {
  trustedRoot?: string | null;
  path?: string | null;
}

interface StoredRule {
  category: unknown;
  identifier: unknown;
  trustedRoot: string | null;
}

export interface AllowlistRule {
  category: string;
  identifier: string;
  trustedRoot?: string | null;
}

export interface AllowlistEntry {
  key: string;
  category: unknown;
  identifier: unknown;
  trustedRoot: string | null;
  scope: "persistent" | "session";
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message);
  }
  return String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function normalizeKey(text: string): string {
  if (typeof text !== "string") return "";
  return process.platform === "win32" ? text.toLowerCase() : text;
}

function normalizeRoot(root: unknown): string | null {
  if (!root || typeof root !== "string") return null;
  return path.resolve(root);
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const target = normalizeKey(path.resolve(targetPath));
  const root = normalizeKey(path.resolve(rootPath));
  return target === root || target.startsWith(root + path.sep);
}

function toRule(entryOrCategory: unknown, identifier?: unknown, options: RuleOptions = {}): StoredRule {
  if (isRecord(entryOrCategory)) {
    return {
      category: entryOrCategory.category,
      identifier: entryOrCategory.identifier,
      trustedRoot: normalizeRoot(entryOrCategory.trustedRoot),
    };
  }
  return {
    category: entryOrCategory,
    identifier,
    trustedRoot: normalizeRoot(options.trustedRoot),
  };
}

function ruleKey(rule: StoredRule): string {
  return JSON.stringify({
    category: rule.category,
    identifier: rule.identifier,
    trustedRoot: rule.trustedRoot || null,
  });
}

function matchesRule(
  rule: StoredRule,
  query: Pick<StoredRule, "category" | "identifier"> & { path?: string | null },
): boolean {
  if (rule.category !== query.category || rule.identifier !== query.identifier) return false;
  if (!rule.trustedRoot) return true;
  if (!query.path) return false;
  return isInsideRoot(query.path, rule.trustedRoot);
}

function normalizeLegacyRaw(raw: unknown): StoredRule[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry) => isRecord(entry) && typeof entry.category === "string" && typeof entry.identifier === "string")
      .map((entry) => ({
        category: entry.category,
        identifier: entry.identifier,
        trustedRoot: normalizeRoot(entry.trustedRoot),
      }));
  }

  if (isRecord(raw)) {
    return Object.keys(raw)
      .filter((key) => raw[key])
      .map((key) => {
        const idx = key.indexOf(":");
        return {
          category: key.slice(0, idx),
          identifier: key.slice(idx + 1),
          trustedRoot: null,
        };
      });
  }

  return [];
}

class RuleStore {
  protected _rules: StoredRule[];
  protected _keys: Set<string>;

  constructor(initialRules: unknown[] = []) {
    this._rules = [];
    this._keys = new Set<string>();
    for (const rule of initialRules) {
      this.add(rule);
    }
  }

  check(entryOrCategory: unknown, identifier?: unknown, options: RuleOptions = {}): boolean {
    const query = toRule(entryOrCategory, identifier, options);
    const pathForCheck = options.path || (typeof query.identifier === "string" ? query.identifier : null);
    return this._rules.some((rule) => matchesRule(rule, {
      category: query.category,
      identifier: query.identifier,
      path: pathForCheck,
    }));
  }

  add(entryOrCategory: unknown, identifier?: unknown, options: RuleOptions = {}): boolean {
    const rule = toRule(entryOrCategory, identifier, options);
    if (!rule.category || !rule.identifier) return false;
    const key = ruleKey(rule);
    if (this._keys.has(key)) return false;
    this._keys.add(key);
    this._rules.push(rule);
    return true;
  }

  clear(): void {
    this._rules = [];
    this._keys.clear();
  }

  list(scope: "persistent" | "session" = "persistent"): AllowlistEntry[] {
    return this._rules.map((rule) => ({
      key: ruleKey(rule),
      category: rule.category,
      identifier: rule.identifier,
      trustedRoot: rule.trustedRoot || null,
      scope,
    }));
  }

  removeByKey(key: string): boolean {
    if (!this._keys.has(key)) return false;
    this._rules = this._rules.filter((rule) => ruleKey(rule) !== key);
    this._keys.delete(key);
    return true;
  }

  toJSON(): StoredRule[] {
    return this._rules.map((rule) => ({
      category: rule.category,
      identifier: rule.identifier,
      trustedRoot: rule.trustedRoot || null,
    }));
  }
}

export class SessionAllowlist extends RuleStore {
  constructor() {
    super([]);
  }

  list(): AllowlistEntry[] {
    return super.list("session");
  }
}

export class SecurityAllowlist extends RuleStore {
  /**
   * @param {string} lynnHome  ~/.lynn 目录
   */
  private _path: string;

  constructor(lynnHome: string) {
    super([]);
    this._path = path.join(lynnHome, "security-allowlist.json");

    const loadedRules = SecurityAllowlist._loadFromDisk(this._path);
    for (const rule of loadedRules) {
      super.add(rule);
    }
  }

  static _loadFromDisk(filePath: string): StoredRule[] {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return normalizeLegacyRaw(raw);
    } catch {
      return [];
    }
  }

  add(entryOrCategory: unknown, identifier?: unknown, options: RuleOptions = {}): boolean {
    const changed = super.add(entryOrCategory, identifier, options);
    if (changed) this._save();
    return changed;
  }

  remove(category: unknown, identifier: unknown): void {
    const prefix = JSON.stringify({ category, identifier }).slice(0, -1);
    const before = this._keys.size;
    for (const item of this.list("persistent")) {
      if (item.key.startsWith(prefix)) {
        super.removeByKey(item.key);
      }
    }
    if (this._keys.size !== before) this._save();
  }

  removeByKey(key: string): boolean {
    const changed = super.removeByKey(key);
    if (changed) this._save();
    return changed;
  }

  clear(): void {
    super.clear();
    this._save();
  }

  private _save(): void {
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      const tmp = `${this._path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, this._path);
    } catch (err) {
      console.error("[allowlist] save failed:", errorMessage(err));
    }
  }
}
