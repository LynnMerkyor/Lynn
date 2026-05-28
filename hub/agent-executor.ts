/**
 * AgentExecutor — Agent 会话执行器
 *
 * 使用 Engine 中的长驻 Agent 实例（不再创建临时 Agent），
 * 创建临时 session 执行多轮 prompt，捕获标记了 capture: true 的轮次输出。
 *
 * ChannelRouter 和 AgentMessenger 共用这个执行器。
 */

import fs from "fs";
import path from "path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AuthStorage,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type ResourceLoader,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { debugLog } from "../lib/debug-log.js";
import { t } from "../server/i18n.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;
type BuiltInTool = NonNullable<CreateAgentSessionOptions["tools"]>[number];
type AgentModel = SessionModel | { id: string; provider?: string; name?: string };

interface AgentRuntime {
  agentDir: string;
  personality?: string;
  systemPrompt?: string;
  tools?: unknown;
  config?: Record<string, unknown> | null;
}

interface BuiltTools {
  tools: BuiltInTool[];
  customTools?: ToolDefinition[];
}

interface SessionContext {
  resourceLoader: ResourceLoader;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  getSkillsForAgent: (agent: AgentRuntime) => unknown;
  buildTools: (
    cwd: string,
    customTools: unknown,
    opts: {
      agentDir: string;
      workspace?: string | null;
      getSessionPath: () => string | null;
    },
  ) => BuiltTools;
  resolveModel: (agentConfig?: Record<string, unknown> | null) => AgentModel;
}

interface AgentEngine {
  homeCwd?: string | null;
  getAgent: (agentId: string) => AgentRuntime | null | undefined;
  ensureAgentLoaded?: (agentId: string) => Promise<AgentRuntime | null | undefined>;
  createSessionContext: () => SessionContext;
}

export interface AgentSessionRound {
  text: string;
  capture?: boolean;
}

export interface RunAgentSessionOptions {
  engine: unknown;
  signal?: AbortSignal;
  sessionSuffix?: string;
  systemAppend?: string;
  keepSession?: boolean;
  noMemory?: boolean;
  noTools?: boolean;
  readOnly?: boolean;
  onSessionReady?: (sessionPath: string | null) => void;
  sessionPath?: string | null;
  cwdOverride?: string | null;
  modelOverride?: AgentModel | null;
}

type TextDeltaEvent = AgentSessionEvent & {
  type: "message_update";
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
};

function asAgentEngine(engine: unknown): AgentEngine {
  const candidate = engine as Partial<AgentEngine> | null | undefined;
  if (
    !candidate
    || typeof candidate.getAgent !== "function"
    || typeof candidate.createSessionContext !== "function"
  ) {
    throw new Error("runAgentSession requires an engine with getAgent() and createSessionContext()");
  }
  return candidate as AgentEngine;
}

function toAbortReason(signal?: AbortSignal): Error | DOMException {
  if (!signal) return new DOMException("Aborted", "AbortError");
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (reason && typeof reason === "object") return reason;
  return new DOMException("Aborted", "AbortError");
}

