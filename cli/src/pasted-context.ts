import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mediaKindFor } from "./media.js";
import { currentLang, t, type Lang } from "./i18n.js";

const MEDIA_EXT = "png|jpe?g|webp|gif|mp3|wav|m4a|aac|ogg|flac|mp4|mov|avi|wmv|webm|mkv";
const IMAGE_PATH_RE = new RegExp(`(?:file://)?(?:"([^"]+\\.(?:${MEDIA_EXT}))"|'([^']+\\.(?:${MEDIA_EXT}))'|(\\S+\\.(?:${MEDIA_EXT})))`, "gi");

export interface PastedImageRef {
  raw: string;
  path: string;
}

export interface PastedContextInfo {
  text: string;
  imageRefs: PastedImageRef[];
  lineCount: number;
  segmentCount: number;
  charCount: number;
  hasMultilineText: boolean;
  hasContext: boolean;
}

export interface ImagePromptCommand {
  command: "/image" | "/images" | "/attach";
  prompt: string;
  imageRefs: PastedImageRef[];
}

export function normalizePastedText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function appendPastedText(current: string, pasted: string): string {
  const next = normalizePastedText(pasted);
  if (!current) return next;
  if (current.endsWith("\n") || next.startsWith("\n")) return `${current}${next}`;
  return `${current}\n${next}`;
}

export function analyzePastedContext(value: string, cwd = process.cwd()): PastedContextInfo {
  const normalized = normalizePastedText(value);
  const imageRefs: PastedImageRef[] = [];
  // Drag-and-drop often pastes a bare path with spaces ("Screen Shot.png"),
  // which the token regex below cannot see. Accept a whole line or a trailing
  // absolute path when the file actually exists.
  const lines = normalized.split("\n").map((line) => {
    const extracted = extractInlineMedia(line, cwd);
    for (const ref of extracted.paths) imageRefs.push(ref);
    return extracted.text;
  });
  let text = lines.join("\n").replace(IMAGE_PATH_RE, (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
    const raw = doubleQuoted || singleQuoted || bare || match;
    const cleaned = cleanImagePath(raw);
    imageRefs.push({ raw, path: path.resolve(cwd, cleaned) });
    return " ";
  });
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const nonEmptyLines = text ? text.split(/\n/).filter((line) => line.trim()).length : 0;
  const segmentCount = text ? text.split(/\n{2,}/).filter((segment) => segment.trim()).length : 0;
  return {
    text,
    imageRefs,
    lineCount: nonEmptyLines,
    segmentCount,
    charCount: Array.from(text).length,
    hasMultilineText: nonEmptyLines > 1 || segmentCount > 1,
    hasContext: imageRefs.length > 0 || nonEmptyLines > 1 || segmentCount > 1,
  };
}

export function summarizePastedContext(info: PastedContextInfo): string {
  return summarizeContextParts({
    imageCount: info.imageRefs.length,
    imageNames: info.imageRefs.map((ref) => path.basename(ref.path)),
    hasMultilineText: info.hasMultilineText,
    lineCount: info.lineCount,
    segmentCount: info.segmentCount,
    charCount: info.charCount,
    lang: currentLang(),
  });
}

export function summarizeImageRefs(imageRefs: readonly PastedImageRef[], lang: Lang = currentLang()): string {
  return summarizeContextParts({
    imageCount: imageRefs.length,
    imageNames: imageRefs.map((ref) => path.basename(ref.path)),
    hasMultilineText: false,
    lineCount: 0,
    segmentCount: 0,
    charCount: 0,
    lang,
  });
}

