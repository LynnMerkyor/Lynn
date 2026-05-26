/**
 * permissions.ts — Desk 权限接口
 *
 * v1 stub：所有 agent 都有完整权限。
 * 未来可从 config.yaml 或全局配置读取权限表，
 * 实现细粒度的 agent 级访问控制。
 *
 * 设计思路：
 * - 权限检查在工具执行前调用，拒绝则返回错误给 LLM
 * - 每个权限是一个字符串常量
 * - canAccess(agentId, permission) 返回 boolean
 */

/**
 * 权限常量
 */
export const DeskPermission = {
  /** 创建/管理 cron 任务 */
  CRON: "cron",
  /** 读写 jian.md */
  JIAN: "jian",
  /** 执行 heartbeat（系统内部） */
  HEARTBEAT: "heartbeat",
} as const;

/** Desk 权限类型 */
export type DeskPermissionType = typeof DeskPermission[keyof typeof DeskPermission];

/** Agent 配置接口（未来扩展） */
export interface AgentConfig {
  desk?: {
    permissions?: {
      [agentId: string]: string[];
    };
  };
}

/**
 * 检查 agent 是否有指定权限
 *
 * @param agentId - agent ID
 * @param permission - DeskPermission 常量
 * @param config - agent 配置（未来可从中读取权限表）
 * @returns boolean
 */
export function canAccess(agentId: string, permission: string, config?: AgentConfig): boolean {
  // v1：所有 agent 都有权限
  // 未来：检查 config.desk?.permissions?.[agentId] 白名单
  //
  // 预期的 config 结构（v2）:
  // desk:
  //   permissions:
  //     hana: [cron, jian, heartbeat]
  //     miku: [jian]
  //     helper: []
  return true;
}
