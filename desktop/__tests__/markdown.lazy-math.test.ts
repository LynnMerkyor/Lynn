// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getMdWithOpts, renderMarkdown } from '../src/react/utils/markdown';

describe('Markdown math lazy rendering', () => {
  it('keeps ordinary markdown free of math placeholders', () => {
    const html = renderMarkdown('Hello **Lynn**');
    expect(html).toContain('<strong>Lynn</strong>');
    expect(html).not.toContain('data-lynn-math');
    expect(html).not.toContain('class="katex"');
  });

  it('emits a safe inline placeholder without eagerly rendering KaTeX', () => {
    const html = renderMarkdown('Energy is $E=mc^2$.');
    expect(html).toContain('data-lynn-math="E%3Dmc%5E2"');
    expect(html).toContain('data-display="inline"');
    expect(html).toContain('E=mc^2');
    expect(html).not.toContain('class="katex"');
  });

  it('emits a block placeholder for display math', () => {
    const html = renderMarkdown('$$\na^2+b^2=c^2\n$$');
    expect(html).toContain('data-display="block"');
    expect(html).toContain('a%5E2%2Bb%5E2%3Dc%5E2');
    expect(html).not.toContain('class="katex-display"');
  });

  it('keeps math placeholders in custom Markdown instances', () => {
    const html = getMdWithOpts({ breaks: false }).render('Custom $x + y$ renderer');
    expect(html).toContain('data-lynn-math="x%20%2B%20y"');
    expect(html).not.toContain('katex-html');
  });
});
