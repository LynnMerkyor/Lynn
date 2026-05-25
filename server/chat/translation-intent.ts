interface TranslationTargetSpec {
  label: string;
  aliases: readonly string[];
}

const TRANSLATION_TARGETS = [
  { label: "繁体中文", aliases: ["繁体中文", "繁中", "traditional chinese", "traditional"] },
  { label: "简体中文", aliases: ["简体中文", "简中", "simplified chinese", "simplified"] },
  { label: "中文", aliases: ["中文", "汉语", "chinese", "mandarin"] },
  { label: "英文", aliases: ["英文", "英语", "english", "en"] },
  { label: "日文", aliases: ["日文", "日语", "japanese", "ja"] },
  { label: "韩文", aliases: ["韩文", "韩语", "korean", "ko"] },
  { label: "法文", aliases: ["法文", "法语", "french", "fr"] },
  { label: "德文", aliases: ["德文", "德语", "german", "de"] },
  { label: "西班牙文", aliases: ["西班牙文", "西班牙语", "spanish", "es"] },
  { label: "粤语", aliases: ["粤语", "广东话", "cantonese"] },
] as const satisfies readonly TranslationTargetSpec[];

export type TranslationTargetLabel = (typeof TRANSLATION_TARGETS)[number]["label"];

interface TranslationTargetAliasPair {
  label: TranslationTargetLabel;
  alias: string;
}

export interface QuickTranslationIntent {
  targetLanguage: TranslationTargetLabel;
  sourceText: string;
}

export const TRANSLATION_TARGET_LABELS: readonly TranslationTargetLabel[] = Object.freeze(TRANSLATION_TARGETS.map((target) => target.label));

const TARGET_ALIAS_PAIRS: readonly TranslationTargetAliasPair[] = TRANSLATION_TARGETS.flatMap((target) => (
  target.aliases.map((alias) => ({ label: target.label, alias }))
));

const TARGET_ALIAS_PATTERN = TARGET_ALIAS_PAIRS
  .map(({ alias }) => escapeRegExp(alias))
  .sort((a, b) => b.length - a.length)
  .join("|");

