import { describe, expect, it } from 'vitest';
import { formatVisualBox, groupVisualFiles, visualBoxStyle, visualImageSrc } from '../visual-format';

describe('formatVisualBox', () => {
  it('formats a normalized box: label, position, size, confidence as percents', () => {
    expect(
      formatVisualBox({ label: 'Submit', x: 0.42, y: 0.18, width: 0.3, height: 0.1, confidence: 0.87 }, 0),
    ).toBe('Submit @ 42%,18% · 30%×10% · 87% conf');
  });

  it('falls back to "box N" and omits optional size / confidence', () => {
    expect(formatVisualBox({ x: 0.5, y: 0.5 }, 2)).toBe('box 3 @ 50%,50%');
  });
});

describe('groupVisualFiles', () => {
  it('groups paths by kind, preserving order', () => {
    expect(
      groupVisualFiles([
        { path: 'a.tsx', kind: 'created' },
        { path: 'b.ts', kind: 'modified' },
        { path: 'c.tsx', kind: 'created' },
        { path: 'd.md', kind: 'suggested' },
      ]),
    ).toEqual({ created: ['a.tsx', 'c.tsx'], modified: ['b.ts'], suggested: ['d.md'] });
  });

  it('returns empty groups for no files', () => {
    expect(groupVisualFiles([])).toEqual({ created: [], modified: [], suggested: [] });
  });
});

describe('visualImageSrc', () => {
  it('converts absolute local paths to file URLs with encoded path parts', () => {
    expect(visualImageSrc('/Users/lynn/Desktop/a b#1.png')).toBe('file:///Users/lynn/Desktop/a%20b%231.png');
  });

  it('keeps already safe URLs and rejects relative paths', () => {
    expect(visualImageSrc('https://example.test/a.png')).toBe('https://example.test/a.png');
    expect(visualImageSrc('file:///tmp/a.png')).toBe('file:///tmp/a.png');
    expect(visualImageSrc('relative.png')).toBeNull();
  });
});

describe('visualBoxStyle', () => {
  it('renders normalized boxes as percentage CSS values', () => {
    expect(visualBoxStyle({ x: 0.25, y: 0.5, width: 0.1, height: 0.2 })).toEqual({
      left: '25%',
      top: '50%',
      width: '10%',
      height: '20%',
    });
  });

  it('clamps out-of-range coordinates and gives point boxes a visible size', () => {
    expect(visualBoxStyle({ x: 2, y: -1 })).toEqual({
      left: '100%',
      top: '0%',
      width: '4%',
      height: '4%',
    });
  });
});
