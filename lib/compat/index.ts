/**
 * compat/index.js — 启动兼容性检查 & 数据迁移
 *
 * 可扩展架构：每个检查项是一个函数，注册到 checks 数组。
 * agent.init() 时调用 runCompatChecks()，按序执行所有检查。
 *
 * 添加新检查：
 *   1. 在 checks/ 目录新建文件，导出 { name, run(ctx) }
 *   2. 在下方 checks 数组中 import 并注册
 *
 * 每个检查函数接收 ctx 对象：
 *   { agentDir, lynnHome, log }  // lynnHome = ~/.lynn root
 * 返回值无要求，抛异常会被捕获并记录（不影响启动）。
 */

import { checkDirs } from "./checks/dirs.js";
import { checkFactsDb } from "./checks/facts-db.js";
import { checkConfigYaml } from "./checks/config-yaml.js";

export interface CompatCheckContext {
  agentDir: string;
  lynnHome: string;
  log?: (msg: string) => void;
}

interface CompatCheckResult {
  fixed?: boolean;
  message?: string;
}

interface CompatCheck {
  name: string;
  run(ctx: CompatCheckContext): CompatCheckResult | undefined | Promise<CompatCheckResult | undefined>;
}

const checks: CompatCheck[] = [
  { name: "dirs", run: checkDirs },
  { name: "facts-db", run: checkFactsDb },
  { name: "config-yaml", run: checkConfigYaml },
];

/**
 * 执行所有兼容性检查
 *
 */
export async function runCompatChecks(ctx: CompatCheckContext): Promise<void> {
  const log = ctx.log || (() => {});
  let passed = 0;
  let fixed = 0;

  for (const check of checks) {
    try {
      const result = await check.run(ctx);
      if (result?.fixed) {
        fixed++;
        log(`  [compat] ${check.name}: ${result.message || "已修复"}`);
      }
      passed++;
    } catch (err) {
      console.error(`[compat] ${check.name} 检查失败（不影响启动）: ${(err as Error).message}`);
    }
  }

  if (fixed > 0) {
    log(`  [compat] ${passed} 项检查完成，${fixed} 项已修复`);
  }
}
