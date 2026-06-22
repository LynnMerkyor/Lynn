/**
 * Session 管理 REST 路由
 */
import fs from "fs/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import { isToolCallBlock, getToolArgs } from "../../core/llm-utils.js";
import type { ContentBlock } from "../../core/llm-utils.js";
import { sanitizeBrainIdentityDisclosureText } from "../../shared/brain-provider.js";
import { stripPseudoToolCallMarkup } from "../../shared/pseudo-tool-call.js";
import {
  artifactPreviewDedupeKey,
  artifactPreviewsFromContent,
} from "../chat/artifact-recovery.js";
import { normalizeArtifactPayload } from "../chat/artifact-shape.js";
import {
  mergeSessionTopology,
  normalizeSessionTopology,
} from "../../shared/session-topology.js";
import {
  appendSessionInsight,
  consumeSessionInsights,
  mergeSessionDigest,
  normalizeSessionDigest,
  normalizeSessionInsights,
  unreadInsightCount,
} from "../../shared/session-digest.js";
import { SessionManager } from "../../core/agent-runtime/session-manager.js";

type JsonRecord = Record<string, unknown>;

interface SessionModelRef {
  id?: string | null;
  provider?: string | null;
}

interface SessionAgent {
  config?: { skills?: { enabled?: unknown[] } };
  agentDir?: string;
}

interface SessionsEngine {
  agentsDir: string;
  agentDir?: string;
  agentName?: string;
  agent?: SessionAgent;
  currentAgentId?: string;
  currentSessionPath?: string | null;
  messages?: SessionMessage[];
  homeCwd?: string;
  cwd?: string;
  config: { cwd_history?: unknown[]; [key: string]: unknown };
  planMode?: unknown;
  securityMode?: unknown;
  memoryModelUnavailableReason?: unknown;
  currentModel?: SessionModelRef | null;
  memoryEnabled?: boolean;
  getAgent?(agentId: string): SessionAgent | null | undefined;
  listSessions(): Promise<SessionListEntry[]> | SessionListEntry[];
  createSessionForAgent(agentId: string, cwd?: string, memoryEnabled?: boolean): Promise<unknown> | unknown;
  createSession(agentId?: string | null, cwd?: string, memoryEnabled?: boolean): Promise<{ sessionManager?: { getSessionFile?(): string | null } } | void> | { sessionManager?: { getSessionFile?(): string | null } } | void;
  persistSessionMeta(): unknown;
  updateConfig(partial: JsonRecord): Promise<unknown> | unknown;
  switchSession(sessionPath: string): Promise<unknown> | unknown;
  isSessionStreaming(sessionPath?: string | null): boolean;
  saveSessionTitle(sessionPath: string, title: string): Promise<unknown> | unknown;
  saveSessionMeta(sessionPath: string, meta: JsonRecord): Promise<unknown> | unknown;
  closeSession(sessionPath?: string | null): Promise<unknown> | unknown;
}

interface SessionMessage {
  role?: string;
  content?: unknown;
  model?: string;
  provider?: string;
  details?: JsonRecord;
  toolName?: string;
  toolCallId?: string;
}

interface ExtractedImage {
  data: unknown;
  mimeType: string;
}

interface ExtractedToolUse {
  name: string;
  args?: JsonRecord;
}

interface ExtractedContent {
  text: string;
  thinking: string;
  toolUses: ExtractedToolUse[];
  images: ExtractedImage[];
}

interface SessionListEntry {
  path: string;
  title?: string | null;
  firstMessage?: string;
  modified?: string | number | Date | null;
  messageCount?: number;
  cwd?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  modelId?: string | null;
  modelProvider?: string | null;
  labels?: unknown[];
  topology?: unknown;
  digest?: unknown;
  insights?: unknown;
  health?: unknown;
}

interface SessionHealth {
  level: "ok" | "large" | "critical";
  sizeBytes: number | null;
  reason: string | null;
}

interface VisibleMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: ExtractedImage[];
  thinking?: string;
  toolCalls?: ExtractedToolUse[];
  model?: string | null;
}

