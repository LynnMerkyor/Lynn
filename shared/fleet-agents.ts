/**
 * shared/fleet-agents.ts — Fleet/CLI agent 的唯一事实源(canonical)。
 *
 * 历史上同一份 agent 名单写了四处:server/fleet/registry.ts、cli/src/agent-registry.ts、
 * desktop TaskBriefForm FALLBACK_AGENTS、shared/fleet-events.ts FleetAgentKind。
 * MiMo 移除碰了全部四处;opencode 在 server(disabled)与 CLI(enabled)间静默漂移。
 * 此后:新增/移除 agent 只改这一个文件;三个消费端各自 map 成本地接口,
 * 端间差异必须是这里的显式字段,不允许在消费端硬编码。
 *
 * 字段约定:
 *   bin        — server fleet 调起的可执行名(小写 lynn)
 *   cliBin     — CLI 自查时的可执行名(自身二进制是大写 Lynn)
 *   enabled    — server fleet 派单开关
 *   cliEnabled — CLI 检测/列表开关(缺省跟随 enabled;opencode 在 CLI 可见但 fleet 不派)
 *   serverOnly — 仅 server 概念(custom 占位),CLI 列表过滤掉
 */

import type { FleetAgentKind } from "./fleet-events.js";

export interface CanonicalFleetAgent {
  id: FleetAgentKind;
  label: string;
  bin: string;
  cliBin: string;
  supportsJsonl: boolean;
  enabled: boolean;
  cliEnabled?: boolean;
  serverOnly?: boolean;
  kind: "built-in" | "external";
  profileHint?: string;
  requiresPreset?: string;
}

export const CANONICAL_FLEET_AGENTS: readonly CanonicalFleetAgent[] = [
  { id: "lynn-cli", label: "Lynn CLI", bin: "lynn", cliBin: "Lynn", supportsJsonl: true, enabled: true, kind: "built-in", profileHint: "current binary" },
  { id: "stepfun-flash", label: "StepFun 3.7 Flash (fast coding)", bin: "lynn", cliBin: "Lynn", supportsJsonl: true, enabled: true, kind: "built-in", profileHint: "built-in profile - BYOK preset stepfun", requiresPreset: "stepfun" },
  { id: "codex-cli", label: "Codex", bin: "codex", cliBin: "codex", supportsJsonl: true, enabled: true, kind: "external" },
  { id: "claude-internal", label: "Claude (internal)", bin: "claude-internal", cliBin: "claude-internal", supportsJsonl: false, enabled: true, kind: "external" },
  { id: "claude-code", label: "Claude Code", bin: "claude", cliBin: "claude", supportsJsonl: true, enabled: true, kind: "external" },
  { id: "qwen-cli", label: "Qwen", bin: "qwen", cliBin: "qwen", supportsJsonl: true, enabled: true, kind: "external" },
  { id: "kimi-cli", label: "Kimi", bin: "kimi", cliBin: "kimi", supportsJsonl: true, enabled: true, kind: "external" },
  { id: "codebuddy", label: "CodeBuddy", bin: "codebuddy", cliBin: "codebuddy", supportsJsonl: true, enabled: true, kind: "external" },
  // opencode:CLI 里可检测可用,fleet 派单默认关(质量未过 fleet 验收)。
  { id: "opencode", label: "OpenCode", bin: "opencode", cliBin: "opencode", supportsJsonl: false, enabled: false, cliEnabled: true, kind: "external" },
  // custom:server 端"自定义命令"占位,CLI 列表不展示。
  { id: "custom", label: "Custom", bin: "", cliBin: "", supportsJsonl: false, enabled: false, serverOnly: true, kind: "external" },
];

/** server fleet 视角(含 disabled 项,派单层自己判 enabled)。 */
export function fleetRegistryAgents(): CanonicalFleetAgent[] {
  return CANONICAL_FLEET_AGENTS.map((agent) => ({ ...agent }));
}

/** CLI 视角:过滤 serverOnly,enabled 看 cliEnabled ?? enabled。 */
export function cliVisibleAgents(): CanonicalFleetAgent[] {
  return CANONICAL_FLEET_AGENTS
    .filter((agent) => !agent.serverOnly)
    .map((agent) => ({ ...agent, enabled: agent.cliEnabled ?? agent.enabled }));
}

/** GUI 兜底视角(拉不到 /api/fleet/registry 时):只展示 fleet 可派单项。 */
export function guiFallbackAgents(): Array<{ id: FleetAgentKind; label: string; enabled: boolean }> {
  return CANONICAL_FLEET_AGENTS
    .filter((agent) => agent.enabled)
    .map((agent) => ({ id: agent.id, label: agent.label, enabled: true }));
}