function normalizeText(value: unknown): string {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function normalizeKey(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTranslationTarget(value: unknown): TranslationTargetLabel | null;
export function normalizeTranslationTarget(value: unknown, fallback: null): TranslationTargetLabel | null;
export function normalizeTranslationTarget<T extends string>(value: unknown, fallback: T): TranslationTargetLabel | T;
export function normalizeTranslationTarget(value: unknown, fallback: string | null = null): TranslationTargetLabel | string | null {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  if (raw.length > 32 || /[\r\n{}[\]<>]/.test(raw)) return fallback;
  const key = normalizeKey(raw);
  for (const { label, alias } of TARGET_ALIAS_PAIRS) {
    if (key === normalizeKey(alias)) return label;
  }
  return fallback;
}

function findTargetInCommand(commandText: unknown): TranslationTargetLabel | null {
  const command = normalizeText(commandText);
  if (!command) return null;
  for (const { label, alias } of TARGET_ALIAS_PAIRS) {
    const escaped = escapeRegExp(alias);
    const pattern = /[a-z]/i.test(alias)
      ? new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`, "i")
      : new RegExp(escaped, "i");
    if (pattern.test(command)) return label;
  }
  return null;
}

function defaultTargetForCommand(commandText: unknown): TranslationTargetLabel {
  const command = String(commandText || "");
  if (/\btranslate\b/i.test(command) && !/(?:翻译|译一下|译成|译为)/.test(command)) return "中文";
  return "英文";
}

function stripWrappingQuotes(text: unknown): string {
  return normalizeText(text)
    .replace(/^[“"']+/, "")
    .replace(/[”"']+$/, "")
    .trim();
}

function isTranslationMetaQuestion(text: unknown): boolean {
  return /(?:翻译功能|翻译插件|如何翻译|怎么翻译|翻译怎么用)/.test(String(text || ""));
}

function isTranslationCommand(commandText: unknown): boolean {
  const command = normalizeText(commandText).replace(/[：:]\s*$/, "");
  if (!command || isTranslationMetaQuestion(command)) return false;
  if (/[?？]/.test(command)) return false;

  const targetPart = `(?:${TARGET_ALIAS_PATTERN})`;
  const zhCommand = new RegExp(
    `^(?:请|帮我|麻烦)?(?:把|将)?\\s*(?:下面这段|下方这段|以下这段|下面这篇|下面这句|下面|下方|以下|这段|这篇|这句|这句话|这段话|这部分|这些|内容|文本|文案|段落|句子|代码|文章)?\\s*(?:文字|文本|内容|段落|文案|句子|代码|文章)?\\s*(?:翻译一下|译一下|翻译|译)(?:成|为|到)?\\s*(?:${targetPart})?\\s*$`,
    "i",
  );
  const enCommand = new RegExp(
    `^(?:please\\s+)?translate(?:\\s+(?:the\\s+)?(?:following|below|this)\\s*(?:text|paragraph|content|passage|sentence|code|article)?)?(?:\\s+(?:to|into)\\s+${targetPart})?\\s*$`,
    "i",
  );
  return zhCommand.test(command) || enCommand.test(command);
}

function parseColonSource(text: string): QuickTranslationIntent | null {
  const match = text.match(/[：:]/);
  if (!match) return null;
  const idx = match.index ?? -1;
  const command = text.slice(0, idx).trim();
  const sourceText = stripWrappingQuotes(text.slice(idx + 1));
  if (!sourceText || sourceText.length < 2) return null;
  if (!isTranslationCommand(command)) return null;
  return {
    targetLanguage: findTargetInCommand(command) || defaultTargetForCommand(command),
    sourceText,
  };
}

function parseBlockSource(text: string): QuickTranslationIntent | null {
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  const command = lines[0].trim();
  const sourceText = lines.slice(1).join("\n").trim();
  if (!sourceText || sourceText.length < 2) return null;
  if (!isTranslationCommand(command)) return null;
  return {
    targetLanguage: findTargetInCommand(command) || defaultTargetForCommand(command),
    sourceText,
  };
}

function parseInlineSource(text: string): QuickTranslationIntent | null {
  const zhMatch = text.match(new RegExp(
    `^(?:请|帮我|麻烦)?(?:把|将)\\s*([\\s\\S]{2,}?)\\s*(?:翻译|译)(?:成|为|到)\\s*(${TARGET_ALIAS_PATTERN})\\s*$`,
    "i",
  ));
  if (zhMatch) {
    const targetLanguage = normalizeTranslationTarget(zhMatch[2], null);
    const sourceText = stripWrappingQuotes(zhMatch[1]);
    if (targetLanguage && sourceText.length >= 2) return { targetLanguage, sourceText };
  }

  const enMatch = text.match(new RegExp(
    `^translate\\s+([\\s\\S]{2,}?)\\s+(?:to|into)\\s+(${TARGET_ALIAS_PATTERN})\\s*$`,
    "i",
  ));
  if (enMatch) {
    const targetLanguage = normalizeTranslationTarget(enMatch[2], null);
    const sourceText = stripWrappingQuotes(enMatch[1]);
    if (targetLanguage && sourceText.length >= 2) return { targetLanguage, sourceText };
  }

  return null;
}

export function detectQuickTranslationIntent(raw: unknown): QuickTranslationIntent | null {
  const text = normalizeText(raw);
  if (!text || isTranslationMetaQuestion(text)) return null;
  return parseBlockSource(text) || parseColonSource(text) || parseInlineSource(text);
}

export function buildQuickTranslationPrompt(intent: Partial<QuickTranslationIntent> | null | undefined): string {
  const sourceText = normalizeText(intent?.sourceText);
  return sourceText;
}
