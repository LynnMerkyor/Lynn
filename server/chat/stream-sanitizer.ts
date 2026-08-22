import {
  containsPseudoToolSimulation,
  findUnresolvedPseudoToolOpen,
  stripPseudoToolCallMarkup,
} from "../../shared/pseudo-tool-call.js";
import {
  couldStartInternalTaskNarration,
  stripLeadingInternalTaskNarration,
} from "../../shared/assistant-visible-text.js";

export interface StreamSanitizerResult {
  text: string;
  suppressed: boolean;
}

// Cross-chunk carry buffer state. Attached to the live stream state (`ss`) so the sanitizer
// persists across deltas within a turn. The carry holds text from the last unresolved "<" or
// "||N" marker onward — i.e. the opening half of a pseudo-tool block (e.g. "<tool_" waiting for
// "call>...</tool_call>") — so that a split "<tool_" + "call>…" does not leak through to clients
// as ordinary text. Call flushStreamingPseudoToolBlocks(ss) at turn end to drain the carry.
const SANITIZER_CARRY_KEY = "sanitizerCarry";

// Cap so a pathological model output can't accumulate unbounded state. The longest pseudo-tool
// tag name + attrs is well under 100 chars; 512 is a generous ceiling that still lets a stray
// run-on fragment flush instead of holding forever.
const SANITIZER_CARRY_MAX = 512;
const LEADING_NARRATION_BUFFER_KEY = "leadingNarrationBuffer";
const LEADING_NARRATION_RESOLVED_KEY = "leadingNarrationResolved";
const LEADING_NARRATION_BUFFER_MAX = 512;
const INTERNAL_REASONING_TAG_KEY = "internalReasoningTag";
const INTERNAL_REASONING_TAIL_KEY = "internalReasoningTail";
const INTERNAL_REASONING_TAG_NAMES = ["reflect", "analysis", "thinking", "reasoning", "thought"] as const;
const INTERNAL_REASONING_OPEN_RE = /<(reflect|analysis|thinking|reasoning|thought)\s*>/giu;
const VISIBLE_STRUCTURAL_TAG_NAMES = [
  "plan", "steps", "answer", "final", "response", "solution", "outline", "template",
  "position", "cancellation", "reviews", "worldbuilding", "phase", "daily_structure",
  "item", "milestone", "rules", "rule",
] as const;
const VISIBLE_STRUCTURAL_TAG_RE = /<\/?(?:plan|steps|answer|final|response|solution|outline|template|position|cancellation|reviews|worldbuilding|phase|daily_structure|item|milestone|rules|rule)\b[^>]*>/giu;
const VISIBLE_STRUCTURAL_LABEL_RE = /(^|\n)\s*<[^<>\n]*(?:方案|计划|流程|步骤|回答|思路|分析|总结|大纲|设定|章节规划|框架|plan|steps|answer|final|response|solution|outline|template)[^<>\n]*>\s*/giu;
const VISIBLE_SNAKE_STRUCTURAL_TAG_RE = /<\/?[a-z][a-z0-9_-]*_(?:checklist|plan|steps|template|outline|summary|answer|flow|process|list)[a-z0-9_-]*>/giu;
const VISIBLE_CHINESE_STRUCTURAL_TERMS = [
  "方案", "计划", "流程", "步骤", "回答", "思路", "分析", "总结", "大纲", "设定", "章节规划", "框架",
] as const;

function readCarry(ss: unknown): string {
  if (ss && typeof ss === "object" && SANITIZER_CARRY_KEY in ss) {
    const value = (ss as Record<string, unknown>)[SANITIZER_CARRY_KEY];
    return typeof value === "string" ? value : "";
  }
  return "";
}

function writeCarry(ss: unknown, value: string): void {
  if (ss && typeof ss === "object") {
    (ss as Record<string, unknown>)[SANITIZER_CARRY_KEY] = value;
  }
}

