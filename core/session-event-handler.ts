import { getLocale } from "../server/i18n.js";
import { runReadToolPromptInjectionGuardrail } from "./claw-aegis-guardrails.js";

type AnyRecord = Record<string, any>;
type AgentLike = AnyRecord;
type SessionEntry = AnyRecord & {
  agentId: string;
  compactionCount?: number;
  relayInProgress?: boolean;
};

interface SessionEventHandlerOptions {
  mapKey: string;
  sessionPath: string | null;
  sessions: Map<string, SessionEntry>;
  getCurrentSessionPath: () => string | null;
  getAgent: () => AgentLike;
  getAgentById?: (agentId: string) => AgentLike | null | undefined;
  resolveSessionRelayConfig: () => {
    enabled?: boolean;
    compactionThreshold?: number;
  };
  relaySession: (sessionPath: string, compactionCount: number) => Promise<unknown>;
  emitEvent: (event: AnyRecord, sessionPath: string | null | undefined) => void;
}

export function createSessionEventHandler(options: SessionEventHandlerOptions) {
  return (event: AnyRecord) => {
    const entryForEvent = options.sessions.get(options.mapKey);
    if (event?.type === "skill_activated" && options.sessionPath) {
      try {
        const eventAgent = entryForEvent
          ? options.getAgentById?.(entryForEvent.agentId)
          : options.getAgent();
        eventAgent?._skillDistiller?.recordSkillActivation({
          skillName: event.skillName,
          skillFilePath: event.skillFilePath,
          sessionPath: options.sessionPath,
        });
      } catch {
        // non-fatal: skill activation telemetry must not break the session
      }
    }
    if (event?.type === "auto_compaction_end" && entryForEvent) {
      entryForEvent.compactionCount = (entryForEvent.compactionCount || 0) + 1;
      const relayCfg = options.resolveSessionRelayConfig();
      if (
        relayCfg.enabled
        && entryForEvent.compactionCount >= (relayCfg.compactionThreshold || 0)
        && !entryForEvent.relayInProgress
        && options.mapKey === options.getCurrentSessionPath()
      ) {
        void options.relaySession(options.mapKey, entryForEvent.compactionCount);
      }
    }
    // 工具失败只记录事件本身，不再向后续上下文注入“停止使用工具”等
    // 指令。模型是否继续调用工具应由模型和真实工具结果决定。
    if (event?.type === "tool_execution_end" && entryForEvent) {
      entryForEvent._toolFailCount = Boolean(event.isError || event.result?.isError)
        ? (entryForEvent._toolFailCount || 0) + 1
        : 0;
      entryForEvent._toolFailDegraded = false;

      // ── ClawAegis 输入层：read 工具返回内容 prompt injection 扫描 ──
      const toolIsError = Boolean(event.isError || event.result?.isError);
      const toolName = event.toolName || event.toolCall?.name || "";
      runReadToolPromptInjectionGuardrail(event, {
        logger: (message) => console.warn(message),
      });

      // ── ClawAegis 输出层：输出验证（AI 声称 vs 实际结果） ──
      if (toolIsError && entryForEvent) {
        const errText = event.result?.content?.[0]?.text || "";
        if (/no such file|not found|ENOENT/i.test(errText) || /permission denied|EACCES/i.test(errText)) {
          // 记录操作失败详情，下一轮 context 中可供 AI 参考
          const isZhV = getLocale().startsWith("zh");
          const failHint = isZhV
            ? `【注意】上一步 ${toolName} 执行失败：${errText.slice(0, 120)}。请检查路径或权限是否正确。`
            : `[Note] Previous ${toolName} failed: ${errText.slice(0, 120)}. Please verify path or permissions.`;
          entryForEvent._lastRecallContext = failHint;
        }
      }
    }
    options.emitEvent(event, options.sessionPath);
  };
}
