/**
 * Skills 管理路由
 *
 * GET    /skills              — 列出所有可用 skill（含当前 agent 的 enabled 状态）
 * PUT    /agents/:id/skills   — 更新指定 agent 的 enabled skills 列表
 * POST   /skills/install      — 安装用户技能（文件夹路径 / .zip / .skill）
 * DELETE /skills/:name        — 删除用户技能
 */
import path from "path";
import fs from "fs";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { extractZip } from "../../lib/extract-zip.js";
import { saveConfig } from "../../lib/memory/config-loader.js";
import { parseSkillMetadata } from "../../lib/skills/skill-metadata.js";
import { sanitizeSkillName } from "../../lib/tools/install-skill.js";
import { t } from "../i18n.js";
import { safeCopyDir } from "../../shared/safe-fs.js";

interface RouteSkill {
  name: string;
  description?: string;
  filePath?: string;
  baseDir?: string;
  source?: string;
  hidden?: boolean;
  enabled?: boolean;
  externalLabel?: string | null;
  externalPath?: string | null;
  readonly?: boolean;
  type?: string;
  _hidden?: boolean;
  _readonly?: boolean;
  _externalLabel?: string | null;
  _externalPath?: string | null;
  _agentId?: string | null;
  [key: string]: unknown;
}

interface SkillResponse {
  name: string;
  description: string;
  filePath?: string;
  baseDir?: string;
  source?: string;
  hidden: boolean;
  enabled: boolean;
  externalLabel: string | null;
  externalPath: string | null;
  readonly: boolean;
}

interface RouteAgent {
  agentDir?: string;
  config?: {
    skills?: {
      enabled?: unknown;
    };
  } | null;
}

interface ExternalSkillPath {
  dirPath: string;
  label: string;
}

interface ExternalSkillPathsPayload {
  discovered?: unknown[];
  configured?: unknown[];
}

interface SkillsRouteEngine {
  agentsDir: string;
  userSkillsDir: string;
  skillsDir: string;
  productDir: string;
  currentAgentId?: string | null;
  agent?: RouteAgent | null;
  getAgent?: (id: string) => RouteAgent | null | undefined;
  getAllSkills(agentId?: string): RouteSkill[];
  reloadSkills(): Promise<unknown>;
  updateConfig(partial: Record<string, unknown>): Promise<unknown> | unknown;
  getExternalSkillPaths(): ExternalSkillPathsPayload;
  setExternalSkillPaths(paths: string[]): Promise<unknown> | unknown;
  translateSkillNames(names: string[], lang: string): Promise<Record<string, unknown>> | Record<string, unknown>;
}

interface ScanSkillDirOptions {
  source?: string;
  externalLabel?: string | null;
  externalPath?: string | null;
  readonly?: boolean;
  hidden?: boolean;
  agentId?: string | null;
}

interface UpdateAgentSkillsBody extends Record<string, unknown> {
  enabled?: unknown;
}

interface InstallSkillBody extends Record<string, unknown> {
  path?: unknown;
}

interface InstallBuiltinSkillBody extends Record<string, unknown> {
  id?: unknown;
  aliases?: unknown;
}

interface ExternalPathsBody extends Record<string, unknown> {
  paths?: unknown;
}

