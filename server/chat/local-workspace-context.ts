import fs, { type Dirent, type Stats } from "fs";
import path from "path";

import {
  isInternalAutomationPrompt,
  ROUTE_INTENTS,
  normalizeRouteIntent,
} from "../../shared/task-route-intent.js";

const LOCAL_WORKSPACE_RE = /(?:\b(?:workspace|working directory|folder|directory|files?|desk|note|notes|todo|task list|current project)\b|工作空间|工作区|当前目录|桌面|文件夹|目录|文件|文档|笺|便签|工作清单|优先事项|待办|项目)/i;
const LOCAL_ACTION_RE = /(?:\b(?:read|scan|inspect|look at|list|summarize|organize|review|check|delete|remove|clean)\b|读一下|读取|看看|看一下|查看|检查|扫描|列出|整理|总结|汇总|分析|打开|删除|删掉|移除|清理)/i;
const ABSOLUTE_PATH_RE = /((?:\/(?:Users|Volumes|Applications|opt|var|tmp|private|home|srv|mnt|etc)[^\s"'`“”‘’）),，。；;]*)|(?:[A-Za-z]:\\[^\s"'`“”‘’）),，。；;]*))/g;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
]);
const DOC_EXT_RE = /\.(?:md|markdown|txt|todo|log)$/i;
const NOTE_NAME_RE = /(?:笺|便签|工作|清单|待办|计划|优先|jian|note|todo|task|plan|readme)/i;

interface WorkspaceEntry {
  rel: string;
  full: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

interface WorkspaceDocument extends WorkspaceEntry {
  preview: string;
}

interface WalkOptions {
  maxDepth?: number;
  maxEntries?: number;
}

interface WorkspaceOptions {
  promptText?: unknown;
  cwd?: unknown;
  maxEntries?: number;
  maxDocs?: number;
  maxDocChars?: number;
  now?: Date;
}

type WorkspaceSnapshot = {
  ok: true;
  root: string;
  promptText: string;
  now: Date;
  entries: WorkspaceEntry[];
  docs: WorkspaceDocument[];
} | {
  ok: false;
  root: string;
  promptText: string;
  now: Date;
  entries: WorkspaceEntry[];
  docs: WorkspaceDocument[];
  error: string;
};

export type LocalWorkspaceDirectReply = {
  ok: false;
  root: string;
  entriesCount: number;
  text: string;
} | {
  ok: true;
  root: string;
  entriesCount: number;
  docsCount: number;
  text: string;
};

function safeStat(filePath: string): Stats | null {
  try { return fs.statSync(filePath); } catch { return null; }
}

function safeReadDir(dir: string): Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function extractExplicitWorkspacePath(promptText: unknown): string {
  const text = String(promptText || "");
  const matches: string[] = [];
  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    const raw = String(match[1] || "").replace(/[，。；;:：,.]+$/g, "");
    if (raw) matches.push(raw);
  }
  for (const candidate of matches) {
    const resolved = path.resolve(candidate);
    const stat = safeStat(resolved);
    if (stat?.isDirectory()) return resolved;
  }
  if (/(?:下载文件夹|下载目录|Downloads(?:\s+folder)?)/i.test(text)) {
    return path.join(process.env.HOME || "", "Downloads");
  }
  return matches[0] ? path.resolve(matches[0]) : "";
}

function formatSize(bytes: unknown): string {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function toPosixPath(filePath: unknown): string {
  return String(filePath || "").split(path.sep).join("/");
}

function walkWorkspace(root: string, { maxDepth = 2, maxEntries = 80 }: WalkOptions = {}): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  while (queue.length && entries.length < maxEntries) {
    const current = queue.shift();
    if (!current) break;
    const dirents = safeReadDir(current.dir)
      .filter((item) => !item.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-Hans-CN");
      });

    for (const item of dirents) {
      if (entries.length >= maxEntries) break;
      const rel = current.rel ? path.join(current.rel, item.name) : item.name;
      const full = path.join(root, rel);
      const stat = safeStat(full);
      entries.push({
        rel: toPosixPath(rel),
        full,
        isDir: item.isDirectory(),
        size: stat?.size || 0,
        mtimeMs: stat?.mtimeMs || 0,
      });
      if (item.isDirectory() && current.depth < maxDepth && !SKIP_DIRS.has(item.name)) {
        queue.push({ dir: full, rel, depth: current.depth + 1 });
      }
    }
  }
  return entries;
}

