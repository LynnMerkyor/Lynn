/**
 * message-agent-tool.js — Agent 私信工具
 *
 * 让 agent 向其他 agent 发起直达私信，等待回复。
 * 底层走 Hub.send({ from, to }) → AgentMessenger，不经过频道。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

type AgentRef = {
  id: string;
};

type MessageAgentToolOptions = {
  agentId: string;
  listAgents: () => AgentRef[];
  onMessage: (toId: string, text: string, opts?: { maxRounds?: number }) => Promise<string | null>;
};

type MessageAgentParams = {
  to: string;
  message: string;
  max_rounds?: number;
};

type MessageAgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

export function createMessageAgentTool({ agentId, listAgents, onMessage }: MessageAgentToolOptions) {
  return {
    name: "message_agent",
    label: t("toolDef.messageAgent.label"),
    description: t("toolDef.messageAgent.description"),
    parameters: Type.Object({
      to: Type.String({ description: t("toolDef.messageAgent.toDesc") }),
      message: Type.String({ description: t("toolDef.messageAgent.messageDesc") }),
      max_rounds: Type.Optional(Type.Number({
        description: t("toolDef.messageAgent.maxTurnsDesc"),
      })),
    }),
    execute: async (_toolCallId: string, params: MessageAgentParams): Promise<MessageAgentToolResult> => {
      if (params.to === agentId) {
        return { content: [{ type: "text", text: t("error.cannotSelfDm") }] };
      }

      const agents = listAgents();
      if (!agents.find(a => a.id === params.to)) {
        const ids = agents.map(a => a.id).join(", ");
        return {
          content: [{ type: "text", text: t("error.msgAgentNotFound", { id: params.to, ids: ids || "" }) }],
        };
      }

      const reply = await onMessage(params.to, params.message, {
        maxRounds: params.max_rounds,
      });

      return {
        content: [{ type: "text", text: reply || t("error.msgAgentNoReply", { name: params.to }) }],
        details: { from: agentId, to: params.to },
      };
    },
  };
}
