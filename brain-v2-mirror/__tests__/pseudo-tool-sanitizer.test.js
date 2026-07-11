import { describe, expect, it } from 'vitest';
import {
  createPseudoToolSanitizerState,
  flushPseudoToolSanitizer,
  sanitizePseudoToolDelta,
} from '../pseudo-tool-sanitizer.js';

describe('Brain pseudo-tool stream sanitizer', () => {
  it('suppresses a pseudo-tool block split across provider chunks', () => {
    const state = createPseudoToolSanitizerState();
    expect(sanitizePseudoToolDelta(state, '<tool_')).toBe('');
    expect(sanitizePseudoToolDelta(state, 'call>{"name":"read_file"}</tool_call>最终回答')).toBe('最终回答');
    expect(flushPseudoToolSanitizer(state)).toBe('');
    expect(state.suppressed).toBe(true);
  });

  it('preserves ordinary code and comparison text', () => {
    const state = createPseudoToolSanitizerState();
    const source = 'Use <Component value={x} /> when a < b.';
    expect(sanitizePseudoToolDelta(state, source)).toBe(source);
    expect(flushPseudoToolSanitizer(state)).toBe('');
  });

  it('drops an unclosed oversized pseudo-tool payload instead of leaking its tail', () => {
    const state = createPseudoToolSanitizerState();
    expect(sanitizePseudoToolDelta(state, `<tool_call>${'x'.repeat(40_000)}`)).toBe('');
    expect(state.carry).toBe('');
    expect(state.suppressed).toBe(true);
  });
});