interface FileOutputPreview {
  afterIndex: number;
  files: unknown;
}

interface FileDiffPreview {
  afterIndex: number;
  filePath: string;
  diff: unknown;
  linesAdded: number;
  linesRemoved: number;
  rollbackId?: string;
}

type ArtifactPreview = JsonRecord & { afterIndex: number };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStack(err: unknown): string {
  return err instanceof Error && err.stack ? err.stack : "";
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readSessionMetaEntry(sessionPath: string): JsonRecord {
  try {
    const metaPath = path.join(path.dirname(sessionPath), "session-meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as JsonRecord;
    return {
      ...asRecord(meta[path.basename(sessionPath)]),
      ...asRecord(meta[sessionPath]),
    };
  } catch {
    return {};
  }
}

/**
 * 从 Pi SDK 的 content 块数组中提取纯文本 + thinking + tool_use 调用
 * content 可能是 string 或 [{type: "text", text: "..."}, {type: "thinking", thinking: "..."}, ...]
 * 返回 { text, thinking, toolUses }
 */
const TOOL_ARG_SUMMARY_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "key", "value", "action", "type", "schedule", "prompt", "label"];

function formatMessageModelRef(message: Pick<SessionMessage, "model" | "provider"> = {}): string | null {
  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (!model) return null;
  const provider = typeof message.provider === "string" ? message.provider.trim() : "";
  return provider ? `${provider}/${model}` : model;
}

/** 从文本中提取并剥离 <think>...</think> 标签 */
function stripThinkTags(raw: string): { text: string; thinkContent: string } {
  const thinkParts: string[] = [];
  const text = raw.replace(/<think>([\s\S]*?)<\/think>\n*/g, (_, inner) => {
    thinkParts.push(inner.trim());
    return "";
  });
  return { text, thinkContent: thinkParts.join("\n") };
}

function extractTextContent(
  content: unknown,
  { stripThink = false, stripPseudoToolCalls = false }: { stripThink?: boolean; stripPseudoToolCalls?: boolean } = {},
): ExtractedContent {
  if (typeof content === "string") {
    if (stripThink) {
      const { text, thinkContent } = stripThinkTags(content);
      return {
        text: stripPseudoToolCalls ? stripPseudoToolCallMarkup(text) : text,
        thinking: thinkContent,
        toolUses: [],
        images: [],
      };
    }
    return {
      text: stripPseudoToolCalls ? stripPseudoToolCallMarkup(content) : content,
      thinking: "",
      toolUses: [],
      images: [],
    };
  }
  if (!Array.isArray(content)) return { text: "", thinking: "", toolUses: [], images: [] };
  const blocks = content as ContentBlock[];
  const rawText = blocks
    .filter(block => block.type === "text" && block.text)
    .map(block => String(block.text || ""))
    .join("");
  const images = blocks
    .filter(block => {
      const record = block as ContentBlock & JsonRecord;
      const source = asRecord(record.source);
      return block.type === "image" && (record.data || source.data);
    })
    .map(block => {
      const record = block as ContentBlock & JsonRecord;
      const source = asRecord(record.source);
      return {
        data: record.data || source.data,
        mimeType: String(record.mimeType || source.media_type || "image/png"),
      };
    });
  const { text, thinkContent } = stripThink ? stripThinkTags(rawText) : { text: rawText, thinkContent: "" };
  const thinking = [
    thinkContent,
    ...blocks
      .filter(block => {
        const record = block as ContentBlock & JsonRecord;
        return block.type === "thinking" && record.thinking;
      })
      .map(block => String((block as ContentBlock & JsonRecord).thinking || "")),
  ].filter(Boolean).join("\n");
  const toolUses = blocks
    .filter(isToolCallBlock)
    .map(block => {
      const args: JsonRecord = {};
      const params = getToolArgs(block);
      if (params && typeof params === "object") {
        const record = params as JsonRecord;
        for (const k of TOOL_ARG_SUMMARY_KEYS) {
          if (record[k] !== undefined) args[k] = record[k];
        }
      }
      return { name: block.name, args: Object.keys(args).length ? args : undefined };
    });
  return {
    text: sanitizeBrainIdentityDisclosureText(stripPseudoToolCalls ? stripPseudoToolCallMarkup(text) : text),
    thinking,
    toolUses,
    images,
  };
}

/**
 * 优先从 session JSONL 读取完整历史。
 * engine.messages 可能只是当前上下文窗口，切回页面时会导致旧消息缺失。
 * 读文件失败时再退回内存态，避免历史接口直接空白。
 */
async function loadSessionHistoryMessages(engine: SessionsEngine, explicitPath?: string | null): Promise<SessionMessage[]> {
  const sessionPath = explicitPath || engine.currentSessionPath;
  if (sessionPath) {
    try {
      // Keep this hot path independent of libuv's fs promise queue. Background
      // memory/indexing work can saturate that queue and make the chat view wait
      // for 30s even when the session file itself is tiny.
      const raw = readFileSync(sessionPath, "utf-8");
      const messages: SessionMessage[] = [];

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "message" && entry.message) {
            messages.push(entry.message);
          }
        } catch {
          // 跳过损坏行
        }
      }

      if (messages.length > 0) return messages;
    } catch {
      // 回退到内存态
    }
  }

  return Array.isArray(engine.messages) ? engine.messages : [];
}

