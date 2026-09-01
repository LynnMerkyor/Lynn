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

const IMAGE_TOOL_NAME_RE = /(?:^|_)(?:generate|edit)_image$/;

const ZH_DELIVERABLE_ACTION_RE = /(?:生成|创建|制作|导出|保存|下载|交付|撰写|写成|做成|转成|转换成|转换为|渲染成|画成|编辑|修改|改写|重写|更新|修复|补充)/;
const ZH_DELIVERABLE_FORMAT_RE = /(?:报告|网页|页面|html|文档|文件|附件|pptx?|幻灯片|docx?|pdf|海报|图片|长图|png|jpe?g|markdown|md\s*文件|README|可视化|(?:^|[\s`])[^\s`]+\.(?:md|markdown|txt|json|yaml|yml|csv|tsv|tsx?|jsx?|py|js|css|html?|pdf|docx?|xlsx?)(?:$|[\s`]))/i;
const EN_DELIVERABLE_ACTION_RE = /\b(?:create|generate|make|export|save|download|deliver|render|convert|turn|write)\b/i;
const EN_DELIVERABLE_FORMAT_RE = /\b(?:report|web\s?page|html|document|file|attachment|pptx?|slides?|docx?|pdf|poster|image|png|jpe?g|markdown|visualization)\b/i;
const ZH_IMAGE_ACTION_RE = /(?:生成|创建|制作|设计|绘制|画|生图|编辑|修改|替换|去掉|移除|添加|翻译成|做成|改成)/;
const ZH_IMAGE_FORMAT_RE = /(?:图片|图像|照片|插画|海报|封面|头图|头像|图标|壁纸|视觉稿|效果图|长图|png|jpe?g)/i;
const EN_IMAGE_ACTION_RE = /\b(?:create|generate|make|design|draw|paint|illustrate|edit|modify|replace|remove|add|translate|turn|convert)\b/i;
const EN_IMAGE_FORMAT_RE = /\b(?:image|picture|photo|illustration|poster|cover|hero\s?image|avatar|icon|wallpaper|visual|png|jpe?g)\b/i;
const SHORT_ANSWER_REQUEST_RE = /(?:一句话|只给|只回复|简短|简要|用一个词|用数字|只要答案|yes\s*\/\s*no|a\s*\/\s*b\s*\/\s*c\s*\/\s*d)/iu;
const TERMINAL_VISIBLE_CHAR_RE = /[。！？!?；;：:）)\]}＞>"'”’]$/u;
const SIMPLE_TRANSLATION_REQUEST_RE = /^(?:请)?(?:把|将)?\s*[A-Za-z][A-Za-z\d\s.'’_-]{0,48}\s*(?:翻译成|译成)\s*(?:中文|汉语|英文|英语)\s*[。.!！]?$/iu;

function normalizedToolName(name: unknown): string {
  return String(name || "").trim().toLowerCase().replace(/[.-]/g, "_");
}

export function isDeliverableToolName(name: unknown): boolean {
  return DELIVERABLE_TOOL_NAMES.has(normalizedToolName(name));
}

export function isFileMutationToolName(name: unknown): boolean {
  return FILE_MUTATION_TOOL_NAMES.has(normalizedToolName(name));
}

export function isImageMutationToolName(name: unknown): boolean {
  return IMAGE_TOOL_NAME_RE.test(normalizedToolName(name));
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
  if (question.length < 16 || visible.length > 140) return false;
  // Provider-side reasoning counters are approximate and may omit framing
  // tokens. Keep the guard structural instead of depending on a brittle
  // round-number boundary: a substantive prompt plus hidden reasoning and a
  // short non-terminal fragment should receive one continuation attempt.
  if (
    reasoningChars < 240
    || SHORT_ANSWER_REQUEST_RE.test(question)
    || SIMPLE_TRANSLATION_REQUEST_RE.test(question)
  ) return false;
  // A provider may put a complete <reflect>...</reflect> scaffold in content.
  // After final-answer normalization that is an empty visible answer and needs
  // the same single tool-free continuation as a truncated fragment.
  if (visible.length === 0) return true;
  return !TERMINAL_VISIBLE_CHAR_RE.test(visible);
}

export function isStructurallyCompletePartialAnswer(content: unknown): boolean {
  const visible = String(content || "").trim();
  if (visible.length < 24) return false;
  return TERMINAL_VISIBLE_CHAR_RE.test(visible)
    || /```\s*$/u.test(visible)
    || /(?:^|\n)\s*\|[^\n]+\|\s*$/u.test(visible);
}

export function hasExplicitDeliverableIntent(prompt: unknown): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return (ZH_DELIVERABLE_ACTION_RE.test(text) && ZH_DELIVERABLE_FORMAT_RE.test(text))
    || (EN_DELIVERABLE_ACTION_RE.test(text) && EN_DELIVERABLE_FORMAT_RE.test(text));
}

export function hasExplicitImageToolIntent(prompt: unknown): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return (ZH_IMAGE_ACTION_RE.test(text) && ZH_IMAGE_FORMAT_RE.test(text))
    || (EN_IMAGE_ACTION_RE.test(text) && EN_IMAGE_FORMAT_RE.test(text));
}

export interface TurnToolPolicy {
  allowDeliverables: boolean;
  allowImageTools: boolean;
}

export function filterToolsForTurn<T extends NamedTool>(
  tools: T[],
  policy: TurnToolPolicy,
): T[] {
  return tools.filter((tool) => {
    if (!policy.allowDeliverables
      && (isDeliverableToolName(tool?.name) || isFileMutationToolName(tool?.name))) {
      return false;
    }
    if (!policy.allowImageTools && isImageMutationToolName(tool?.name)) return false;
    return true;
  });
}

export function filterDeliverableToolsForTurn<T extends NamedTool>(
  tools: T[],
  allowDeliverables: boolean,
): T[] {
  return filterToolsForTurn(tools, { allowDeliverables, allowImageTools: true });
}
