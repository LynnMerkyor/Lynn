import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { debugLog } from "../../lib/debug-log.js";
import { stripRouteMetadataLeaks } from "./turn-retry-policy.js";
import { extractText } from "./content-utils.js";

const DEFAULT_LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
const DEFAULT_LOCAL_QWEN35_MODEL_ID = "qwen36-27b-dsv4pro-coding-q4-mtp";

type JsonRecord = Record<string, unknown>;
type ExtractTextContent = Parameters<typeof extractText>[0];

interface PersistedMessage extends JsonRecord {
  role?: unknown;
  content?: unknown;
}

interface PersistLocalQwen35DirectTurnOptions {
  reasoningText?: unknown;
  api?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
  timestamp?: unknown;
}

/** context_usage 回包附带的"最后一轮 usage"(Pi-SDK Usage 投影 + 去重锚点)。 */
export interface LastAssistantUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number | null;
  model: string | null;
  timestamp: number | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getSessionMessages(session: unknown): unknown[] {
  return isRecord(session) && Array.isArray(session.messages) ? session.messages : [];
}

function asPersistedMessage(value: unknown): PersistedMessage | null {
  return isRecord(value) ? value as PersistedMessage : null;
}

function getEntryMessage(entry: unknown): PersistedMessage | null {
  if (!isRecord(entry)) return null;
  return asPersistedMessage(entry.message);
}

function contentForExtractText(content: unknown): ExtractTextContent {
  if (typeof content === "string" || content == null) return content;
  if (Array.isArray(content)) return content as ExtractTextContent;
  return undefined;
}

function formatError(err: unknown): string {
  if (isRecord(err) && typeof err.message === "string") return err.message;
  return String(err);
}

function normalizePersistedAssistantText(text: unknown): string {
  return String(text || "");
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 倒序找最后一条带 usage 的 assistant 消息,投影成 LastAssistantUsage。
 * usage 形状 = Pi-SDK Usage(input/output/cacheRead/cacheWrite/totalTokens/cost.total);
 * timestamp 用作 renderer 去重锚点(同一条消息绝不重复累计)。
 */
export function extractLastAssistantUsage(session: unknown): LastAssistantUsage | null {
  const messages = getSessionMessages(session);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = asPersistedMessage(messages[i]) ?? getEntryMessage(messages[i]);
    if (!msg || msg.role !== "assistant" || !isRecord(msg.usage)) continue;
    const usage = msg.usage as JsonRecord;
    const input = toFiniteNumber(usage.input);
    const output = toFiniteNumber(usage.output);
    if (input == null && output == null) continue;
    const cost = isRecord(usage.cost) ? usage.cost as JsonRecord : null;
    return {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: toFiniteNumber(usage.cacheRead) ?? 0,
      cacheWrite: toFiniteNumber(usage.cacheWrite) ?? 0,
      totalTokens: toFiniteNumber(usage.totalTokens) ?? ((input ?? 0) + (output ?? 0)),
      costTotal: cost ? toFiniteNumber(cost.total) : null,
      model: typeof msg.model === "string" ? msg.model : null,
      timestamp: toFiniteNumber(msg.timestamp),
    };
  }
  return null;
}

export function readPersistedAssistantRecords(session: unknown, sessionPath = ""): PersistedMessage[] {
  const messages = getSessionMessages(session);
  const fromMessages: PersistedMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = asPersistedMessage(messages[i]);
    if (msg?.role !== "assistant") continue;
    fromMessages.push(msg);
  }
  if (sessionPath) {
    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const fromFile: PersistedMessage[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const entry: unknown = JSON.parse(lines[i]);
        const msg = getEntryMessage(entry);
        if (msg?.role !== "assistant") continue;
        fromFile.push(msg);
      }
      if (fromFile.length > 0) return fromFile;
    } catch {
      // Best-effort recovery for SDK paths that persist answers without streaming them.
    }
  }
  return fromMessages;
}

export function readPersistedAssistantVisibleTexts(session: unknown, sessionPath = ""): string[] {
  return readPersistedAssistantRecords(session, sessionPath)
    .map((msg) => normalizePersistedAssistantText(extractText(contentForExtractText(msg.content))))
    .filter(Boolean);
}

export function countPersistedAssistantVisibleTexts(session: unknown, sessionPath = ""): number {
  return readPersistedAssistantVisibleTexts(session, sessionPath).length;
}

export function countPersistedAssistantMessages(session: unknown, sessionPath = ""): number {
  return readPersistedAssistantRecords(session, sessionPath).length;
}

export function extractLatestAssistantVisibleTextAfter(session: unknown, sessionPath = "", baselineCount = 0): string {
  const texts = readPersistedAssistantVisibleTexts(session, sessionPath);
  if (texts.length <= Math.max(0, baselineCount || 0)) return "";
  return stripRouteMetadataLeaks(texts[texts.length - 1] || "");
}