interface TranslateSkillNamesBody extends Record<string, unknown> {
  names?: unknown;
  lang?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getEnabledSkills(config: RouteAgent["config"] | Record<string, unknown> | null | undefined): unknown[] {
  const skills = isRecord(config?.skills) ? config.skills : null;
  return Array.isArray(skills?.enabled) ? skills.enabled : [];
}

function validateId(id: string): boolean {
  return id.length > 0 && !id.includes("..") && !id.includes("/") && !id.includes("\\");
}

function agentExists(engine: SkillsRouteEngine, id: string): boolean {
  return fs.existsSync(path.join(engine.agentsDir, id, "config.yaml"));
}

/** 从 SKILL.md frontmatter 解析 name */
function parseSkillName(skillMdPath: string): string | null {
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    return nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

/** 递归删除目录 */
function rmDirSync(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function normalizeSkillToken(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function collectSkillAliases(skill: RouteSkill | null | undefined): Set<string> {
  const aliases = new Set<string>();
  if (skill?.name) aliases.add(normalizeSkillToken(skill.name));
  if (skill?.baseDir) aliases.add(normalizeSkillToken(path.basename(skill.baseDir)));
  if (skill?.filePath) aliases.add(normalizeSkillToken(path.basename(path.dirname(skill.filePath))));
  return aliases;
}

function isSkillEnabled(skill: RouteSkill, enabledAliases: Set<string>): boolean {
  if (!(enabledAliases instanceof Set) || enabledAliases.size === 0) return false;
  for (const alias of collectSkillAliases(skill)) {
    if (enabledAliases.has(alias)) return true;
  }
  return false;
}

function toSkillResponse(skill: RouteSkill, enabledAliases: Set<string>): SkillResponse {
  return {
    name: skill.name,
    description: skill.description || "",
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    source: skill.source,
    hidden: !!skill.hidden || !!skill._hidden,
    enabled: isSkillEnabled(skill, enabledAliases),
    externalLabel: skill.externalLabel ?? skill._externalLabel ?? null,
    externalPath: skill.externalPath ?? skill._externalPath ?? null,
    readonly: !!skill.readonly || !!skill._readonly,
  };
}

function scanSkillDir(rootDir: string, {
  source = "user",
  externalLabel = null,
  externalPath = null,
  readonly = false,
  hidden = false,
  agentId = null,
}: ScanSkillDirOptions = {}): RouteSkill[] {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const results: RouteSkill[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const baseDir = path.join(rootDir, entry.name);
    const skillFile = path.join(baseDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    try {
      const content = fs.readFileSync(skillFile, "utf-8");
      const meta = parseSkillMetadata(content, entry.name);
      results.push({
        name: meta.name,
        description: meta.description,
        filePath: skillFile,
        baseDir,
        source,
        hidden,
        readonly,
        _hidden: hidden,
        _readonly: readonly,
        _externalLabel: externalLabel,
        _externalPath: externalPath,
        _agentId: agentId,
      });
    } catch {
      results.push({
        name: entry.name,
        description: "",
        filePath: skillFile,
        baseDir,
        source,
        hidden,
        readonly,
        _hidden: hidden,
        _readonly: readonly,
        _externalLabel: externalLabel,
        _externalPath: externalPath,
        _agentId: agentId,
      });
    }
  }
  return results;
}

function collectFallbackExternalPaths(engine: SkillsRouteEngine): ExternalSkillPath[] {
  const payload = engine.getExternalSkillPaths() || {};
  const discovered = Array.isArray(payload.discovered) ? payload.discovered : [];
  const configured = Array.isArray(payload.configured) ? payload.configured : [];
  const merged: ExternalSkillPath[] = [];
  const seen = new Set<string>();

  for (const item of discovered) {
    const record = asRecord(item);
    const dirPath = String(record.dirPath || "").trim();
    if (!dirPath || !fs.existsSync(dirPath) || seen.has(dirPath)) continue;
    seen.add(dirPath);
    const label = typeof record.label === "string" && record.label
      ? record.label
      : path.basename(path.dirname(dirPath)) || "External";
    merged.push({ dirPath, label });
  }

  for (const raw of configured) {
    const dirPath = path.resolve(String(raw || ""));
    if (!dirPath || !fs.existsSync(dirPath) || seen.has(dirPath)) continue;
    seen.add(dirPath);
    merged.push({ dirPath, label: path.basename(path.dirname(dirPath)) || "External" });
  }

  return merged;
}

async function listSkillsWithFallback(engine: SkillsRouteEngine, agentId?: string): Promise<Array<RouteSkill | SkillResponse>> {
  let skills = engine.getAllSkills(agentId || undefined) || [];
  if (skills.length > 0) return skills;

  try {
    await engine.reloadSkills();
    skills = engine.getAllSkills(agentId || undefined) || [];
    if (skills.length > 0) return skills;
  } catch {
    // fall through to filesystem scan
  }

  const targetAgent = agentId ? engine.getAgent?.(agentId) : engine.agent;
  const enabledAliases = new Set(
    getEnabledSkills(targetAgent?.config)
      .map(normalizeSkillToken)
      .filter(Boolean),
  );
  const deduped = new Map<string, SkillResponse>();

  const pushSkills = (entries: RouteSkill[]): void => {
    for (const skill of entries) {
      const key = normalizeSkillToken(skill.name);
      if (!key || deduped.has(key)) continue;
      deduped.set(key, toSkillResponse(skill, enabledAliases));
    }
  };

  pushSkills(scanSkillDir(engine.userSkillsDir, { source: "user" }));

  if (targetAgent?.agentDir) {
    pushSkills(scanSkillDir(path.join(targetAgent.agentDir, "learned-skills"), {
      source: "learned",
      agentId: path.basename(targetAgent.agentDir),
    }));
  }

  for (const ext of collectFallbackExternalPaths(engine)) {
    pushSkills(scanSkillDir(ext.dirPath, {
      source: "external",
      externalLabel: ext.label,
      externalPath: ext.dirPath,
      readonly: true,
    }));
  }

  return [...deduped.values()].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    if (!!left.hidden !== !!right.hidden) return left.hidden ? 1 : -1;
    return left.name.localeCompare(right.name, "zh-Hans-CN");
  });
}

async function finalizeInstalledSkill(engine: SkillsRouteEngine, skillDir: string): Promise<RouteSkill> {
  const userDir = engine.userSkillsDir;
  const skillName = parseSkillName(path.join(skillDir, "SKILL.md"));
  if (!skillName) {
    throw new Error(t("error.skillMissingName"));
  }

  const safeName = sanitizeSkillName(skillName);
  if (!safeName) {
    throw new Error(t("error.skillNameInvalid", { name: skillName }));
  }

  const dstDir = path.join(userDir, safeName);
  safeCopyDir(skillDir, dstDir);

  await engine.reloadSkills();

  const agentId = engine.currentAgentId;
  if (agentId) {
    const configPath = path.join(engine.agentsDir, agentId, "config.yaml");
    if (fs.existsSync(configPath)) {
      const { loadConfig } = await import("../../lib/memory/config-loader.js");
      const cfg = loadConfig(configPath);
      const enabled = new Set<unknown>(getEnabledSkills(cfg));
      enabled.add(safeName);
      saveConfig(configPath, { skills: { enabled: [...enabled] } });
      await engine.updateConfig({ skills: { enabled: [...enabled] } });
    }
  }

  const skill = engine.getAllSkills().find((s) => s.name === safeName);
  return skill || { name: safeName, type: "user" };
}

function resolveBundledSkillDir(engine: SkillsRouteEngine, requestedId: string, aliases: string[] = []): string | null {
  const skillsRoot = path.join(engine.productDir, "..", "skills2set");
  if (!fs.existsSync(skillsRoot)) return null;

  const candidates = new Set([
    normalizeSkillToken(requestedId),
    ...aliases.map((alias) => normalizeSkillToken(alias)),
  ]);

  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const baseDir = path.join(skillsRoot, entry.name);
    const skillMdPath = path.join(baseDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    const parsedName = parseSkillName(skillMdPath) || entry.name;
    const matches = [
      normalizeSkillToken(entry.name),
      normalizeSkillToken(parsedName),
    ];
    if (matches.some((token) => candidates.has(token))) {
      return baseDir;
    }
  }

  return null;
}

export function createSkillsRoute(engine: SkillsRouteEngine): Hono {
  const route = new Hono();

  route.get("/skills", async (c) => {
    try {
      const agentId = c.req.query("agentId");
      return c.json({ skills: await listSkillsWithFallback(engine, agentId || undefined) });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  route.put("/agents/:id/skills", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body: UpdateAgentSkillsBody = asRecord(await safeJson<unknown>(c));
      const { enabled } = body;
      if (!Array.isArray(enabled)) {
        return c.json({ error: "enabled must be an array of skill names" }, 400);
      }

      const partial = { skills: { enabled } };
      const configPath = path.join(engine.agentsDir, id, "config.yaml");
      saveConfig(configPath, partial);

      // active agent 需要额外触发 skill 同步
      if (id === engine.currentAgentId) {
        await engine.updateConfig(partial);
      }

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ── 安装用户技能 ──
  route.post("/skills/install", async (c) => {
    try {
      const body: InstallSkillBody = asRecord(await safeJson<unknown>(c));
      const srcPath = typeof body.path === "string" ? body.path : "";
      if (!srcPath || !path.isAbsolute(srcPath)) {
        return c.json({ error: t("error.skillNeedAbsolutePath") }, 400);
      }

      if (!fs.existsSync(srcPath)) {
        return c.json({ error: t("error.skillPathNotExists") }, 400);
      }

      const stat = fs.statSync(srcPath);
      const userDir = engine.userSkillsDir;

      let skillDir: string; // 最终包含 SKILL.md 的目录

      if (stat.isDirectory()) {
        // 直接是文件夹
        if (!fs.existsSync(path.join(srcPath, "SKILL.md"))) {
          return c.json({ error: t("error.skillMissingSkillMd") }, 400);
        }
        skillDir = srcPath;
      } else {
        // .zip 或 .skill 文件
        const ext = path.extname(srcPath).toLowerCase();
        if (ext !== ".zip" && ext !== ".skill") {
          return c.json({ error: t("error.skillUnsupportedFormat") }, 400);
        }

        // 解压到临时目录
        const tmpDir = path.join(userDir, ".tmp-install-" + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        try {
          extractZip(srcPath, tmpDir);

          // 找到 SKILL.md：可能在根目录或一层子目录内
          if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
            skillDir = tmpDir;
          } else {
            const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
              .filter((e) => e.isDirectory() && !e.name.startsWith("."));
            const found = sub.find((e) => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
            if (found) {
              skillDir = path.join(tmpDir, found.name);
            } else {
              rmDirSync(tmpDir);
              return c.json({ error: t("error.skillMissingSkillMdInZip") }, 400);
            }
          }
        } catch (err) {
          rmDirSync(tmpDir);
          return c.json({ error: t("error.skillExtractFailed", { msg: errorMessage(err) }) }, 400);
        }
      }

      const skill = await finalizeInstalledSkill(engine, skillDir);
      for (const entry of fs.readdirSync(userDir)) {
        if (entry.startsWith(".tmp-install-")) {
          rmDirSync(path.join(userDir, entry));
        }
      }
      return c.json({ ok: true, skill });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  route.post("/skills/install-builtin", async (c) => {
    try {
      const body: InstallBuiltinSkillBody = asRecord(await safeJson<unknown>(c));
      const requestedId = String(body.id || "").trim();
      const aliases = Array.isArray(body.aliases) ? body.aliases.map((item) => String(item || "")) : [];
      if (!requestedId) {
        return c.json({ error: "id required" }, 400);
      }

      const skillDir = resolveBundledSkillDir(engine, requestedId, aliases);
      if (!skillDir) {
        return c.json({ error: "builtin skill not found" }, 404);
      }

      const skill = await finalizeInstalledSkill(engine, skillDir);
      return c.json({ ok: true, skill });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ── 外部兼容技能路径 ──
  route.get("/skills/external-paths", async (c) => {
    try {
      return c.json(engine.getExternalSkillPaths());
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  route.put("/skills/external-paths", async (c) => {
    try {
      const body: ExternalPathsBody = asRecord(await safeJson<unknown>(c));
      const { paths } = body;
      if (!Array.isArray(paths)) {
        return c.json({ error: "paths must be an array" }, 400);
      }
      const normalizedPaths: string[] = [];
      for (const p of paths) {
        if (typeof p !== "string") {
          return c.json({ error: t("error.skillPathMustBeAbsolute", { path: p }) }, 400);
        }
        if (!path.isAbsolute(p)) {
          return c.json({ error: t("error.skillPathMustBeAbsolute", { path: p }) }, 400);
        }
        if (path.resolve(p) === path.resolve(engine.skillsDir)) {
          return c.json({ error: t("error.skillCannotAddSelfDir") }, 400);
        }
        normalizedPaths.push(p);
      }
      await engine.setExternalSkillPaths(normalizedPaths);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ── 删除技能 ──
  route.delete("/skills/:name", async (c) => {
    try {
      const name = c.req.param("name");
      if (!sanitizeSkillName(name)) {
        return c.json({ error: t("error.skillInvalidName") }, 400);
      }

      // 外部技能不可删除
      const allSkills = engine.getAllSkills();
      const target = allSkills.find((s) => s.name === name);
      if (target?.readonly) {
        return c.json({ error: t("error.skillExternalCannotDelete") }, 403);
      }

      // 优先查用户技能目录，再查 agent 自学目录
      const userSkillPath = path.join(engine.skillsDir, name);
      const agentDir = engine.agent?.agentDir;
      const learnedSkillPath = agentDir ? path.join(agentDir, "learned-skills", name) : null;

      let skillPath: string | null = null;
      if (fs.existsSync(userSkillPath)) {
        skillPath = userSkillPath;
      } else if (learnedSkillPath && fs.existsSync(learnedSkillPath)) {
        skillPath = learnedSkillPath;
      } else {
        return c.json({ error: t("error.skillNotExists") }, 404);
      }

      // 删除目录
      rmDirSync(skillPath);

      // 从所有 agent 的 enabled 列表中移除
      const agentsDir = engine.agentsDir;
      for (const agentName of fs.readdirSync(agentsDir)) {
        const configPath = path.join(agentsDir, agentName, "config.yaml");
        if (!fs.existsSync(configPath)) continue;
        try {
          const { loadConfig } = await import("../../lib/memory/config-loader.js");
          const cfg = loadConfig(configPath);
          const enabled = getEnabledSkills(cfg);
          if (Array.isArray(enabled) && enabled.includes(name)) {
            const filtered = enabled.filter((n) => n !== name);
            saveConfig(configPath, { skills: { enabled: filtered } });
          }
        } catch (e) {
          console.error(`[skills] 清理 agent ${agentName} 的 skill 引用失败:`, errorMessage(e));
        }
      }

      // 重新加载 skills
      await engine.reloadSkills();

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // POST /skills/reload — 强制重新加载所有技能
  route.post("/skills/reload", async (c) => {
    try {
      await engine.reloadSkills();
      const agentId = c.req.query("agentId");
      return c.json({ ok: true, skills: await listSkillsWithFallback(engine, agentId || undefined) });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // POST /skills/translate — 用工具模型翻译技能名
  route.post("/skills/translate", async (c) => {
    const body: TranslateSkillNamesBody = asRecord(await safeJson<unknown>(c));
    const { names, lang } = body;
    if (!Array.isArray(names) || typeof lang !== "string" || !lang || lang === "en") {
      return c.json({});
    }
    if (!names.every((name): name is string => typeof name === "string")) {
      return c.json({});
    }
    return c.json(await engine.translateSkillNames(names, lang));
  });

  return route;
}