function scoreDoc(entry: WorkspaceEntry): number {
  const nameScore = NOTE_NAME_RE.test(entry.rel) ? 100 : 0;
  const rootScore = entry.rel.includes("/") ? 0 : 30;
  const recentScore = Math.max(0, Math.min(30, Math.floor((entry.mtimeMs || 0) / 86_400_000_000)));
  return nameScore + rootScore + recentScore;
}

function pickDocuments(entries: WorkspaceEntry[], maxDocs = 6): WorkspaceEntry[] {
  return entries
    .filter((entry) => !entry.isDir && DOC_EXT_RE.test(entry.rel))
    .filter((entry) => entry.size > 0 && entry.size <= 120_000)
    .sort((a, b) => scoreDoc(b) - scoreDoc(a) || b.mtimeMs - a.mtimeMs)
    .slice(0, maxDocs);
}

function readDocumentPreview(entry: WorkspaceEntry, maxChars: number): string {
  try {
    const raw = fs.readFileSync(entry.full, "utf8");
    const text = raw.replace(/\0/g, "").trim();
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n\n[内容过长，已截断 ${text.length - maxChars} 字]`;
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err ? err.message : err;
    return `[读取失败: ${message || err}]`;
  }
}

function extractOpenTasks(text: unknown): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+\[\s\]/.test(line))
    .map((line) => line.replace(/^-\s+\[\s\]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function getSnapshot({ promptText, cwd, maxEntries = 80, maxDocs = 6, maxDocChars = 2600, now = new Date() }: WorkspaceOptions = {}): WorkspaceSnapshot {
  const explicitRoot = extractExplicitWorkspacePath(promptText);
  const root = explicitRoot || path.resolve(String(cwd || process.cwd()));
  const stat = safeStat(root);
  if (!stat || !stat.isDirectory()) {
    return {
      ok: false,
      root,
      promptText: String(promptText || ""),
      now,
      entries: [],
      docs: [],
      error: "路径不存在或不是目录",
    };
  }
  const entries = walkWorkspace(root, { maxEntries });
  const docs = pickDocuments(entries, maxDocs).map((entry) => ({
    ...entry,
    preview: readDocumentPreview(entry, maxDocChars),
  }));
  return {
    ok: true,
    root,
    promptText: String(promptText || ""),
    now,
    entries,
    docs,
  };
}

function formatEntryLine(entry: WorkspaceEntry | null | undefined): string {
  if (!entry) return "";
  if (entry.isDir) return `- [目录] ${entry.rel}`;
  return `- [文件] ${entry.rel} · ${formatSize(entry.size)}`;
}

function summarizeImportantDocs(docs: WorkspaceDocument[]): string {
  return docs
    .slice(0, 5)
    .map((doc) => {
      const firstLine = String(doc.preview || "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("---"));
      return `- ${doc.rel}${firstLine ? `：${firstLine.slice(0, 80)}` : ""}`;
    })
    .join("\n");
}

export function shouldAttachLocalWorkspaceContext(promptText: unknown, routeIntent?: string | null): boolean {
  const intent = normalizeRouteIntent(routeIntent);
  if (intent !== ROUTE_INTENTS.UTILITY && intent !== ROUTE_INTENTS.CODING) return false;
  const text = String(promptText || "");
  if (isInternalAutomationPrompt(text)) return false;
  return LOCAL_WORKSPACE_RE.test(text) && LOCAL_ACTION_RE.test(text);
}

export function buildLocalWorkspaceDirectReply({
  promptText,
  cwd,
  maxEntries = 80,
  maxDocs = 6,
  maxDocChars = 2600,
  now = new Date(),
}: WorkspaceOptions = {}): LocalWorkspaceDirectReply {
  const snapshot = getSnapshot({ promptText, cwd, maxEntries, maxDocs, maxDocChars, now });
  if (!snapshot.ok) {
    return {
      ok: false,
      root: snapshot.root,
      entriesCount: 0,
      text: `我刚刚读取了 \`${snapshot.root}\`，但这个路径不存在或不是目录。`,
    };
  }

  const topEntries = snapshot.entries.slice(0, 32).map(formatEntryLine).filter(Boolean).join("\n");
  const jianDoc = snapshot.docs.find((doc) => /(?:^|\/)jian\.md$/i.test(doc.rel))
    || snapshot.docs.find((doc) => /笺|便签|工作清单|待办|计划/.test(doc.rel));
  const openTasks = extractOpenTasks(jianDoc?.preview);
  const importantDocs = summarizeImportantDocs(snapshot.docs);

  const lines = [
    `我已读取 \`${snapshot.root}\`。当前看到 ${snapshot.entries.length} 个目录项。`,
    "",
    "主要内容：",
    topEntries || "- (空目录)",
  ];

  if (jianDoc) {
    lines.push("");
    lines.push(`工作笺：\`${jianDoc.rel}\``);
    if (openTasks.length > 0) {
      lines.push("未完成事项：");
      for (const task of openTasks) lines.push(`- ${task}`);
    } else {
      lines.push("当前没有明显未完成勾选项，已有计划大多显示完成。");
    }
  }

  if (importantDocs) {
    lines.push("");
    lines.push("重点文档预览：");
    lines.push(importantDocs);
  }

  lines.push("");
  lines.push("如果你要我继续整理，我可以直接按这些文件生成今日清单、归档建议或发布前检查项。");

  return {
    ok: true,
    root: snapshot.root,
    entriesCount: snapshot.entries.length,
    docsCount: snapshot.docs.length,
    text: lines.join("\n"),
  };
}

