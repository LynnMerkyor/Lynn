/**
 * ExpertLoader — 从磁盘加载专家预设
 *
 * 扫描 lib/experts/presets/ 目录，读取每个专家的 expert.yaml。
 * 返回标准化的专家配置对象数组。
 */
import fs from "fs";
import path from "path";
import YAML from "js-yaml";

export interface ExpertI18nText {
  en?: string;
  zh?: string;
  ja?: string;
  [locale: string]: string | undefined;
}

export interface ExpertModelBinding {
  preferred: string;
  fallback?: string;
  [key: string]: unknown;
}

export interface ExpertCreditCost {
  per_session: number;
  per_extra_round?: number;
  [key: string]: unknown;
}

export interface ExpertPreset {
  slug: string;
  name: ExpertI18nText;
  icon: string;
  category: string;
  tier: "expert";
  model_binding: ExpertModelBinding;
  credit_cost: ExpertCreditCost;
  skills: string[];
  description: ExpertI18nText;
  _dir: string;
  _identity: string;
  _ishiki: string;
}

interface ExpertYamlConfig {
  slug?: unknown;
  name?: unknown;
  icon?: unknown;
  category?: unknown;
  model_binding?: unknown;
  credit_cost?: unknown;
  skills?: unknown;
  description?: unknown;
}

function asExpertYamlConfig(value: unknown): ExpertYamlConfig | null {
  if (!value || typeof value !== "object") return null;
  return value as ExpertYamlConfig;
}

/**
 * 扫描预设目录，返回所有专家预设配置
 */
export function loadPresets(presetsDir: string): ExpertPreset[] {
  if (!fs.existsSync(presetsDir)) return [];

  const entries = fs.readdirSync(presetsDir, { withFileTypes: true });
  const presets: ExpertPreset[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const expertDir = path.join(presetsDir, entry.name);
    const expertYamlPath = path.join(expertDir, "expert.yaml");

    if (!fs.existsSync(expertYamlPath)) continue;

    try {
      const raw = fs.readFileSync(expertYamlPath, "utf-8");
      const config = asExpertYamlConfig(YAML.load(raw));

      if (!config?.slug) {
        console.warn(`[expert-loader] 跳过 ${entry.name}：缺少 slug`);
        continue;
      }

      // 读取 identity.md（可选）
      let identity = "";
      try {
        identity = fs.readFileSync(path.join(expertDir, "identity.md"), "utf-8");
      } catch {}

      // 读取 ishiki.md（可选）
      let ishiki = "";
      try {
        ishiki = fs.readFileSync(path.join(expertDir, "ishiki.md"), "utf-8");
      } catch {}

      // 读取专家技能目录
      const skillNames: string[] = [];
      const skillsDir = path.join(expertDir, "skills");
      if (fs.existsSync(skillsDir)) {
        try {
          const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
          for (const se of skillEntries) {
            if (se.isDirectory() && fs.existsSync(path.join(skillsDir, se.name, "SKILL.md"))) {
              skillNames.push(se.name);
            }
          }
        } catch {}
      }

      presets.push({
        slug: config.slug as string,
        name: (config.name || { en: entry.name }) as ExpertI18nText,
        icon: (config.icon || "🤖") as string,
        category: (config.category || "general") as string,
        tier: "expert",
        model_binding: (config.model_binding || {
          preferred: "claude-sonnet-4",
          fallback: "claude-sonnet-4",
        }) as ExpertModelBinding,
        credit_cost: (config.credit_cost || {
          per_session: 20,
          per_extra_round: 5,
        }) as ExpertCreditCost,
        skills: (config.skills || skillNames) as string[],
        description: (config.description || {}) as ExpertI18nText,
        _dir: expertDir,
        _identity: identity,
        _ishiki: ishiki,
      });
    } catch (err) {
      console.warn(`[expert-loader] 加载 ${entry.name} 失败: ${(err as { message: unknown }).message}`);
    }
  }

  return presets;
}

/**
 * 根据 slug 加载单个专家预设
 */
export function loadPresetBySlug(presetsDir: string, slug: string): ExpertPreset | null {
  const all = loadPresets(presetsDir);
  return all.find(p => p.slug === slug) || null;
}
