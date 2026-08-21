const TASK_NARRATION_ACTOR_RE = /^(?:用户|提问者)(?:现在|当前)?(?:需要|想要|要求|希望)/u;
const TASK_NARRATION_DIRECTIVE_RE = /^(?:我)?(?:应当|应该|需要|可以|将|要)?(?:直接给|直接提供|给出|提供|按|分成|从)/u;
const TASK_NARRATION_META_RE = /(?:结构化|按.{0,40}(?:排列|整理|组织)|让(?:用户|提问者)|回答(?:应|要)|无需|不需要|分成.{0,30}(?:部分|块|类)|照着执行)/u;
const LEADING_SENTENCE_RE = /^\s*([^。！？!?\n]{1,180}[。！？!?])\s*([^。！？!?\n]{1,220}[。！？!?])([\s\S]*)$/u;
const VISIBLE_CHINESE_STRUCTURAL_LABEL_RE = /(^|\n)\s*<[^<>\n]*(?:方案|计划|流程|步骤|回答|思路|分析|总结|大纲|设定|章节规划)[^<>\n]*>\s*/gu;

/**
 * Remove a high-confidence model planning preface accidentally exposed as
 * assistant prose.  The match deliberately requires two leading sentences:
 * a third-person restatement of the user's need followed by an answer-writing
 * directive.  Ordinary advice such as “用户需要先留存证据” is preserved.
 */
export function stripLeadingInternalTaskNarration(value: unknown): string {
  const text = String(value || "");
  const match = text.match(LEADING_SENTENCE_RE);
  if (!match) return text;
  const first = match[1].trim();
  const second = match[2].trim();
  const rest = match[3];
  if (!TASK_NARRATION_ACTOR_RE.test(first)) return text;
  if (!TASK_NARRATION_DIRECTIVE_RE.test(second)) return text;
  if (!TASK_NARRATION_META_RE.test(second)) return text;
  return rest.trimStart();
}

export function couldStartInternalTaskNarration(value: unknown): boolean {
  const compact = String(value || "").trimStart();
  if (!compact) return true;
  return ["用户", "提问者"].some((prefix) => prefix.startsWith(compact) || compact.startsWith(prefix));
}

export function stripVisibleChineseStructuralLabels(value: unknown): string {
  return String(value || "").replace(VISIBLE_CHINESE_STRUCTURAL_LABEL_RE, "$1");
}