export function parseImagePromptCommand(value: string, cwd = process.cwd()): ImagePromptCommand | null {
  const normalized = normalizePastedText(value).trim();
  const match = normalized.match(/^\/(image|images|attach)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const command = `/${match[1].toLowerCase()}` as ImagePromptCommand["command"];
  const info = analyzePastedContext(match[2] || "", cwd);
  return {
    command,
    prompt: info.text || t("chat.image.defaultPrompt"),
    imageRefs: info.imageRefs,
  };
}

function summarizeContextParts(options: {
  imageCount: number;
  imageNames: readonly string[];
  hasMultilineText: boolean;
  lineCount: number;
  segmentCount: number;
  charCount: number;
  lang: Lang;
}): string {
  const parts: string[] = [];
  if (options.imageCount) {
    const label = options.lang === "zh"
      ? `${options.imageCount} 个附件`
      : `${options.imageCount} attachment${options.imageCount === 1 ? "" : "s"}`;
    const names = options.imageNames.slice(0, 3).join(", ");
    const extra = options.imageNames.length > 3
      ? (options.lang === "zh" ? ` 等 ${options.imageNames.length} 个文件` : ` +${options.imageNames.length - 3}`)
      : "";
    parts.push(names ? `${label}: ${names}${extra}` : label);
  }
  if (options.hasMultilineText) {
    parts.push(options.lang === "zh" ? `${options.lineCount} 行` : `${options.lineCount} lines`);
    if (options.segmentCount > 1) {
      parts.push(options.lang === "zh" ? `${options.segmentCount} 段` : `${options.segmentCount} segments`);
    }
  }
  if (!parts.length && options.charCount > 0) {
    parts.push(options.lang === "zh" ? `${options.charCount} 字符` : `${options.charCount} chars`);
  }
  return parts.join(" · ");
}


/**
 * Pull a media path out of one line. Handles the three shapes drag-and-drop
 * produces: the path alone, a path with spaces followed by a prompt, and a
 * prompt followed by a path with spaces. Existence is checked so a sentence
 * containing "screenshot.png" is not mistaken for an attachment.
 */
function extractInlineMedia(line: string, cwd: string): { paths: PastedImageRef[]; text: string } {
  const direct = stripQuotes(line.trim());
  if (direct && isExistingMedia(direct, cwd)) {
    return { paths: [{ raw: line.trim(), path: resolveMediaPath(direct, cwd) }], text: "" };
  }
  const extension = new RegExp(`\\.(?:${MEDIA_EXT})\\b`, "gi");
  let match: RegExpExecArray | null;
  while ((match = extension.exec(line))) {
    const end = match.index + match[0].length;
    const starts = new Set<number>([0]);
    for (let index = 0; index < end; index += 1) {
      const char = line[index];
      if (char === '"' || char === "'") starts.add(index + 1);
      else if (char === "/") starts.add(index);
      else if ((index === 0 || /\s/.test(line[index - 1] || ""))
        && (/^[A-Za-z]:[\\/]/.test(line.slice(index)) || line.slice(index, index + 2) === "\\\\")) starts.add(index);
    }
    for (const start of [...starts].sort((a, b) => a - b)) {
      const candidate = stripQuotes(line.slice(start, end).trim());
      if (!candidate || !isExistingMedia(candidate, cwd)) continue;
      const prefix = line.slice(0, start).replace(/["']+\s*$/, "").trim();
      const rest = line.slice(end).replace(/^['"\s]+/, "").trim();
      return {
        paths: [{ raw: candidate, path: resolveMediaPath(candidate, cwd) }],
        text: [prefix, rest].filter(Boolean).join(" ").trim(),
      };
    }
  }
  return { paths: [], text: line };
}

function cleanImagePath(value: string): string {
  const withoutFileScheme = value.startsWith("file://") ? value.slice("file://".length) : value;
  const expanded = withoutFileScheme.startsWith("~/") ? path.join(os.homedir(), withoutFileScheme.slice(2)) : withoutFileScheme;
  try {
    return decodeURIComponent(expanded).replace(/\\ /g, " ");
  } catch {
    return expanded.replace(/\\ /g, " ");
  }
}

function stripQuotes(value: string): string {
  const match = value.match(/^"(.*)"$/) || value.match(/^'(.*)'$/);
  return match?.[1] ?? value;
}

function resolveMediaPath(value: string, cwd: string): string {
  return path.resolve(cwd, cleanImagePath(value));
}

function isExistingMedia(value: string, cwd: string): boolean {
  const cleaned = cleanImagePath(value);
  if (!mediaKindFor(cleaned)) return false;
  try {
    return fs.existsSync(path.resolve(cwd, cleaned));
  } catch {
    return false;
  }
}
