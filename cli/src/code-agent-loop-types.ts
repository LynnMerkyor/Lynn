import {
type AgentRunLifecycle,
type AgentRunSnapshot,
type AgentRunTerminal
} from "../../shared/agent-run-lifecycle.js";
import { type ChatMessage } from "./brain-client.js";
import { type CodeContext } from "./code-context.js";
import { type CodeToolRequest } from "./code-tool-protocol.js";
import type { CodexAppServerProtocol } from "./codex-harness-selection.js";
import { type CodePlanItem } from "./plan-tool.js";
import type { CliProviderProfile } from "./provider-profile.js";
import { parseReasoningOptions } from "./reasoning.js";
import type { ClientToolName, ClientToolResult, ToolRunContext } from "./tools/types.js";


export interface CodeAgentLoopInput {
  task: string;
  context: CodeContext;
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  maxSteps: number;
  toolCtx: ToolRunContext;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  imagePaths?: string[];
  resumeMessages?: ChatMessage[];
  memoryFrame?: string;
  onCheckpoint?: (line: { type: "user" | "assistant" | "tool"; content: string; data?: Record<string, unknown> }) => Promise<void>;
  onEvent?: (event: CodeAgentEvent) => void;
  requestApproval?: (request: CodeAgentApprovalRequest) => Promise<CodeAgentApprovalDecision>;
  signal?: AbortSignal;
  codexProtocol?: CodexAppServerProtocol;
}


export type CodeAgentApprovalDecision = "approve" | "approve_all" | "always" | "deny";


export interface CodeAgentApprovalRequest {
  tool: ClientToolName;
  args: CodeToolRequest["args"];
  cwd: string;
  preview?: string;
}


export type CodeAgentEvent =
  | { type: "harness.selected"; requested: "auto" | "legacy" | "codex"; selected: "legacy" | "codex"; reason: string; protocol?: CodexAppServerProtocol }
  | { type: "run.started"; runId: string; phase: "running"; revision: number }
  | { type: "run.finished"; runId: string; snapshot: AgentRunSnapshot; terminal: AgentRunTerminal }
  | { type: "step.started"; step: number; label: string }
  | { type: "provider"; provider: string }
  | { type: "usage"; summary: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "tool.progress"; message: string }
  | { type: "tool.requested"; tool: ClientToolName; args: CodeToolRequest["args"]; preview?: string; index?: number }
  | { type: "tool.result"; result: ClientToolResult; index?: number }
  | { type: "tool.ledger"; text: string }
  | { type: "tool.loop_guard"; tool: ClientToolName; repeats: number }
  | { type: "permission.rule_saved"; rule: string; path: string }
  | { type: "stream.interrupted"; message: string }
  | { type: "hook.warning"; message: string }
  | { type: "background.job"; id: string; exitCode: number | null; signal: string | null; logPath: string }
  | { type: "plan.presented"; text: string }
  | { type: "harness.warning"; message: string }
  | { type: "custom.command"; name: string; prompt: string }
  | { type: "permission.rule_invalid"; message: string }
  | { type: "auto.verify"; label: string; ok: boolean; ran: boolean; command?: string; attempt?: number; blockedFinish?: boolean; output?: string }
  | { type: "snapshot"; ref: string; restoreCommand: string }
  | { type: "rollback"; ok: boolean; message: string }
  | { type: "self.verify"; pass: boolean }
  | { type: "plan.updated"; items: CodePlanItem[] }
  | { type: "checkpoint.updated"; chars: number }
  | { type: "runtime.compacted"; messages: number }
  | { type: "session.resumed"; path: string; messages: number }
  | { type: "session.checkpoint"; path: string; line: "user" | "assistant" | "tool" }
  | { type: "session.saved"; path: string }
  | { type: "task.finished"; ok: boolean; text: string; usageSummary: string | null; runId?: string; code?: AgentRunTerminal["code"]; resumable?: boolean; partial?: boolean; maxStepsReached?: boolean; resumeCommand?: string; sessionPath?: string | null; permissionDenials?: PermissionDenial[]; stopReason?: string; durationMs?: number }
  | { type: "error"; message: string };


export interface PermissionDenial {
  tool: string;
  reason: string;
  source: "rule" | "hook" | "plan" | "user" | "mode";
}


export interface CodeAgentLoopResult {
  text: string;
  maxStepsReached: boolean;
  usageSummary: string | null;
  usageRecords: Array<{ usage: unknown; durationMs: number }>;
  permissionDenials: PermissionDenial[];
  runId: string;
  terminal: AgentRunTerminal;
}

export interface CodeAgentLoopCoreResult {
  text: string;
  maxStepsReached: boolean;
  usageSummary: string | null;
  usageRecords: Array<{ usage: unknown; durationMs: number }>;
  permissionDenials: PermissionDenial[];
}


export interface InternalCodeAgentLoopInput extends CodeAgentLoopInput {
  lifecycle: AgentRunLifecycle;
}
