import { describe, expect, it } from 'vitest';
import { detectInlineFileSuggestion } from './file-context-suggestions';

describe('file context suggestions', () => {
  it('detects code and document paths that should offer @ mention', () => {
    expect(detectInlineFileSuggestion('看一下 desktop/src/App.tsx')).toBe('desktop/src/App.tsx');
    expect(detectInlineFileSuggestion('review docs/release-notes.md 吧')).toBe('docs/release-notes.md');
  });

  it('ignores text without supported file references', () => {
    expect(detectInlineFileSuggestion('普通聊天，没有文件名')).toBeNull();
    expect(detectInlineFileSuggestion('image.png')).toBeNull();
  });
});