async function promptWithSignal(session: AgentSession, text: string, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await session.prompt(text);
    return;
  }
  if (signal.aborted) {
    try { await session.abort(); } catch {}
    throw toAbortReason(signal);
  }

  let onAbort: (() => void) | undefined;
  const promptPromise = Promise.resolve(session.prompt(text));
  promptPromise.catch(() => {});
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => {
      try { session.abort(); } catch {}
      reject(toAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    await Promise.race([promptPromise, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runAgentSession(
  agentId: string,
  rounds: AgentSessionRound[],
  {
    engine,
    signal,
    sessionSuffix = "temp",
    systemAppend,
    keepSession = false,
    noMemory = false,
    noTools = false,
    readOnly = false,
    onSessionReady,
    sessionPath = null,
    cwdOverride = null,
    modelOverride = null,
  }: RunAgentSessionOptions = { engine: null },
): Promise<string> {
  const runtimeEngine = asAgentEngine(engine);
  // 1. 从长驻 Map 获取 Agent 实例
  let agent = runtimeEngine.getAgent(agentId);
  if (!agent && typeof runtimeEngine.ensureAgentLoaded === "function") {
    try {
      agent = await runtimeEngine.ensureAgentLoaded(agentId);
    } catch {}
  }
  if (!agent) {
    throw new Error(t("error.agentExecNotInit", { id: agentId }));
  }
  const agentDir = agent.agentDir;

  // 2. 临时 ResourceLoader
  const ctx = runtimeEngine.createSessionContext();
  const tempResourceLoader = Object.create(ctx.resourceLoader);

  // noMemory 模式：只用 personality（identity + yuan + ishiki），不注入记忆/用户档案等
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  tempResourceLoader.getSystemPrompt = () =>
    systemAppend ? `${basePrompt || ""}\n\n${systemAppend}` : (basePrompt || "");
  tempResourceLoader.getSkills = () => ctx.getSkillsForAgent(agent);

  // 3. 临时 session
  const cwd = cwdOverride || runtimeEngine.homeCwd || process.cwd();
  const defaultSessionDir = path.join(agentDir, "sessions", sessionSuffix);
  const sessionDir = sessionPath ? path.dirname(sessionPath) : defaultSessionDir;
  fs.mkdirSync(sessionDir, { recursive: true });
  const tempSessionMgr = sessionPath
    ? SessionManager.open(sessionPath, sessionDir)
    : SessionManager.create(cwd, sessionDir);

  // 工具模式：noTools = 无工具，readOnly = 只读工具，默认 = 全部
  let tools: BuiltInTool[];
  let customTools: ToolDefinition[];
  if (noTools) {
    tools = [];
    customTools = [];
  } else {
    const built = ctx.buildTools(cwd, agent.tools, {
      agentDir,
      workspace: runtimeEngine.homeCwd,
      getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
    });
    if (readOnly) {
      const READ_ONLY_BUILTIN = ["read", "grep", "find", "ls"];
      const READ_ONLY_CUSTOM = ["search_memory", "recall_experience", "web_search", "web_fetch"];
      tools = built.tools.filter(tool => READ_ONLY_BUILTIN.includes(tool.name));
      customTools = (built.customTools || []).filter(tool => READ_ONLY_CUSTOM.includes(tool.name));
    } else {
      tools = built.tools;
      customTools = built.customTools || [];
    }
  }
  const model = (modelOverride || ctx.resolveModel(agent.config)) as SessionModel;
  const { session } = await createAgentSession({
    cwd,
    sessionManager: tempSessionMgr,
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20_000,
      },
    }),
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools,
  });

  onSessionReady?.(session.sessionManager?.getSessionFile?.() || null);

  // 4. 文本捕获
  let capturedText = "";
  let isCapturing = false;
  const unsub = session.subscribe((event: AgentSessionEvent) => {
    if (!isCapturing) return;
    if (event.type === "message_update") {
      const sub = (event as TextDeltaEvent).assistantMessageEvent;
      if (sub?.type === "text_delta") capturedText += sub.delta || "";
    }
  });

  debugLog()?.log("agent-executor", `${agentId} session started (${rounds.length} rounds)`);

  try {
    for (const round of rounds) {
      if (signal?.aborted) {
        try { await session.abort(); } catch {}
        throw toAbortReason(signal);
      }
      isCapturing = !!round.capture;
      if (round.capture) capturedText = "";
      await promptWithSignal(session, round.text, signal);
    }
  } finally {
    unsub?.();
  }

  // 6. 清理临时 session 文件（keepSession=true 时保留，供 DM 等场景存档）
  if (!keepSession) {
    const sessionPath = session.sessionManager?.getSessionFile?.();
    if (sessionPath) {
      try { fs.unlinkSync(sessionPath); } catch {}
    }
  }

  // 7. 去掉 MOOD 块（backtick 和 XML 两种格式，一次过）
  const text = capturedText
    .replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*|<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\n*/gi, "")
    .trim();

  debugLog()?.log("agent-executor", `${agentId} done, ${text.length} chars captured`);
  return text;
}
