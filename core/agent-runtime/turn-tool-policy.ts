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

const ZH_DELIVERABLE_ACTION_RE = /(?:生成|创建|制作|导出|保存|下载|交付|撰写|写成|做成|转成|转换成|转换为|渲染成|画成)/;
const ZH_DELIVERABLE_FORMAT_RE = /(?:报告|网页|页面|html|文档|文件|附件|pptx?|幻灯片|docx?|pdf|海报|图片|长图|png|jpe?g|markdown|md\s*文件|可视化)/i;
const EN_DELIVERABLE_ACTION_RE = /\b(?:create|generate|make|export|save|download|deliver|render|convert|turn|write)\b/i;
const EN_DELIVERABLE_FORMAT_RE = /\b(?:report|web\s?page|html|document|file|attachment|pptx?|slides?|docx?|pdf|poster|image|png|jpe?g|markdown|visualization)\b/i;

function normalizedToolName(name: unknown): string {
  return String(name || "").trim().toLowerCase().replace(/-/g, "_");
}

export function isDeliverableToolName(name: unknown): boolean {
  return DELIVERABLE_TOOL_NAMES.has(normalizedToolName(name));
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
  return tools.filter((tool) => !isDeliverableToolName(tool?.name));
}
