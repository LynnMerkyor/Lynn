type NamedTool = { name: string };

const DELIVERABLE_TOOL_NAMES = new Set([
  "create_artifact",
  "create_docx",
  "create_pdf",
  "create_poster",
  "create_pptx",
  "create_report",
  "present_files",
]);

const FILE_MUTATION_TOOL_NAMES = new Set(["write", "edit"]);

const ZH_DELIVERABLE_ACTION_RE = /(?:生成|创建|制作|导出|保存|下载|交付|撰写|写成|做成|转成|转换成|转换为|渲染成|画成|编辑|修改|改写|重写|更新|修复|补充)/;
const ZH_DELIVERABLE_FORMAT_RE = /(?:报告|网页|页面|html|文档|文件|附件|pptx?|幻灯片|docx?|pdf|海报|图片|长图|png|jpe?g|markdown|md\s*文件|README|可视化|(?:^|[\s`])[^\s`]+\.(?:md|markdown|txt|json|yaml|yml|csv|tsv|tsx?|jsx?|py|js|css|html?|pdf|docx?|xlsx?)(?:$|[\s`]))/i;
const EN_DELIVERABLE_ACTION_RE = /\b(?:create|generate|make|export|save|download|deliver|render|convert|turn|write)\b/i;
const EN_DELIVERABLE_FORMAT_RE = /\b(?:report|web\s?page|html|document|file|attachment|pptx?|slides?|docx?|pdf|poster|image|png|jpe?g|markdown|visualization)\b/i;
const SHORT_ANSWER_REQUEST_RE = /(?:一句话|只给|只回复|简短|简要|用一个词|用数字|只要答案|yes\s*\/\s*no|a\s*\/\s*b\s*\/\s*c\s*\/\s*d)/iu;
const TERMINAL_VISIBLE_CHAR_RE = /[。！？!?；;：:）)\]}＞>"'”’]$/u;

function normalizedToolName(name: unknown): string {
  return String(name || "").trim().toLowerCase().replace(/-/g, "_");
}

export function isDeliverableToolName(name: unknown): boolean {
  return DELIVERABLE_TOOL_NAMES.has(normalizedToolName(name));
}

export function isFileMutationToolName(name: unknown): boolean {
  return FILE_MUTATION_TOOL_NAMES.has(normalizedToolName(name));
}

/**
 * Reasoning models can spend the output budget and stop after an unfinished
 * visible fragment. A single tool-free continuation is safer than persisting
 * that fragment as the answer, but short-answer requests must remain short.
 */
export function shouldRecoverIncompleteVisibleAnswer(
  prompt: unknown,
  content: unknown,
  reasoningChars: number,
): boolean {
  const question = String(prompt || "").trim();
  const visible = String(content || "").trim();
  if (question.length < 16 || visible.length === 0 || visible.length > 140) return false;
  // Provider-side reasoning counters are approximate and may omit framing
  // tokens. Keep the guard structural instead of depending on a brittle
  // round-number boundary: a substantive prompt plus hidden reasoning and a
  // short non-terminal fragment should receive one continuation attempt.
  if (reasoningChars < 240 || SHORT_ANSWER_REQUEST_RE.test(question)) return false;
  return !TERMINAL_VISIBLE_CHAR_RE.test(visible);
}

export function hasExplicitDeliverableIntent(prompt: unknown): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return (ZH_DELIVERABLE_ACTION_RE.test(text) && ZH_DELIVERABLE_FORMAT_RE.test(text))
    || (EN_DELIVERABLE_ACTION_RE.test(text) && EN_DELIVERABLE_FORMAT_RE.test(text));
}

export function filterDeliverableToolsForTurn<T extends NamedTool>(
  tools: T[],
  allowDeliverables: boolean,
): T[] {
  if (allowDeliverables) return tools;
  return tools.filter((tool) => !isDeliverableToolName(tool?.name) && !isFileMutationToolName(tool?.name));
}