export function buildLocalWorkspaceContext({
  promptText,
  cwd,
  maxEntries = 80,
  maxDocs = 6,
  maxDocChars = 2600,
  now = new Date(),
}: WorkspaceOptions = {}): string {
  const snapshot = getSnapshot({ promptText, cwd, maxEntries, maxDocs, maxDocChars, now });
  const root = snapshot.root;
  const lines = [
    "【Lynn 本地工作区快照】",
    `用户当前请求：${String(promptText || "").trim() || "(空)"}`,
    `工作区路径：${root}`,
    `读取时间：${now.toISOString()}`,
  ];

  if (!snapshot.ok) {
    lines.push(`读取状态：失败，路径不存在或不是目录。`);
    return lines.join("\n");
  }

  const entries = snapshot.entries;
  lines.push(`读取状态：成功。目录项摘要 ${entries.length} 条。`);
  lines.push("");
  lines.push("目录摘要：");
  if (entries.length === 0) {
    lines.push("- (空目录)");
  } else {
    for (const entry of entries) {
      const kind = entry.isDir ? "dir" : "file";
      const meta = entry.isDir ? "" : ` · ${formatSize(entry.size)}`;
      lines.push(`- [${kind}] ${entry.rel}${meta}`);
    }
  }

  const docs = snapshot.docs;
  if (docs.length > 0) {
    lines.push("");
    lines.push("重点文档预览：");
    for (const doc of docs) {
      lines.push("");
      lines.push(`--- ${doc.rel} (${formatSize(doc.size)}) ---`);
      lines.push(doc.preview);
    }
  }

  return lines.join("\n");
}