function readLeadingNarrationState(ss: unknown): { buffer: string; resolved: boolean } {
  if (!ss || typeof ss !== "object") return { buffer: "", resolved: false };
  const state = ss as Record<string, unknown>;
  return {
    buffer: typeof state[LEADING_NARRATION_BUFFER_KEY] === "string"
      ? String(state[LEADING_NARRATION_BUFFER_KEY])
      : "",
    resolved: state[LEADING_NARRATION_RESOLVED_KEY] === true,
  };
}

function writeLeadingNarrationState(ss: unknown, buffer: string, resolved: boolean): void {
  if (!ss || typeof ss !== "object") return;
  const state = ss as Record<string, unknown>;
  state[LEADING_NARRATION_BUFFER_KEY] = buffer;
  state[LEADING_NARRATION_RESOLVED_KEY] = resolved;
}

function resolveLeadingNarrationChunk(ss: unknown, incoming: string): StreamSanitizerResult | null {
  const state = readLeadingNarrationState(ss);
  if (state.resolved) return null;
  const combined = state.buffer + incoming;
  if (!couldStartInternalTaskNarration(combined)) {
    writeLeadingNarrationState(ss, "", true);
    return { text: combined, suppressed: false };
  }

  const stripped = stripLeadingInternalTaskNarration(combined);
  if (stripped !== combined) {
    writeLeadingNarrationState(ss, "", true);
    return { text: stripped, suppressed: true };
  }

  const sentenceCount = (combined.match(/[。！？!?]/gu) || []).length;
  if (sentenceCount >= 2 || combined.length >= LEADING_NARRATION_BUFFER_MAX) {
    writeLeadingNarrationState(ss, "", true);
    return { text: combined, suppressed: false };
  }
  writeLeadingNarrationState(ss, combined, false);
  return { text: "", suppressed: false };
}

function readInternalReasoningState(ss: unknown): { tag: string; tail: string } {
  if (!ss || typeof ss !== "object") return { tag: "", tail: "" };
  const state = ss as Record<string, unknown>;
  return {
    tag: typeof state[INTERNAL_REASONING_TAG_KEY] === "string" ? String(state[INTERNAL_REASONING_TAG_KEY]) : "",
    tail: typeof state[INTERNAL_REASONING_TAIL_KEY] === "string" ? String(state[INTERNAL_REASONING_TAIL_KEY]) : "",
  };
}

function writeInternalReasoningState(ss: unknown, tag: string, tail: string): void {
  if (!ss || typeof ss !== "object") return;
  const state = ss as Record<string, unknown>;
  state[INTERNAL_REASONING_TAG_KEY] = tag;
  state[INTERNAL_REASONING_TAIL_KEY] = tail;
}

function closingTagPattern(tag: string): RegExp {
  return new RegExp(`<\\/\\s*${tag}\\s*>`, "iu");
}

function retainClosingTagTail(text: string, tag: string): string {
  return text.slice(-Math.max(0, `</${tag}>`.length - 1));
}

function stripInternalReasoningBlocks(ss: unknown, raw: string): StreamSanitizerResult {
  let source = raw;
  let visible = "";
  let suppressed = false;
  const active = readInternalReasoningState(ss);

  if (active.tag) {
    const combined = active.tail + source;
    const close = closingTagPattern(active.tag);
    const match = close.exec(combined);
    if (!match) {
      writeInternalReasoningState(ss, active.tag, retainClosingTagTail(combined, active.tag));
      return { text: "", suppressed: Boolean(combined) };
    }
    source = combined.slice((match.index || 0) + match[0].length);
    writeInternalReasoningState(ss, "", "");
    suppressed = true;
  }

  while (source) {
    INTERNAL_REASONING_OPEN_RE.lastIndex = 0;
    const open = INTERNAL_REASONING_OPEN_RE.exec(source);
    if (!open) {
      visible += source;
      break;
    }
    visible += source.slice(0, open.index);
    const tag = String(open[1] || "").toLowerCase();
    const afterOpen = source.slice(open.index + open[0].length);
    const close = closingTagPattern(tag);
    const closeMatch = close.exec(afterOpen);
    suppressed = true;
    if (!closeMatch) {
      writeInternalReasoningState(ss, tag, retainClosingTagTail(afterOpen, tag));
      break;
    }
    source = afterOpen.slice((closeMatch.index || 0) + closeMatch[0].length);
  }

  return { text: visible, suppressed };
}

