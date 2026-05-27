/**
 * desk-manager.js — Desk 目录管理
 *
 * Desk（書桌）是 agent 的工作台，存放：
 * - cron-jobs.json：定时任务
 * - cron-runs/：执行历史
 * - jian-registry.json：笺指纹注册表
 * - plugins/{pluginId}/：各插件的独立工作区（v0.77 新增）
 */

import fs from "fs";
import path from "path";

export interface PluginWorkspace {
  pluginId: string;
  absPath: string;
}

export interface DeskManager {
  deskDir: string;
  pluginsDir: string;
  ensureDir(): void;
  ensurePluginWorkspace(pluginId: string): string;
  listPluginWorkspaces(): PluginWorkspace[];
}

export function createDeskManager(deskDir: string): DeskManager {
  const runsDir = path.join(deskDir, "cron-runs");
  const pluginsDir = path.join(deskDir, "plugins");

  return {
    /** desk 目录路径 */
    deskDir,

    /** 插件工作区根目录 */
    pluginsDir,

    /**
     * 确保 desk 目录结构存在
     */
    ensureDir() {
      fs.mkdirSync(deskDir, { recursive: true });
      fs.mkdirSync(runsDir, { recursive: true });
      fs.mkdirSync(pluginsDir, { recursive: true });
    },

    ensurePluginWorkspace(pluginId: string): string {
      const dir = path.join(pluginsDir, pluginId);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },

    listPluginWorkspaces(): PluginWorkspace[] {
      if (!fs.existsSync(pluginsDir)) return [];
      return fs.readdirSync(pluginsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => ({
          pluginId: e.name,
          absPath: path.join(pluginsDir, e.name),
        }));
    },
  };
}
