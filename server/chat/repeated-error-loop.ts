import { extractText } from "./content-utils.js";

type HistoryMessage = { role?: string; content?: unknown };

export interface RepeatedErrorLoop {
  count: number;
  signature: string;
}

export function extractErrorSignature(value: unknown): string {
  const text = String(value || "").replace(/\\n/gu, "\n");
  const match = text.match(/\b([A-Za-z_][\w.]*(?:Error|Exception))\s*:\s*([^\n\r。；;]+)/u);
  if (!match) return "";
  const detail = String(match[2] || "")
    .replace(/[“”‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return `${String(match[1] || "").toLowerCase()}:${detail}`;
}

export function detectRepeatedErrorLoop(
  history: HistoryMessage[] | null | undefined,
  currentPrompt: unknown,
  threshold = 3,
): RepeatedErrorLoop | null {
  const currentText = String(currentPrompt || "").trim();
  const currentSignature = extractErrorSignature(currentText);
  if (!currentSignature) return null;

  const userPrompts = (Array.isArray(history) ? history : [])
    .filter((message) => message?.role === "user")
    .map((message) => extractText(message?.content as any).trim())
    .filter(Boolean);
  if (userPrompts[userPrompts.length - 1] !== currentText) userPrompts.push(currentText);

  let count = 0;
  for (let i = userPrompts.length - 1; i >= 0; i -= 1) {
    if (extractErrorSignature(userPrompts[i]) !== currentSignature) break;
    count += 1;
  }
  return count >= Math.max(2, threshold) ? { count, signature: currentSignature } : null;
}

export function buildRepeatedErrorLoopAnswer(loop: RepeatedErrorLoop | null): string {
  if (!loop) return "";
  return [
    `连续 ${loop.count} 次出现相同的错误，当前修复路径已经进入循环；本轮先停止继续执行和修改。`,
    "请重新规划：核对完整 traceback、报错文件的真实路径、模块实际导出名，以及 Python 和依赖版本是否来自预期环境。",
    "补齐这些信息后再继续，避免在缺少证据时重复运行同一组命令。",
  ].join("\n");
}
