import {
  containsPseudoToolSimulation,
  findUnresolvedPseudoToolOpen,
  stripPseudoToolCallMarkup,
} from "../../shared/pseudo-tool-call.js";

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
  const cut = Math.max(tagStart, pipeStart);
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
  const incoming = String(chunk || "");
  const carry = readCarry(ss);

  // Fast path: no carry, no detectable pseudo marker anywhere, and no unresolved pseudo-tool
  // opener → emit as-is at zero extra latency. This is the common case for ordinary assistant
  // text (including legitimate <details>/JSX/TS generics, which the registry does not match).
  if (
    !carry &&
    incoming &&
    !containsPseudoToolSimulation(incoming) &&
    findUnresolvedPseudoToolOpen(incoming) === -1 &&
    findUnclosedPipeNumStart(incoming) === -1
  ) {
    return { text: incoming, suppressed: false };
  }

  const combined = carry + incoming;
  const { emit: toProcess, carry: toCarry } = splitAtUnresolvedOpener(combined);

  let emitText = toProcess;
  let suppressed = false;
  if (toProcess && containsPseudoToolSimulation(toProcess)) {
    const stripped = stripPseudoToolCallMarkup(toProcess);
    suppressed = stripped !== toProcess;
    emitText = stripped;
  }

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
  const carry = readCarry(ss);
  writeCarry(ss, "");
  if (!carry) return { text: "", suppressed: false };

  // First: did the carry's opener ever get its closer? Check the ORIGINAL carry (before any
  // strip), because stripPseudoToolCallMarkup only removes the opener tag "<tool_call>" and
  // leaves the inner "{\"name\":...}" behind — that residue is exactly what we must withhold.
  const hasUnresolvedOpener =
    findUnresolvedPseudoToolOpen(carry) !== -1 || findUnclosedPipeNumStart(carry) !== -1;

  if (hasUnresolvedOpener) {
    // The block never closed. Withhold the whole carry so neither the raw tag nor its inner
    // content leaks to the client. (We do NOT try to salvage prose that may have followed the
    // opener, because by construction the carry starts at the opener — see splitAtUnresolvedOpener.)
    return { text: "", suppressed: true };
  }

  // No unresolved opener → the carry is closed/ordinary text. Run the normal strip in case it
  // contains a now-complete block, then emit whatever survives.
  const stripped = containsPseudoToolSimulation(carry) ? stripPseudoToolCallMarkup(carry) : carry;
  if (!stripped.trim()) {
    return { text: "", suppressed: true };
  }
  return { text: stripped, suppressed: stripped !== carry };
}

export function containsNonProgressPseudoToolSimulation(raw: unknown): boolean {
  return containsPseudoToolSimulation(raw);
}
