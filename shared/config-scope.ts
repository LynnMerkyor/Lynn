// shared/config-scope.js

import { CONFIG_SCHEMA } from './config-schema.js';

export type SplitByScopeResult = {
  global: Array<{ key: string; value: unknown; setter: string }>;
  agent: Record<string, unknown>;
};

/**
 * 根据 schema 将 partial config 拆分为 global 和 agent 两部分。
 *
 * @param partial - 前端发来的 config patch
 */
export function splitByScope(partial: Record<string, unknown>): SplitByScopeResult {
  const global: SplitByScopeResult['global'] = [];
  const agent: Record<string, unknown> = {};

  // 浅拷贝顶层，对含有嵌套 global 字段的 parent 做额外一层拷贝
  for (const key of Object.keys(partial)) {
    agent[key] = partial[key];
  }
  for (const path of Object.keys(CONFIG_SCHEMA)) {
    const parts = path.split('.');
    const parentValue = agent[parts[0]];
    if (parts.length === 2 && parentValue && typeof parentValue === 'object') {
      agent[parts[0]] = { ...parentValue };
    }
  }

  for (const [path, def] of Object.entries(CONFIG_SCHEMA)) {
    if (def.scope !== 'global' || !def.setter) continue;

    const parts = path.split('.');
    if (parts.length === 1) {
      if (parts[0] in agent && agent[parts[0]] !== undefined) {
        global.push({ key: path, value: agent[parts[0]], setter: def.setter });
        delete agent[parts[0]];
      }
    } else if (parts.length === 2) {
      const [parent, child] = parts;
      const parentValue = agent[parent] as Record<string, unknown> | null | undefined;
      if (parentValue?.[child] !== undefined) {
        global.push({ key: path, value: parentValue[child], setter: def.setter });
        delete parentValue[child];
        if (Object.keys(parentValue).length === 0) delete agent[parent];
      }
    }
    // depth > 2: 不处理，视为 agent scope
  }

  return { global, agent };
}

/**
 * 将 global scope 字段从 engine 注入到 config 对象中。
 *
 * @param config - 将被修改的 config 对象
 * @param engine - 需要有 schema 中声明的 getter 方法
 */
export function injectGlobalFields(config: Record<string, unknown>, engine: Record<string, unknown>): void {
  for (const [path, def] of Object.entries(CONFIG_SCHEMA)) {
    if (def.scope !== 'global' || !def.getter) continue;
    const getter = engine[def.getter];
    if (typeof getter !== 'function') continue;

    const value = (getter as (this: Record<string, unknown>) => unknown).call(engine);
    const parts = path.split('.');

    if (parts.length === 1) {
      config[parts[0]] = value;
    } else if (parts.length === 2) {
      const [parent, child] = parts;
      if (!config[parent] || typeof config[parent] !== 'object') config[parent] = {};
      (config[parent] as Record<string, unknown>)[child] = value;
    }
  }
}
