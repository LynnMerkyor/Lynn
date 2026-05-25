// shared/migrate-config-scope.ts

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { CONFIG_SCHEMA } from './config-schema.js';
import { uniqueTrustedRoots } from './trusted-roots.js';

type JsonRecord = Record<string, unknown>;

type PreferencesRecord = JsonRecord & {
  _configScopeMigrated?: boolean;
  trusted_roots?: unknown;
  home_folder?: unknown;
};

type PreferencesManagerLike = {
  getPreferences: () => PreferencesRecord;
  savePreferences: (preferences: PreferencesRecord) => void;
};

type AgentConfigRecord = JsonRecord;

type AgentConfigSnapshot = {
  id: string;
  path: string;
  config: AgentConfigRecord;
  content: string;
};

type MigrateConfigScopeOptions = {
  agentsDir: string;
  prefs: PreferencesManagerLike;
  primaryAgentId?: string | null;
  log?: (msg: string) => void;
};

const DEFAULTS: Record<string, unknown> = {
  locale: "",
  timezone: "",
  sandbox: true,
  update_channel: "stable",
  thinking_level: "auto",
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function getNestedValue(record: JsonRecord, parts: string[]): unknown {
  if (parts.length === 1) return record[parts[0]];
  const parent = asRecord(record[parts[0]]);
  return parent[parts[1]];
}

function setNestedValue(record: JsonRecord, parts: string[], value: unknown): void {
  if (parts.length === 1) {
    record[parts[0]] = value;
    return;
  }
  const parent = asRecord(record[parts[0]]);
  record[parts[0]] = parent;
  parent[parts[1]] = value;
}

function deleteNestedValue(record: JsonRecord, parts: string[]): boolean {
  if (parts.length === 1) {
    if (!(parts[0] in record)) return false;
    delete record[parts[0]];
    return true;
  }
  const parent = asRecord(record[parts[0]]);
  if (parent[parts[1]] === undefined) return false;
  delete parent[parts[1]];
  if (Object.keys(parent).length === 0) delete record[parts[0]];
  return true;
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 一次性迁移：将 agent config.yaml 中的 global scope 字段
 * 向上迁移到 preferences.json，然后从 config.yaml 中删除。
 */
export function migrateConfigScope({ agentsDir, prefs, primaryAgentId, log = () => {} }: MigrateConfigScopeOptions): void {
  const preferences = prefs.getPreferences();

  if (preferences._configScopeMigrated) return;

  log("[migrate] config scope 迁移开始...");

  const agentConfigs: AgentConfigSnapshot[] = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const content = fs.readFileSync(cfgPath, "utf-8");
        const config = asRecord(YAML.load(content));
        agentConfigs.push({ id: entry.name, path: cfgPath, config, content });
      } catch {}
    }
  } catch {
    return;
  }

  if (agentConfigs.length === 0) {
    preferences._configScopeMigrated = true;
    prefs.savePreferences(preferences);
    return;
  }

  agentConfigs.sort((a, b) => {
    if (a.id === primaryAgentId) return -1;
    if (b.id === primaryAgentId) return 1;
    return 0;
  });

  let prefsChanged = false;
  for (const [schemaPath, def] of Object.entries(CONFIG_SCHEMA)) {
    if (def.scope !== 'global') continue;

    const parts = schemaPath.split('.');
    let prefsValue: unknown;
    if (schemaPath === 'desk.trusted_roots') {
      prefsValue = preferences.trusted_roots;
    } else if (schemaPath === 'desk.home_folder') {
      prefsValue = preferences.home_folder;
    } else {
      prefsValue = getNestedValue(preferences, parts);
    }

    const defaultVal = DEFAULTS[parts[0]];
    const prefsHasValue = schemaPath === 'desk.trusted_roots'
      ? Array.isArray(prefsValue) && prefsValue.length > 0
      : prefsValue !== undefined && prefsValue !== defaultVal;
    if (prefsHasValue) continue;

    for (const ac of agentConfigs) {
      const agentValue = getNestedValue(ac.config, parts);

      if (schemaPath === 'desk.trusted_roots') {
        const normalizedRoots = uniqueTrustedRoots(asUnknownArray(agentValue));
        if (normalizedRoots.length === 0) continue;
        preferences.trusted_roots = normalizedRoots;
        prefsChanged = true;
        log(`[migrate] ${schemaPath}: ${JSON.stringify(normalizedRoots)} migrated from agent "${ac.id}" to preferences`);
        break;
      }

      if (agentValue !== undefined && agentValue !== defaultVal) {
        if (schemaPath === 'desk.home_folder') {
          preferences.home_folder = agentValue;
        } else {
          setNestedValue(preferences, parts, agentValue);
        }
        prefsChanged = true;
        log(`[migrate] ${schemaPath}: "${JSON.stringify(agentValue)}" migrated from agent "${ac.id}" to preferences`);
        break;
      }
    }
  }

  const mergedRoots = uniqueTrustedRoots([
    ...asUnknownArray(preferences.trusted_roots),
    preferences.home_folder,
  ]);
  if (mergedRoots.length > 0) {
    preferences.trusted_roots = mergedRoots;
    prefsChanged = true;
  }

  for (const ac of agentConfigs) {
    let changed = false;
    for (const schemaPath of Object.keys(CONFIG_SCHEMA)) {
      const parts = schemaPath.split('.');
      changed = deleteNestedValue(ac.config, parts) || changed;
    }

    if (changed) {
      const backupPath = ac.path + ".pre-scope-migration";
      if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, ac.content, "utf-8");
      }
      fs.writeFileSync(ac.path, YAML.dump(ac.config, { lineWidth: -1 }), "utf-8");
      log(`[migrate] cleaned global fields from ${ac.id}/config.yaml`);
    }
  }

  preferences._configScopeMigrated = true;
  prefs.savePreferences(preferences);

  log(`[migrate] config scope 迁移完成${prefsChanged ? '' : '（无值变更）'}`);
}