/**
 * 校验 sessionPath 是否在合法范围内，防止路径穿越
 * baseDir 可以是 sessionDir（单 agent）或 agentsDir（跨 agent）
 */
function isValidSessionPath(sessionPath: string, baseDir: string): boolean {
  const resolved = path.resolve(sessionPath);
  const base = path.resolve(baseDir);
  return resolved.startsWith(base + path.sep) || resolved === base;
}

function normalizeLegacyWorkspaceCwd(cwd: unknown): string | null {
  const raw = String(cwd || "").trim();
  if (!raw) return null;
  const oldRoot = "/Users/lynn/openhanako";
  const newRoot = "/Users/lynn/Lynn";
  if (raw === oldRoot || raw.startsWith(`${oldRoot}${path.sep}`)) {
    const migrated = raw.replace(oldRoot, newRoot);
    try {
      if (existsSync(newRoot)) return migrated;
    } catch {
      return migrated;
    }
  }
  return raw;
}

function ensureSessionFileOnDisk(sessionPath?: string | null): boolean {
  if (!sessionPath) return false;
  try {
    const dir = path.dirname(sessionPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(sessionPath)) writeFileSync(sessionPath, "", "utf-8");
    return true;
  } catch (err) {
    console.warn("[sessions] failed to materialize session file:", errorMessage(err));
    return false;
  }
}

function formatSessionDate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

const LARGE_SESSION_BYTES = 50 * 1024 * 1024;
const CRITICAL_SESSION_BYTES = 500 * 1024 * 1024;

function sessionHealthForPath(sessionPath: string): SessionHealth {
  try {
    const sizeBytes = statSync(sessionPath).size;
    if (sizeBytes >= CRITICAL_SESSION_BYTES) {
      return { level: "critical", sizeBytes, reason: "session_file_critical_size" };
    }
    if (sizeBytes >= LARGE_SESSION_BYTES) {
      return { level: "large", sizeBytes, reason: "session_file_large_size" };
    }
    return { level: "ok", sizeBytes, reason: null };
  } catch {
    return { level: "ok", sizeBytes: null, reason: null };
  }
}

function defaultBranchLabel(sourcePath: string): string {
  const meta = readSessionMetaEntry(sourcePath);
  const title = stringField(meta, "title");
  if (title) return `${title.slice(0, 36)} branch`;
  const stamp = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `Branch ${stamp}`;
}