// `||<digits>` possibly with trailing space — the opening of a `||N tool_name|| {...}` block.
// Find the last one that hasn't been followed by a closing `}`.
const PIPE_NUM_OPEN_RE = /\|\|\d+\s*/g;

function findUnclosedPipeNumStart(text: string): number {
  let lastUnclosed = -1;
  PIPE_NUM_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PIPE_NUM_OPEN_RE.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    // A pipe-numbered block closes with `}`. If there's no `}` after this opener, it's unclosed.
    if (!after.includes("}")) {
      lastUnclosed = m.index;
    }
  }
  return lastUnclosed;
}

function findUnresolvedVisibleStructuralTagStart(text: string): number {
  const start = text.lastIndexOf("<");
  if (start < 0) return -1;
  const tail = text.slice(start);
  if (tail.includes(">")) return -1;
  const lower = tail.toLowerCase();
  const knownEnglishTag = [...VISIBLE_STRUCTURAL_TAG_NAMES, ...INTERNAL_REASONING_TAG_NAMES]
    .some((name) => `<${name}`.startsWith(lower) || `</${name}`.startsWith(lower))
    || /^<\/?[a-z][a-z0-9_-]*$/iu.test(tail) && tail.includes("_");
  if (knownEnglishTag) return start;

  // Models also emit Chinese planning wrappers such as <大纲>...</大纲>.
  // Hold a split opener/closer only when the unfinished label already contains
  // one of the explicit structural terms, or its final characters are a prefix
  // of one. Ordinary HTML, JSX and comparison text continue to stream normally.
  const label = tail.replace(/^<\/?\s*/u, "");
  const potentialChineseLabel = VISIBLE_CHINESE_STRUCTURAL_TERMS.some((term) => {
    if (label.includes(term)) return true;
    for (let length = 1; length < term.length; length += 1) {
      if (label.endsWith(term.slice(0, length))) return true;
    }
    return false;
  });
  return potentialChineseLabel ? start : -1;
}

function stripVisibleStructuralTags(text: string): string {
  if (!text) return text;
  const hasTag = VISIBLE_STRUCTURAL_TAG_RE.test(text);
  VISIBLE_STRUCTURAL_TAG_RE.lastIndex = 0;
  const hasLabel = VISIBLE_STRUCTURAL_LABEL_RE.test(text);
  VISIBLE_STRUCTURAL_LABEL_RE.lastIndex = 0;
  const hasSnakeTag = VISIBLE_SNAKE_STRUCTURAL_TAG_RE.test(text);
  VISIBLE_SNAKE_STRUCTURAL_TAG_RE.lastIndex = 0;
  if (!hasTag && !hasLabel && !hasSnakeTag) return text;
  VISIBLE_STRUCTURAL_TAG_RE.lastIndex = 0;
  VISIBLE_STRUCTURAL_LABEL_RE.lastIndex = 0;
  VISIBLE_SNAKE_STRUCTURAL_TAG_RE.lastIndex = 0;
  return text
    .replace(VISIBLE_STRUCTURAL_TAG_RE, (tag) => formatVisibleStructuralTag(tag))
    .replace(VISIBLE_SNAKE_STRUCTURAL_TAG_RE, "")
    .replace(VISIBLE_STRUCTURAL_LABEL_RE, "$1");
}

function structuralTagAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu"));
  return String(match?.[2] || "").trim();
}

