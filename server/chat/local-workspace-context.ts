import fs, { type Dirent, type Stats } from "fs";
import path from "path";

import {
  isInternalAutomationPrompt,
  ROUTE_INTENTS,
  normalizeRouteIntent,
} from "../../shared/task-route-intent.js";

const LOCAL_WORKSPACE_RE = /(?:\b(?:workspace|working directory|folder|directory|files?|desk|note|notes|todo|task list|current project)\b|工作空间|工作区|当前目录|桌面|文件夹|目录|文件|文档|本地|小说|章节|第一章|笺|便签|工作清单|优先事项|待办|项目)/i;
const LOCAL_ACTION_RE = /(?:\b(?:read|scan|inspect|look at|list|find|search|summarize|organize|review|check|delete|remove|clean)\b|读一下|读读|帮我读|阅读|读取|看看|看一下|查看|查找|找到|搜索|寻找|检查|扫描|列出|整理|总结|汇总|分析|打开|删除|删掉|移除|清理)/i;
const LOCAL_DIRECT_READ_RE = /(?:\b(?:read|scan|inspect|look at|list|find|search|summarize|review|check)\b|读一下|读读|帮我读|阅读|读取|看看|看一下|查看|查找|找到|搜索|寻找|检查|扫描|列出|总结|汇总|打开)/i;
const LOCAL_MUTATION_RE = /(?:\b(?:delete|remove|clean|move|copy|rename|write|edit|modify|create|make|organize)\b|删除|删掉|移除|清理|移动|挪到|复制|拷贝|重命名|写入|编辑|修改|改写|创建|新建|整理|归档)/i;
const ABSOLUTE_PATH_RE = /((?:\/(?:Users|Volumes|Applications|opt|var|tmp|private|home|srv|mnt|etc)[^\s"'`“”‘’）),，。；;]*)|(?:[A-Za-z]:[\\/][^\s"'`“”‘’）),，。；;]*))/g;
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
const DOC_EXT_RE = /\.(?:md|markdown|txt|todo|log|tex|bib|rst|json|ya?ml|csv|ts|tsx|js|jsx|py|java|go|rs|c|cc|cpp|h|hpp|css|html|xml)$/i;
const NOTE_NAME_RE = /(?:笺|便签|工作|清单|待办|计划|优先|jian|note|todo|task|plan|readme)/i;
const LOCAL_ACCESS_META_RE = /(?:为什么|为何|怎么会|无法|不能|打不开|被阻止|协议被阻止|file:\/\/|browser blocked|protocol blocked|can't|cannot|unable)/i;

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
  requestedFile?: WorkspaceDocument | null;
} | {
  ok: false;
  root: string;
  promptText: string;
  now: Date;
  entries: WorkspaceEntry[];
  docs: WorkspaceDocument[];
  requestedFile?: WorkspaceDocument | null;
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

function extractExplicitPathCandidates(promptText: unknown): string[] {
  const text = String(promptText || "");
  const matches: string[] = [];
  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    const raw = String(match[1] || "").replace(/[，。；;:：,.]+$/g, "");
    if (!raw) continue;
    const matchIndex = Number(match.index ?? 0);
    if (/^[A-Za-z]:[\\/]/.test(raw) && matchIndex > 0 && /[A-Za-z0-9]/.test(text[matchIndex - 1] || "")) {
      continue;
    }
    try {
      matches.push(decodeURI(raw));
    } catch {
      matches.push(raw);
    }
  }
  return matches.map((candidate) => path.resolve(candidate));
}

function hasExplicitLocalPath(promptText: unknown): boolean {
  return extractExplicitPathCandidates(promptText).length > 0;
}

function extractExplicitFilePath(promptText: unknown): string {
  for (const candidate of extractExplicitPathCandidates(promptText)) {
    const stat = safeStat(candidate);
    if (stat?.isFile()) return candidate;
  }
  return "";
}

function extractExplicitWorkspacePath(promptText: unknown): string {
  const text = String(promptText || "");
  const matches = extractExplicitPathCandidates(promptText);
  for (const candidate of matches) {
    const stat = safeStat(candidate);
    if (stat?.isDirectory()) return candidate;
    if (stat?.isFile()) return path.dirname(candidate);
  }
  if (/(?:下载文件夹|下载目录|Downloads(?:\s+folder)?)/i.test(text)) {
    return path.join(process.env.HOME || "", "Downloads");
  }
  return matches[0] || "";
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
    const maxReadBytes = Math.max(16_384, Math.min(512_000, Math.max(1, maxChars) * 8));
    const raw = entry.size > maxReadBytes
      ? readFilePrefix(entry.full, maxReadBytes)
      : fs.readFileSync(entry.full, "utf8");
    const text = raw.replace(/\0/g, "").trim();
    if (text.length <= maxChars && entry.size <= maxReadBytes) return text;
    const suffix = entry.size > maxReadBytes
      ? `内容过长，仅读取前 ${formatSize(maxReadBytes)} / 共 ${formatSize(entry.size)}`
      : `内容过长，已截断 ${text.length - maxChars} 字`;
    return `${text.slice(0, maxChars)}\n\n[${suffix}]`;
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err ? err.message : err;
    return `[读取失败: ${message || err}]`;
  }
}

function readFilePrefix(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function buildRequestedFileDocument(filePath: string, root: string, maxChars: number): WorkspaceDocument | null {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) return null;
  const rel = path.relative(root, filePath) || path.basename(filePath);
  const entry: WorkspaceEntry = {
    rel: toPosixPath(rel),
    full: filePath,
    isDir: false,
    size: stat.size || 0,
    mtimeMs: stat.mtimeMs || 0,
  };
  return {
    ...entry,
    preview: readDocumentPreview(entry, maxChars),
  };
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
  const explicitFile = extractExplicitFilePath(promptText);
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
  const requestedFile = explicitFile ? buildRequestedFileDocument(explicitFile, root, maxDocChars) : null;
  const docs = pickDocuments(entries, maxDocs).map((entry) => ({
    ...entry,
    preview: readDocumentPreview(entry, maxDocChars),
  }));
  if (requestedFile && !docs.some((doc) => doc.full === requestedFile.full)) {
    docs.unshift(requestedFile);
    if (docs.length > maxDocs) docs.length = maxDocs;
  }
  return {
    ok: true,
    root,
    promptText: String(promptText || ""),
    now,
    entries,
    docs,
    requestedFile,
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
  if (LOCAL_ACCESS_META_RE.test(text) && !hasExplicitLocalPath(text)) return false;
  if (hasExplicitLocalPath(text)) return LOCAL_ACTION_RE.test(text);
  return LOCAL_WORKSPACE_RE.test(text) && LOCAL_ACTION_RE.test(text);
}

export function shouldUseLocalWorkspaceDirectReply(promptText: unknown, routeIntent?: string | null): boolean {
  if (!shouldAttachLocalWorkspaceContext(promptText, routeIntent)) return false;
  const text = String(promptText || "");
  if (LOCAL_ACCESS_META_RE.test(text) && !/^\s*(?:read|scan|inspect|look at|list|find|search|summarize|review|check|读一下|读读|帮我读|阅读|读取|看看|看一下|查看|查找|找到|搜索|寻找|检查|扫描|列出|总结|汇总|打开)/i.test(text)) return false;
  if (LOCAL_MUTATION_RE.test(text)) return false;
  return LOCAL_DIRECT_READ_RE.test(text);
}

function extractRequestedSecret(promptText: unknown, docs: WorkspaceDocument[]): string {
  const text = String(promptText || "");
  if (!/暗号|口令|密码|code word|passphrase/i.test(text)) return "";
  for (const doc of docs) {
    const match = String(doc.preview || "").match(/(?:暗号|口令|密码)\s*[:：]\s*([^\n。；;，,]{2,40})/i);
    if (match?.[1]) return match[1].trim().replace(/[。；;，,]+$/g, "");
  }
  return "";
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
      text: `我无法读取 \`${snapshot.root}\`：路径不存在、不可访问，或不是可列出的本地目录。`,
    };
  }

  if (snapshot.requestedFile) {
    const preview = String(snapshot.requestedFile.preview || "").trim();
    return {
      ok: true,
      root: snapshot.root,
      entriesCount: snapshot.entries.length,
      docsCount: snapshot.docs.length,
      text: [
        `我已读取 \`${snapshot.requestedFile.full}\`（${formatSize(snapshot.requestedFile.size)}）。`,
        "",
        "主要内容：",
        preview || "(文件为空)",
      ].join("\n"),
    };
  }

  const topEntries = snapshot.entries.slice(0, 32).map(formatEntryLine).filter(Boolean).join("\n");
  const jianDoc = snapshot.docs.find((doc) => /(?:^|\/)jian\.md$/i.test(doc.rel))
    || snapshot.docs.find((doc) => /笺|便签|工作清单|待办|计划/.test(doc.rel));
  const openTasks = extractOpenTasks(jianDoc?.preview);
  const importantDocs = summarizeImportantDocs(snapshot.docs);
  const requestedSecret = extractRequestedSecret(snapshot.promptText, snapshot.docs);

  if (requestedSecret) {
    return {
      ok: true,
      root: snapshot.root,
      entriesCount: snapshot.entries.length,
      docsCount: snapshot.docs.length,
      text: requestedSecret,
    };
  }

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

  const docPreviews = snapshot.docs.slice(0, 2);
  if (docPreviews.length > 0) {
    lines.push("");
    lines.push("文档摘录：");
    for (const doc of docPreviews) {
      lines.push(`\`${doc.rel}\`：`);
      lines.push(String(doc.preview || "").slice(0, 900));
    }
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
    lines.push(`读取状态：失败，路径不存在、不可访问，或不是可列出的本地目录。`);
    return lines.join("\n");
  }

  const entries = snapshot.entries;
  if (snapshot.requestedFile) {
    lines.push(`读取状态：成功。已读取用户指定文件 \`${snapshot.requestedFile.full}\`（${formatSize(snapshot.requestedFile.size)}）。`);
  } else {
    lines.push(`读取状态：成功。目录项摘要 ${entries.length} 条。`);
  }
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
