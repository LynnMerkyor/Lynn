import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { debugLog } from "../../lib/debug-log.js";
import { stripRouteMetadataLeaks } from "./turn-retry-policy.js";
import { extractText } from "./content-utils.js";

const DEFAULT_LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
const DEFAULT_LOCAL_QWEN35_MODEL_ID = "qwen35-9b-q4km-imatrix";

function normalizePersistedAssistantText(text) {
  return String(text || "");
}

export function readPersistedAssistantRecords(session, sessionPath = "") {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const fromMessages = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    fromMessages.push(msg);
  }
  if (sessionPath) {
    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const fromFile = [];
      for (let i = 0; i < lines.length; i += 1) {
        const entry = JSON.parse(lines[i]);
        const msg = entry?.message;
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

export function readPersistedAssistantVisibleTexts(session, sessionPath = "") {
  return readPersistedAssistantRecords(session, sessionPath)
    .map((msg) => normalizePersistedAssistantText(extractText(msg.content)))
    .filter(Boolean);
}

export function countPersistedAssistantVisibleTexts(session, sessionPath = "") {
  return readPersistedAssistantVisibleTexts(session, sessionPath).length;
}

export function countPersistedAssistantMessages(session, sessionPath = "") {
  return readPersistedAssistantRecords(session, sessionPath).length;
}

export function extractLatestAssistantVisibleTextAfter(session, sessionPath = "", baselineCount = 0) {
  const texts = readPersistedAssistantVisibleTexts(session, sessionPath);
  if (texts.length <= Math.max(0, baselineCount || 0)) return "";
  return stripRouteMetadataLeaks(texts[texts.length - 1] || "");
}

export function extractLatestAssistantVisibleText(session, sessionPath = "") {
  return extractLatestAssistantVisibleTextAfter(session, sessionPath, 0);
}

export function sessionLineId() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function getLastSessionEntryId(sessionPath) {
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry?.id) return entry.id;
      } catch {
        // skip malformed historical entries
      }
    }
  } catch {
    // best-effort persistence
  }
  return null;
}

export function latestPersistedMessageText(sessionPath) {
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry?.message;
        if (!msg?.role) continue;
        return {
          role: msg.role,
          text: extractText(msg.content),
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

export function persistedChatMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function appendTextToMessageContent(message, addition) {
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
    if (block?.type === "text" && typeof block.text === "string") {
      block.text += text;
      return true;
    }
  }
  message.content.push({ type: "text", text });
  return true;
}

export function appendTextToLatestAssistantRecord(sessionPath, addition) {
  const text = String(addition || "");
  if (!sessionPath || !text) return false;
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const endsWithNewline = raw.endsWith("\n");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]?.trim()) continue;
      let entry = null;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry?.message?.role !== "assistant") continue;
      if (!appendTextToMessageContent(entry.message, text)) return false;
      lines[i] = JSON.stringify(entry);
      fs.writeFileSync(sessionPath, `${lines.join("\n")}${endsWithNewline ? "" : "\n"}`, "utf-8");
      return true;
    }
  } catch (err) {
    debugLog()?.warn("ws", `[CODE-VERIFY-POSTSCRIPT v1] persist failed · ${err?.message || err} · ${sessionPath}`);
  }
  return false;
}

export function appendTextToLatestAssistantInMemory(session, addition) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "assistant") continue;
    return appendTextToMessageContent(messages[i], addition);
  }
  return false;
}

export function appendJsonlLine(filePath, entry) {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

export function ensureSessionFileOnDisk(sessionPath) {
  if (!sessionPath) return false;
  try {
    const dir = path.dirname(sessionPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(sessionPath)) fs.writeFileSync(sessionPath, "", "utf-8");
    return true;
  } catch (err) {
    debugLog()?.warn("ws", `[PROMPT-SESSION-FILE v1] failed · ${err?.message || err} · ${sessionPath}`);
    return false;
  }
}

export function persistLocalQwen35DirectTurn(sessionPath, originalPromptText, assistantText, opts = {}) {
  if (!sessionPath || !assistantText) return;
  const now = new Date().toISOString();
  let parentId = getLastSessionEntryId(sessionPath);
  let userId = null;
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