function formatVisibleStructuralTag(tag: string): string {
  const closing = /^<\//u.test(tag);
  const name = tag.match(/^<\/?\s*([a-z][a-z0-9_-]*)/iu)?.[1]?.toLowerCase() || "";
  if (!name || closing) return "";
  if (name === "phase") {
    const label = structuralTagAttribute(tag, "name") || "阶段";
    const days = structuralTagAttribute(tag, "days");
    const goal = structuralTagAttribute(tag, "goal");
    const dayLabel = days ? `（第 ${days.replace(/-/g, "–")} 天）` : "";
    const goalLine = goal ? `\n\n**目标：** ${goal}` : "";
    return `\n\n## ${label}${dayLabel}${goalLine}\n`;
  }
  if (name === "daily_structure") {
    const minutes = structuralTagAttribute(tag, "minutes");
    return `\n\n### 每日${minutes ? ` ${minutes} 分钟` : "安排"}\n`;
  }
  if (name === "item") {
    const minutes = structuralTagAttribute(tag, "minutes");
    return `\n- ${minutes ? `**${minutes} 分钟**：` : ""}`;
  }
  if (name === "milestone") return "\n\n**阶段目标：** ";
  if (name === "rules") return "\n\n## 执行规则\n";
  if (name === "rule") return "\n- ";
  return "";
}

/**
 * Split `combined` into [emitNow, carryForward] at the last unresolved pseudo-tool opener.
 *
 * IMPORTANT: only openers that match the pseudo-tool tag registry in shared/pseudo-tool-call.ts
 * (tool*, execute, read*, invoke, function, parameter, command, query, template tags like
 * tool_call/search_result, …) count. Ordinary markup — <details>, <Component prop={x}>,
 * TypeScript <T> generics, "a < b" — is NOT matched and is never withheld, so it flows straight
 * through to the client. The pipe-numbered `||N` opener is handled separately below.
 */
function splitAtUnresolvedOpener(combined: string): { emit: string; carry: string } {
  const tagStart = findUnresolvedPseudoToolOpen(combined);
  const pipeStart = findUnclosedPipeNumStart(combined);
  const structuralTagStart = findUnresolvedVisibleStructuralTagStart(combined);
  const cut = Math.max(tagStart, pipeStart, structuralTagStart);
  if (cut <= 0) {
    // cut === 0 means the buffer STARTS with an opener — carry everything.
    // cut === -1 means no opener — carry nothing.
    if (cut === -1) return { emit: combined, carry: "" };
    return { emit: "", carry: combined };
  }
  return { emit: combined.slice(0, cut), carry: combined.slice(cut) };
}

/**
 * Streaming pseudo-tool sanitizer with a cross-chunk carry buffer.
 *
 * Call once per text delta. The returned `text` is safe to broadcast to clients; any trailing
 * fragment that might be the opening of a pseudo-tool block is retained on `ss` and resolved
 * against the next delta. Call `flushStreamingPseudoToolBlocks(ss)` at turn end to drain the
 * carry.
 *
 * Algorithm: prepend the previous carry, then find the last "<" or "||N" that opens a tag
 * candidate but is never closed within the combined buffer. Everything before that point has no
 * dangling opener and is safe to strip+emit; from that point onward is withheld (it may pair
 * with the next delta to form a complete block).
 */