export function extractLatestAssistantVisibleText(session: unknown, sessionPath = ""): string {
  return extractLatestAssistantVisibleTextAfter(session, sessionPath, 0);
}

export function sessionLineId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function getLastSessionEntryId(sessionPath: string): unknown | null {
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const entry: unknown = JSON.parse(lines[i]);
        if (isRecord(entry) && entry.id) return entry.id;
      } catch {
        // skip malformed historical entries
      }
    }
  } catch {
    // best-effort persistence
  }
  return null;
}

export function latestPersistedMessageText(sessionPath: string): { role: unknown; text: string } | null {
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const entry: unknown = JSON.parse(lines[i]);
        const msg = getEntryMessage(entry);
        if (!msg?.role) continue;
        return {
          role: msg.role,
          text: extractText(contentForExtractText(msg.content)),
        };
      } catch {
        // skip malformed historical entries
      }
    }
  } catch {
    // best-effort persistence
  }
  return null;
}

export function persistedChatMessageText(message: unknown): string {
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

export function appendTextToMessageContent(message: { content?: unknown } | null | undefined, addition: unknown): boolean {
  const text = String(addition || "");
  if (!message || !text) return false;
  if (typeof message.content === "string") {
    message.content += text;
    return true;
  }
  if (!Array.isArray(message.content)) {
    message.content = [{ type: "text", text }];
    return true;
  }
  for (let i = message.content.length - 1; i >= 0; i -= 1) {
    const block = message.content[i];
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      block.text = `${block.text}${text}`;
      return true;
    }
  }
  message.content.push({ type: "text", text });
  return true;
}

export function appendTextToLatestAssistantRecord(sessionPath: string | null | undefined, addition: unknown): boolean {
  const text = String(addition || "");
  if (!sessionPath || !text) return false;
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const endsWithNewline = raw.endsWith("\n");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]?.trim()) continue;
      let entry: unknown = null;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const msg = getEntryMessage(entry);
      if (msg?.role !== "assistant") continue;
      if (!appendTextToMessageContent(msg, text)) return false;
      lines[i] = JSON.stringify(entry);
      fs.writeFileSync(sessionPath, `${lines.join("\n")}${endsWithNewline ? "" : "\n"}`, "utf-8");
      return true;
    }
  } catch (err) {
    debugLog()?.warn("ws", `[CODE-VERIFY-POSTSCRIPT v1] persist failed · ${formatError(err)} · ${sessionPath}`);
  }
  return false;
}

export function appendTextToLatestAssistantInMemory(session: unknown, addition: unknown): boolean {
  const messages = getSessionMessages(session);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = asPersistedMessage(messages[i]);
    if (msg?.role !== "assistant") continue;
    return appendTextToMessageContent(msg, addition);
  }
  return false;
}

export function appendJsonlLine(filePath: string, entry: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

export function ensureSessionFileOnDisk(sessionPath: string | null | undefined): boolean {
  if (!sessionPath) return false;
  try {
    const dir = path.dirname(sessionPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(sessionPath)) fs.writeFileSync(sessionPath, "", "utf-8");
    return true;
  } catch (err) {
    debugLog()?.warn("ws", `[PROMPT-SESSION-FILE v1] failed · ${formatError(err)} · ${sessionPath}`);
    return false;
  }
}

export function persistLocalQwen35DirectTurn(
  sessionPath: string | null | undefined,
  originalPromptText: unknown,
  assistantText: unknown,
  opts: PersistLocalQwen35DirectTurnOptions = {},
): void {
  if (!sessionPath || !assistantText) return;
  const now = new Date().toISOString();
  let parentId = getLastSessionEntryId(sessionPath);
  let userId: string | null = null;
  const latest = latestPersistedMessageText(sessionPath);
  if (!(latest?.role === "user" && String(latest.text || "").trim() === String(originalPromptText || "").trim())) {
    userId = sessionLineId();
    appendJsonlLine(sessionPath, {
      type: "message",
      id: userId,
      parentId,
      timestamp: now,
      message: {
        role: "user",
        content: [{ type: "text", text: String(originalPromptText || "") }],
        timestamp: Date.now(),
      },
    });
    parentId = userId;
  }

  const content = [];
  const reasoning = String(opts.reasoningText || "").trim();
  if (reasoning) {
    content.push({ type: "thinking", thinking: `${reasoning}\n`, thinkingSignature: "reasoning_content" });
  }
  content.push({ type: "text", text: String(assistantText || "") });
  appendJsonlLine(sessionPath, {
    type: "message",
    id: sessionLineId(),
    parentId,
    timestamp: now,
    message: {
      role: "assistant",
      content,
      api: opts.api || "openai-completions",
      provider: opts.provider || DEFAULT_LOCAL_QWEN35_PROVIDER_ID,
      model: opts.model || DEFAULT_LOCAL_QWEN35_MODEL_ID,
      usage: opts.usage || undefined,
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
}
