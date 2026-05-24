// 2026-05-24 regression test for the GPQA/MMLU runner answer-extraction bug.
//
// The Python runners under /home/merkyor/quality-eval-20260517/scripts/ (Spark side)
// used to:
//   * embed `/no_think` in the system prompt while ALSO setting
//     chat_template_kwargs.enable_thinking=true → conflict, model thinks for 32K
//     tokens and the answer letter never appears in the first 48 chars of output.
//   * `parse_answer` only inspected `text[:48]` → returned None for thinking-on
//     transcripts even when the final answer "Final Answer: C" was correct.
//
// We can't run the Python runners from JS test, but we can encode the *contract*:
// any answer extractor we ship MUST handle thinking-on transcripts where the final
// letter appears at the end / inside a "Final Answer: X" marker.
//
// This file ports the *fixed* parse_answer logic to JS and asserts the contract on
// a corpus of representative model outputs. Future contributors changing extractor
// logic should add fixtures here before re-running the Spark eval chain.

import { describe, it, expect } from 'vitest';

const LETTERS = ['A', 'B', 'C', 'D'];
const ANS_RE = /\b([ABCD])\b/;

function parseAnswer(text) {
  if (!text) return null;
  if (text.includes('</think>')) text = text.split('</think>', 2)[1];
  const t = (text || '').trim();
  if (!t) return null;
  // 1) Explicit final-answer patterns (highest confidence). All MUST be /g for matchAll.
  const patterns = [
    /(?:Final\s+Answer|FINAL\s+ANSWER|Answer|answer)\s*[:：]\s*\(?([ABCD])\)?/g,
    /\\boxed\s*\{\s*([ABCD])\s*\}/g,
    /(?:正确答案|最终答案|答案)\s*[:：是]\s*\(?([ABCD])\)?/g,
    /\*\*\s*([ABCD])\s*\*\*\s*$/gm,
    // Standalone letter on its OWN line (not inside parens / quote / markdown).
    /(?:^|\n)\s*([ABCD])\s*$/gm,
  ];
  for (const re of patterns) {
    const matches = [...t.matchAll(re)];
    if (matches.length) return matches[matches.length - 1][1];
  }
  // Single-letter input (no-think mode answers like just "A").
  if (t.length <= 2 && LETTERS.includes(t[0])) return t[0];
  return null;
}

describe('runner answer parser — must survive thinking-on outputs', () => {
  it('extracts a clean single-letter answer (no-think mode)', () => {
    expect(parseAnswer('C')).toBe('C');
  });

  it('handles the legacy "Final Answer: X" tail format', () => {
    const raw = `The user asks for the bandwidth ...

Step 1: compute h/Δt for each option ...
Step 2: only option C exceeds the natural linewidth ...

Final Answer: C`;
    expect(parseAnswer(raw)).toBe('C');
  });

  it('handles \\boxed{D} math formatting', () => {
    const raw = 'After computing the integral ...\n\nThe final answer is \\boxed{D}.';
    expect(parseAnswer(raw)).toBe('D');
  });

  it('handles Chinese 答案: 格式', () => {
    const raw = '题目分析:\n1. ...\n2. ...\n答案: B';
    expect(parseAnswer(raw)).toBe('B');
  });

  it('strips </think> tag', () => {
    const raw = '<think>long reasoning here that mentions A B C D randomly</think>\n\nFinal Answer: A';
    expect(parseAnswer(raw)).toBe('A');
  });

  it('returns null when truly no answer present (the bogus bug case)', () => {
    const raw = "The user wants me to identify the correct reagent (A) and the product (B) for a";
    // This case used to false-positive on "(A)" early in the prompt because the
    // old parser scanned text[:48] and matched the parenthesised A. After the
    // fix, no Final Answer pattern + no trailing standalone letter → null.
    expect(parseAnswer(raw)).toBe(null);
  });

  it('does not match parenthesised letters inside reasoning preamble (regression for original 0% GPQA bug)', () => {
    // First 48 chars contain "(A)" — old parser would return 'A'. New parser
    // requires the answer near the END, so this returns null (correct: model
    // never finished the question).
    const raw = 'The user wants me to identify the correct reagent (A) and the product (B) for a multi-step organic synthesis problem. They have provided four possible reagent combinations and four possible products. Their goal is to find the matching pair.';
    expect(parseAnswer(raw)).toBe(null);
  });

  it('handles markdown emphasis answer "**C**" at end', () => {
    const raw = "After analysis I conclude the answer is **C**";
    expect(parseAnswer(raw)).toBe('C');
  });

  it('takes the LAST occurrence when model emits multiple "Answer: X" lines', () => {
    const raw = "I first thought Answer: A, but reconsidering, Answer: B. Actually let me try again. Final Answer: D";
    expect(parseAnswer(raw)).toBe('D');
  });
});