export function stripStreamingPseudoToolBlocks(
  ss: unknown,
  chunk: unknown,
): StreamSanitizerResult {
  let incoming = String(chunk || "");
  const leading = resolveLeadingNarrationChunk(ss, incoming);
  if (leading) {
    if (!leading.text) return leading;
    incoming = leading.text;
  }
  const carry = readCarry(ss);
  const hasInternalOpen = INTERNAL_REASONING_OPEN_RE.test(incoming);
  INTERNAL_REASONING_OPEN_RE.lastIndex = 0;

  // Fast path: no carry, no detectable pseudo marker anywhere, and no unresolved pseudo-tool
  // opener → emit as-is at zero extra latency. This is the common case for ordinary assistant
  // text (including legitimate <details>/JSX/TS generics, which the registry does not match).
  if (
    !carry &&
    incoming &&
    !containsPseudoToolSimulation(incoming) &&
    !VISIBLE_STRUCTURAL_TAG_RE.test(incoming) &&
    !VISIBLE_STRUCTURAL_LABEL_RE.test(incoming) &&
    !VISIBLE_SNAKE_STRUCTURAL_TAG_RE.test(incoming) &&
    !hasInternalOpen &&
    !readInternalReasoningState(ss).tag &&
    findUnresolvedPseudoToolOpen(incoming) === -1 &&
    findUnclosedPipeNumStart(incoming) === -1 &&
    findUnresolvedVisibleStructuralTagStart(incoming) === -1
  ) {
    return { text: incoming, suppressed: leading?.suppressed || false };
  }
  VISIBLE_STRUCTURAL_TAG_RE.lastIndex = 0;
  VISIBLE_STRUCTURAL_LABEL_RE.lastIndex = 0;
  VISIBLE_SNAKE_STRUCTURAL_TAG_RE.lastIndex = 0;

  const combined = carry + incoming;
  const internal = stripInternalReasoningBlocks(ss, combined);
  const { emit: toProcess, carry: toCarry } = splitAtUnresolvedOpener(internal.text);

  let emitText = toProcess;
  let suppressed = internal.suppressed || leading?.suppressed || false;
  if (toProcess && containsPseudoToolSimulation(toProcess)) {
    const stripped = stripPseudoToolCallMarkup(toProcess);
    suppressed = suppressed || stripped !== toProcess;
    emitText = stripped;
  }
  const visibleStripped = stripVisibleStructuralTags(emitText);
  suppressed = suppressed || visibleStripped !== emitText;
  emitText = visibleStripped;

  let nextCarry = toCarry;
  // Hard cap: never let carry grow without bound under adversarial input. Keep the tail, which
  // is the most likely to pair with the next delta.
  if (nextCarry.length > SANITIZER_CARRY_MAX) {
    nextCarry = nextCarry.slice(-SANITIZER_CARRY_MAX);
  }
  writeCarry(ss, nextCarry);
  return { text: emitText, suppressed };
}

/**
 * Drain the carry buffer at turn end (or stream close). Returns whatever is safe to emit:
 * if the residual can be stripped to nothing (it finally formed a complete block) it is dropped;
 * if the ORIGINAL carry still has an unresolved pseudo-tool opener it is withheld (we check the
 * pre-strip text because strip only removes the opener tag itself, leaving the block's inner
 * args/JSON behind — those must not leak); otherwise it's ordinary trailing prose and emitted.
 * Call exactly once per turn end after the final delta.
 */
export function flushStreamingPseudoToolBlocks(ss: unknown): StreamSanitizerResult {
  const leading = readLeadingNarrationState(ss);
  writeLeadingNarrationState(ss, "", false);
  const leadingText = leading.resolved ? "" : stripLeadingInternalTaskNarration(leading.buffer);
  const leadingSuppressed = leadingText !== leading.buffer;
  const carry = leadingText + readCarry(ss);
  const internal = readInternalReasoningState(ss);
  writeCarry(ss, "");
  writeInternalReasoningState(ss, "", "");
  if (!carry) return { text: "", suppressed: Boolean(internal.tag) || leadingSuppressed };

  // First: did the carry's opener ever get its closer? Check the ORIGINAL carry (before any
  // strip), because stripPseudoToolCallMarkup only removes the opener tag "<tool_call>" and
  // leaves the inner "{\"name\":...}" behind — that residue is exactly what we must withhold.
  const hasUnresolvedOpener =
    findUnresolvedPseudoToolOpen(carry) !== -1
    || findUnclosedPipeNumStart(carry) !== -1
    || findUnresolvedVisibleStructuralTagStart(carry) !== -1;

  if (hasUnresolvedOpener) {
    // The block never closed. Withhold the whole carry so neither the raw tag nor its inner
    // content leaks to the client. (We do NOT try to salvage prose that may have followed the
    // opener, because by construction the carry starts at the opener — see splitAtUnresolvedOpener.)
    return { text: "", suppressed: true };
  }

  // No unresolved opener → the carry is closed/ordinary text. Run the normal strip in case it
  // contains a now-complete block, then emit whatever survives.
  const strippedPseudo = containsPseudoToolSimulation(carry) ? stripPseudoToolCallMarkup(carry) : carry;
  const stripped = stripVisibleStructuralTags(strippedPseudo);
  if (!stripped.trim()) {
    return { text: "", suppressed: true };
  }
  return { text: stripped, suppressed: stripped !== carry || leadingSuppressed };
}

export function containsNonProgressPseudoToolSimulation(raw: unknown): boolean {
  return containsPseudoToolSimulation(raw);
}
