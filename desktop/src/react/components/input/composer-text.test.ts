import { describe, expect, it } from 'vitest';
import { computeComposerTextUpdate } from './composer-text';

describe('composer text updates', () => {
  it('inserts text at the current selection', () => {
    expect(computeComposerTextUpdate({
      current: 'hello world',
      incoming: 'Lynn',
      selectionStart: 6,
      selectionEnd: 11,
    })).toEqual({
      next: 'hello Lynn',
      caretStart: 10,
      caretEnd: 10,
    });
  });

  it('adds spacing when appending quoted text to an existing draft', () => {
    expect(computeComposerTextUpdate({
      current: 'draft',
      incoming: 'quoted',
      selectionStart: 5,
      selectionEnd: 5,
      appendSpacer: true,
    })).toEqual({
      next: 'draft\n\nquoted',
      caretStart: 13,
      caretEnd: 13,
    });
  });

  it('replaces the draft for edit-and-resend', () => {
    expect(computeComposerTextUpdate({
      current: 'unsent draft',
      incoming: 'previous user message',
      mode: 'replace',
    })).toEqual({
      next: 'previous user message',
      caretStart: 21,
      caretEnd: 21,
    });
  });
});
