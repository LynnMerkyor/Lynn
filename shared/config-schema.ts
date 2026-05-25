// shared/config-schema.js

/**
 * 配置字段 scope 声明 — 单一事实来源。
 *
 * - global: 存 preferences.json，跨 agent 共享
 * - agent（默认）: 存 agent config.yaml，per-agent 独立
 *
 * 未在此处声明的字段默认为 agent scope。
 * 嵌套路径最多支持 2 级（如 'capabilities.learn_skills'）。
 */
export type ConfigScope = 'global' | 'agent';

export type FieldDef = {
  scope: ConfigScope;
  setter?: string;
  getter?: string;
};

export const CONFIG_SCHEMA: Record<string, FieldDef> = {
  locale:                       { scope: 'global', setter: 'setLocale',         getter: 'getLocale' },
  timezone:                     { scope: 'global', setter: 'setTimezone',       getter: 'getTimezone' },
  sandbox:                      { scope: 'global', setter: 'setSandbox',        getter: 'getSandbox' },
  update_channel:               { scope: 'global', setter: 'setUpdateChannel',  getter: 'getUpdateChannel' },
  thinking_level:               { scope: 'global', setter: 'setThinkingLevel',  getter: 'getThinkingLevel' },
  'capabilities.learn_skills':  { scope: 'global', setter: 'setLearnSkills',    getter: 'getLearnSkills' },
  'desk.home_folder':           { scope: 'global', setter: 'setHomeFolder',     getter: 'getHomeFolder' },
  'desk.trusted_roots':         { scope: 'global', setter: 'setTrustedRoots',   getter: 'getTrustedRoots' },
};

// 未声明的字段默认为 agent scope，不需要额外导出。
// 迁移逻辑直接遍历 CONFIG_SCHEMA。
