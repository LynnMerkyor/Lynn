/**
 * skills.ts — progressive-disclosure instruction packs.
 *
 * Only the name and one-line description go into the prompt. The body is read
 * on demand by the `load_skill` tool, so a repository can ship twenty skills
 * without paying for twenty instruction documents on every request.
 *
 * Layout:
 *   <repo>/.lynn/skills/<name>/SKILL.md
 *   <dataDir>/skills/<name>/SKILL.md
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
  source: "user" | "project";
}

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_BODY_CHARS = 20_000;

export async function loadSkillCatalog(cwd: string, explicitDataDir?: string): Promise<Skill[]> {
  const dataDir = explicitDataDir?.trim()
    || process.env.LYNN_DATA_DIR?.trim()
    || path.join(os.homedir(), ".lynn");
  const byName = new Map<string, Skill>();
  for (const [source, dir] of [
    ["user", path.join(dataDir, "skills")],
    ["project", path.join(cwd, ".lynn", "skills")],
  ] as const) {
    for (const skill of await readSkillDir(dir, source)) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatSkillListing(skills: readonly Skill[]): string {
  if (!skills.length) return "";
  return [
    "The following skills are available. Call load_skill(name) to read the full instructions before using one — do not guess a name.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`),
  ].join("\n");
}

export async function readSkillBody(name: string, cwd: string, explicitDataDir?: string): Promise<{ skill: Skill; body: string } | null> {
  const catalog = await loadSkillCatalog(cwd, explicitDataDir);
  const skill = catalog.find((entry) => entry.name === name || entry.path.includes(`${path.sep}${name}${path.sep}`));
  if (!skill) return null;
  const body = skill.body.length > MAX_BODY_CHARS
    ? `${skill.body.slice(0, MAX_BODY_CHARS)}\n…[truncated at ${MAX_BODY_CHARS} chars]`
    : skill.body;
  return { skill, body };
}

export function parseSkillFile(text: string, fallbackName: string): { name: string; description: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  let body = normalized;
  let name = fallbackName;
  let description = "";
  if (frontmatter) {
    body = normalized.slice(frontmatter[0].length);
    for (const line of frontmatter[1]!.split("\n")) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      if (match[1] === "name" && match[2]!.trim()) name = match[2]!.trim();
      if (match[1] === "description") description = match[2]!.trim();
    }
  }
  return { name, description, body: body.trim() };
}

async function readSkillDir(dir: string, source: "user" | "project"): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }).then((list) => list.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry, "SKILL.md");
    let text: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_SKILL_BYTES) continue;
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillFile(text, entry);
    if (!parsed.body.trim()) continue;
    skills.push({
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      path: file,
      source,
    });
  }
  return skills;
}