function buildSessionMap(sessions: SessionListEntry[]) {
  const nodes = sessions.map((s) => {
    const topology = normalizeSessionTopology(s.topology);
    const digest = normalizeSessionDigest(s.digest);
    const insights = normalizeSessionInsights(s.insights);
    return {
      id: s.path,
      path: s.path,
      title: s.title || s.firstMessage || path.basename(s.path),
      cwd: normalizeLegacyWorkspaceCwd(s.cwd),
      agentId: s.agentId || null,
      agentName: s.agentName || null,
      modified: formatSessionDate(s.modified),
      messageCount: s.messageCount || 0,
      topology,
      digest,
      health: sessionHealthForPath(s.path),
      unreadInsights: unreadInsightCount(insights),
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = nodes
    .map((node) => {
      const parent = node.topology?.parentSessionPath || null;
      if (!parent || !nodeIds.has(parent)) return null;
      return {
        id: `${parent}->${node.id}`,
        from: parent,
        to: node.id,
        label: node.topology?.branchLabel || "branch",
      };
    })
    .filter((edge): edge is NonNullable<typeof edge> => !!edge);
  return { ok: true, nodes, edges };
}

export function createSessionsRoute(engine: SessionsEngine): Hono {
  const route = new Hono();

  // 列出所有 agent 的历史 session
  route.get("/sessions", async (c) => {
    try {
      const sessions = await engine.listSessions();
      return c.json(sessions.map(s => ({
        path: s.path,
        title: s.title || null,
        firstMessage: (s.firstMessage || "").slice(0, 100),
        modified: formatSessionDate(s.modified),
        messageCount: s.messageCount || 0,
        cwd: normalizeLegacyWorkspaceCwd(s.cwd),
        agentId: s.agentId || null,
        agentName: s.agentName || null,
        modelId: s.modelId || null,
        modelProvider: s.modelProvider || null,
        labels: Array.isArray(s.labels) ? s.labels : [],
        topology: normalizeSessionTopology(s.topology),
        digest: normalizeSessionDigest(s.digest),
        insights: normalizeSessionInsights(s.insights),
        health: sessionHealthForPath(s.path),
      })));
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 获取 session 的消息（支持 ?path= 指定 session，否则读焦点 session）
  route.get("/sessions/messages", async (c) => {
    try {
      const queryPath = c.req.query("path") || null;
      if (queryPath && !isValidSessionPath(queryPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const sourceMessages = await loadSessionHistoryMessages(engine, queryPath);

      // 分页参数
      const beforeId = c.req.query("before") != null ? Number(c.req.query("before")) : null;
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

      // 提取可显示的消息（user/assistant 文本 + 文件/artifact 工具结果）
      // 每条消息带稳定 id（原始 sourceMessages 索引）
      const allMessages: VisibleMessage[] = [];
      const fileOutputs: FileOutputPreview[] = [];
      const fileDiffs: FileDiffPreview[] = [];
      const artifacts: ArtifactPreview[] = [];
      const artifactKeys = new Set<string>();
      let globalIdx = 0;

      for (const m of sourceMessages) {
        if (m.role === "user") {
          const { text, images } = extractTextContent(m.content);
          if (text || images.length) allMessages.push({ id: String(globalIdx++), role: "user", content: text, images: images.length ? images : undefined });
        } else if (m.role === "assistant") {
          const { text, thinking, toolUses } = extractTextContent(m.content, {
            stripThink: true,
            stripPseudoToolCalls: true,
          });
          if (text || toolUses.length) {
            allMessages.push({
              id: String(globalIdx++),
              role: "assistant",
              content: text,
              thinking: thinking || undefined,
              toolCalls: toolUses.length ? toolUses : undefined,
              model: formatMessageModelRef(m),
            });
          }
          for (const artifact of artifactPreviewsFromContent(m.content)) {
            const key = artifactPreviewDedupeKey(artifact);
            if (artifactKeys.has(key)) continue;
            artifactKeys.add(key);
            artifacts.push({
              afterIndex: Math.max(0, allMessages.length - 1),
              artifactId: artifact.artifactId,
              artifactType: artifact.artifactType,
              title: artifact.title,
              content: artifact.content,
              language: artifact.language,
              recovered: true,
            });
          }
        } else if (m.role === "toolResult") {
          const d = asRecord(m.details);
          const files = d.files;
          if ((m.toolName === "present_files" || m.toolName === "create_docx" || m.toolName === "create_pptx" || m.toolName === "create_report" || m.toolName === "create_poster") && Array.isArray(files) && files.length) {
            fileOutputs.push({ afterIndex: allMessages.length - 1, files: d.files });
          }
          if ((m.toolName === "edit" || m.toolName === "edit-diff") && d.diff) {
            const assistantMsg = allMessages[allMessages.length - 1];
            const toolCalls = assistantMsg?.toolCalls || [];
            const matchingToolCall = [...toolCalls].reverse().find(tc => tc.name === m.toolName);
            const args = matchingToolCall?.args || {};
            const diffFilePath = String(args.file_path || args.path || "");
            let linesAdded = 0;
            let linesRemoved = 0;
            for (const line of String(d.diff).split("\n")) {
              if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
              if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
            }
            fileDiffs.push({
              afterIndex: allMessages.length - 1,
              filePath: diffFilePath,
              diff: d.diff,
              linesAdded,
              linesRemoved,
              rollbackId: m.toolCallId || undefined,
            });
          } else if ((m.toolName === "create_artifact" || m.toolName === "create_report") && d.content) {
            const artifact = normalizeArtifactPayload({
              artifactId: d.artifactId,
              artifactType: d.artifactType || d.type,
              title: d.title,
              content: d.content,
              language: d.language || (d.type === "html" ? "html" : undefined),
            }, { messageType: "artifact" });
            if (!artifact) continue;
            const key = artifactPreviewDedupeKey(artifact);
            if (!artifactKeys.has(key)) {
              artifactKeys.add(key);
              artifacts.push({ ...artifact, afterIndex: allMessages.length - 1 });
            }
          }
        }
      }

      // 分页：只在有 before 参数时切片，否则返回全量
      let messages: VisibleMessage[];
      let hasMore = false;
      let slicedFileOutputs = fileOutputs;
      let slicedFileDiffs = fileDiffs;
      let slicedArtifacts = artifacts;

      if (beforeId != null && beforeId > 0) {
        const endIdx = Math.min(beforeId, allMessages.length);
        const startIdx = Math.max(0, endIdx - limit);
        messages = allMessages.slice(startIdx, endIdx);
        hasMore = startIdx > 0;
        // 重映射 afterIndex 到切片内偏移，过滤超出范围的
        slicedFileOutputs = fileOutputs
          .filter(fo => fo.afterIndex >= startIdx && fo.afterIndex < endIdx)
          .map(fo => ({ ...fo, afterIndex: fo.afterIndex - startIdx }));
        slicedFileDiffs = fileDiffs
          .filter(fd => fd.afterIndex >= startIdx && fd.afterIndex < endIdx)
          .map(fd => ({ ...fd, afterIndex: fd.afterIndex - startIdx }));
        slicedArtifacts = artifacts
          .filter(a => a.afterIndex >= startIdx && a.afterIndex < endIdx)
          .map(a => ({ ...a, afterIndex: a.afterIndex - startIdx }));
      } else {
        // 默认返回全量，不截断
        messages = allMessages;
      }

      // 从历史中提取最新 todo 状态
      let todos = null;
      for (let i = sourceMessages.length - 1; i >= 0; i--) {
        const m = sourceMessages[i];
        if (m.role === "toolResult" && m.toolName === "todo" && m.details?.todos) {
          todos = m.details.todos;
          break;
        }
      }

      return c.json({ messages, todos, fileOutputs: slicedFileOutputs, fileDiffs: slicedFileDiffs, artifacts: slicedArtifacts, hasMore });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 新建 session（可选指定工作目录和 agentId）
  route.post("/sessions/new", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const cwd = stringField(body, "cwd");
      const agentId = stringField(body, "agentId");
      const memoryEnabled = body.memoryEnabled;
      const memFlag = memoryEnabled !== false; // 默认 true
      console.log("[sessions] 新建 session", {
        hasCwd: !!cwd,
        memoryEnabled: memFlag,
        customAgent: !!agentId,
      });

      // 新建前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      if (bm.isRunning) await bm.suspendForSession(engine.currentSessionPath);

      if (agentId && agentId !== engine.currentAgentId) {
        await engine.createSessionForAgent(agentId, cwd || undefined, memFlag);
      } else {
        await engine.createSession(null, cwd || undefined, memFlag);
      }
      ensureSessionFileOnDisk(engine.currentSessionPath);
      engine.persistSessionMeta();

      // 记住工作目录 + 更新历史
      if (cwd) {
        const history = Array.isArray(engine.config.cwd_history)
          ? engine.config.cwd_history.filter(p => p !== cwd)
          : [];
        history.unshift(cwd);
        if (history.length > 10) history.length = 10;  // 保留最近 10 条
        await engine.updateConfig({ last_cwd: cwd, cwd_history: history });
      }

      console.log("[sessions] session 创建完成");
      return c.json({
        ok: true,
        path: engine.currentSessionPath,
        cwd: engine.cwd,
        agentId: engine.currentAgentId,
        agentName: engine.agentName,
        planMode: engine.planMode,
        securityMode: engine.securityMode,
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        currentModelId: engine.currentModel?.id || null,
        currentModelProvider: engine.currentModel?.provider || null,
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 切换 session（支持跨 agent）
  route.post("/sessions/switch", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path");
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      // 校验路径在 agentsDir 范围内（支持跨 agent session）
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      // 切换前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      const oldSessionPath = engine.currentSessionPath;
      if (bm.isRunning) await bm.suspendForSession(oldSessionPath);

      await engine.switchSession(sessionPath);

      // 恢复目标 session 的浏览器（若有）
      if (bm.isRunning) await bm.resumeForSession(sessionPath);

      return c.json({
        ok: true,
        messageCount: (engine.messages || []).length,
        memoryEnabled: engine.memoryEnabled,
        planMode: engine.planMode,
        securityMode: engine.securityMode,
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        cwd: engine.cwd,
        agentId: engine.currentAgentId,
        agentName: engine.agentName,
        browserRunning: bm.isRunning,
        browserUrl: bm.currentUrl || null,
        isStreaming: engine.isSessionStreaming(engine.currentSessionPath),
        currentModelId: engine.currentModel?.id || null,
        currentModelProvider: engine.currentModel?.provider || null,
      });
    } catch (err) {
      const errDetail = `${errorMessage(err)}\n${errorStack(err)}`;
      console.error("[sessions/switch] error:", errDetail);
      try {
        const logDir = path.join(homedir(), ".lynn");
        mkdirSync(logDir, { recursive: true });
        appendFileSync(path.join(logDir, "switch-error.log"), `${new Date().toISOString()}\n${errDetail}\n---\n`);
      } catch {
        // Logging failures should not mask the original switch error.
      }
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 从现有 session fork 出一个新 session 并切过去，避免超长会话继续膨胀
  route.post("/sessions/branch", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sourcePath = stringField(body, "path") || engine.currentSessionPath || "";
      if (!sourcePath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sourcePath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      try {
        await fs.access(sourcePath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      const branchLabel = (stringField(body, "branchLabel") || defaultBranchLabel(sourcePath)).trim();
      const targetCwd = normalizeLegacyWorkspaceCwd(stringField(body, "cwd") || engine.cwd || engine.homeCwd || "") || process.cwd();
      const forked = SessionManager.forkFrom(sourcePath, targetCwd, path.dirname(sourcePath));
      const branchPath = forked.getSessionFile();
      if (!branchPath) return c.json({ error: "Failed to create branched session" }, 500);

      const parentMeta = readSessionMetaEntry(sourcePath);
      const parentTopology = normalizeSessionTopology(parentMeta.topology);
      const topology = mergeSessionTopology(null, {
        parentSessionPath: sourcePath,
        rootSessionPath: parentTopology?.rootSessionPath || sourcePath,
        branchLabel,
        taskStatus: "active",
        summary: stringField(body, "summary") || parentTopology?.summary || null,
        resumeHint: stringField(body, "resumeHint") || "从这个分支继续，保留父会话作为可回退上下文。",
      });
      await engine.saveSessionMeta(branchPath, { topology });
      await engine.saveSessionTitle(branchPath, branchLabel);

      const bm = BrowserManager.instance();
      const oldSessionPath = engine.currentSessionPath;
      if (bm.isRunning) await bm.suspendForSession(oldSessionPath);
      await engine.switchSession(branchPath);
      if (bm.isRunning) await bm.resumeForSession(branchPath);

      return c.json({
        ok: true,
        path: branchPath,
        parentSessionPath: sourcePath,
        topology,
        health: sessionHealthForPath(branchPath),
        messageCount: (engine.messages || []).length,
        memoryEnabled: engine.memoryEnabled,
        planMode: engine.planMode,
        securityMode: engine.securityMode,
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        cwd: engine.cwd,
        agentId: engine.currentAgentId,
        agentName: engine.agentName,
        browserRunning: bm.isRunning,
        browserUrl: bm.currentUrl || null,
        isStreaming: engine.isSessionStreaming(engine.currentSessionPath),
        currentModelId: engine.currentModel?.id || null,
        currentModelProvider: engine.currentModel?.provider || null,
      });
    } catch (err) {
      console.error("[sessions/branch] error:", errorMessage(err));
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 获取所有有浏览器的 session
  route.get("/browser/sessions", async (c) => {
    const bm = BrowserManager.instance();
    return c.json(bm.getBrowserSessions());
  });

  // 关闭指定 session 的浏览器
  route.post("/browser/close-session", async (c) => {
    const body = asRecord(await safeJson(c));
    const sessionPath = stringField(body, "sessionPath");
    if (!sessionPath) return c.json({ error: "missing sessionPath" });
    const bm = BrowserManager.instance();
    await bm.closeBrowserForSession(sessionPath);
    return c.json({ ok: true });
  });

  // 重命名 session
  route.post("/sessions/rename", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path");
      const title = stringField(body, "title");
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (typeof title !== "string" || !title.trim()) {
        return c.json({ error: t("error.missingParam", { param: "title" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      await engine.saveSessionTitle(sessionPath, title.trim());
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 置顶/取消置顶 session
  route.post("/sessions/pin", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path");
      const pinned = body.pinned;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      await engine.saveSessionMeta(sessionPath, { pinned: !!pinned });
      return c.json({ ok: true, pinned: !!pinned });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 设置 session 标签
  route.post("/sessions/labels", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path");
      const labels = body.labels;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!Array.isArray(labels)) {
        return c.json({ error: t("error.missingParam", { param: "labels" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const normalized = [...new Set(labels
        .map((label) => String(label || "").trim())
        .filter(Boolean)
        .slice(0, 6))];
      await engine.saveSessionMeta(sessionPath, { labels: normalized });
      return c.json({ ok: true, labels: normalized });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 更新 session 的原生拓扑元数据（V0.85.1 memory/topology v0）
  route.post("/sessions/topology", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path");
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const patch = asRecord(body.topology) && Object.keys(asRecord(body.topology)).length
        ? asRecord(body.topology)
        : body;
      const existing = readSessionMetaEntry(sessionPath);
      const topology = body.clear === true
        ? null
        : mergeSessionTopology(existing.topology, patch);
      await engine.saveSessionMeta(sessionPath, { topology });
      return c.json({ ok: true, topology });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  route.post("/sessions/digest", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path");
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const patch = Object.keys(asRecord(body.digest)).length ? asRecord(body.digest) : body;
      const existing = readSessionMetaEntry(sessionPath);
      const digest = body.clear === true
        ? null
        : mergeSessionDigest(existing.digest, patch);
      await engine.saveSessionMeta(sessionPath, { digest });
      return c.json({ ok: true, digest });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  route.post("/sessions/insights", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path") || stringField(body, "targetSessionPath");
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const existing = readSessionMetaEntry(sessionPath);
      const insight = Object.keys(asRecord(body.insight)).length
        ? { ...asRecord(body.insight), targetSessionPath: sessionPath }
        : { ...body, targetSessionPath: sessionPath };
      const insights = appendSessionInsight(existing.insights, insight);
      await engine.saveSessionMeta(sessionPath, { insights });
      return c.json({ ok: true, insights, unread: unreadInsightCount(insights) });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  route.post("/sessions/insights/consume", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path");
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const existing = readSessionMetaEntry(sessionPath);
      const insights = consumeSessionInsights(existing.insights, body.ids);
      await engine.saveSessionMeta(sessionPath, { insights });
      return c.json({ ok: true, insights, unread: unreadInsightCount(insights) });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  route.get("/sessions/map", async (c) => {
    try {
      const sessions = await engine.listSessions();
      return c.json(buildSessionMap(sessions));
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 清理过期归档 session
  route.post("/sessions/cleanup", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const maxAgeDays = typeof body.maxAgeDays === "number" ? body.maxAgeDays : 90;
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let deleted = 0;

      // 遍历所有 agent 的 sessions/archived/ 目录
      const agentsDir = engine.agentsDir;
      const agents = await fs.readdir(agentsDir).catch(() => []);
      for (const agentId of agents) {
        const archiveDir = path.join(agentsDir, agentId, "sessions", "archived");
        let files;
        try { files = await fs.readdir(archiveDir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const fp = path.join(archiveDir, f);
          try {
            const stat = await fs.stat(fp);
            if (stat.mtime.getTime() < cutoff) {
              await fs.unlink(fp);
              deleted++;
            }
          } catch {
            // Ignore files that disappeared during cleanup.
          }
        }
      }

      return c.json({ ok: true, deleted, maxAgeDays });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 归档 session（支持跨 agent）
  route.post("/sessions/archive", async (c) => {
    try {
      const body = asRecord(await safeJson(c));
      const sessionPath = stringField(body, "path");
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      // 校验路径在 agentsDir 范围内
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }

      // 确认文件存在
      try {
        await fs.access(sessionPath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      // 先从 engine 的 session map 中移除（如果正在后台跑会被 abort）
      await engine.closeSession(sessionPath);

      // 从 session 路径推导归档目录（同 agent 的 sessions/archived/）
      const sessDir = path.dirname(sessionPath);
      const archiveDir = path.join(sessDir, "archived");
      await fs.mkdir(archiveDir, { recursive: true });

      const fileName = path.basename(sessionPath);
      const destPath = path.join(archiveDir, fileName);
      await fs.rename(sessionPath, destPath);

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 创建新 session（/clear 斜杠命令用）
  route.post("/session/new", async (c) => {
    try {
      await engine.closeSession(engine.currentSessionPath);
      const session = await engine.createSession(null, engine.homeCwd);
      const sessionRecord = asRecord(session);
      const sessionManager = asRecord(sessionRecord.sessionManager);
      const getSessionFile = sessionManager.getSessionFile;
      return c.json({ ok: true, path: typeof getSessionFile === "function" ? getSessionFile() : null });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // 保存检查点（/save 斜杠命令用）
  route.post("/session/checkpoint", async (c) => {
    try {
      const currentPath = engine.currentSessionPath;
      if (!currentPath) {
        return c.json({ error: "No active session" }, 400);
      }
      // 持久化 session meta（模型、记忆状态等）
      engine.persistSessionMeta();

      // 将当前 session 的关键信息写入检查点文件
      const sessDir = path.dirname(currentPath);
      const checkpointDir = path.join(sessDir, "checkpoints");
      mkdirSync(checkpointDir, { recursive: true });

      const checkpoint = {
        sessionPath: currentPath,
        timestamp: new Date().toISOString(),
        agentId: engine.currentAgentId,
        modelId: engine.currentModel?.id || null,
        modelProvider: engine.currentModel?.provider || null,
        messageCount: (engine.messages || []).length,
        memoryEnabled: engine.memoryEnabled,
        cwd: engine.cwd,
      };

      const cpFile = path.join(checkpointDir, `cp-${Date.now()}.json`);
      appendFileSync(cpFile, JSON.stringify(checkpoint, null, 2));

      return c.json({ ok: true, checkpoint: cpFile });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  return route;
}
