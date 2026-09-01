/* eslint-disable @typescript-eslint/no-explicit-any -- markdown-it ruler state is plugin-internal. */

function isValidDelimiter(state: any, pos: number) {
  const previous = pos > 0 ? state.src.charCodeAt(pos - 1) : -1;
  const next = pos + 1 <= state.posMax ? state.src.charCodeAt(pos + 1) : -1;
  return {
    canOpen: next !== 0x20 && next !== 0x09,
    canClose: previous !== 0x20 && previous !== 0x09 && !(next >= 0x30 && next <= 0x39),
  };
}

function mathInline(state: any, silent: boolean) {
  if (state.src[state.pos] !== '$') return false;
  if (!isValidDelimiter(state, state.pos).canOpen) {
    if (!silent) state.pending += '$';
    state.pos += 1;
    return true;
  }

  const start = state.pos + 1;
  let match = start;
  while ((match = state.src.indexOf('$', match)) !== -1) {
    let position = match - 1;
    while (state.src[position] === '\\') position -= 1;
    if ((match - position) % 2 === 1) break;
    match += 1;
  }
  if (match === -1) {
    if (!silent) state.pending += '$';
    state.pos = start;
    return true;
  }
  if (match === start || !isValidDelimiter(state, match).canClose) {
    if (!silent) state.pending += match === start ? '$$' : '$';
    state.pos = match === start ? start + 1 : start;
    return true;
  }
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.markup = '$';
    token.content = state.src.slice(start, match);
  }
  state.pos = match + 1;
  return true;
}

function mathBlock(state: any, start: number, end: number, silent: boolean) {
  let position = state.bMarks[start] + state.tShift[start];
  let max = state.eMarks[start];
  if (position + 2 > max || state.src.slice(position, position + 2) !== '$$') return false;
  position += 2;
  let firstLine = state.src.slice(position, max);
  if (silent) return true;
  let found = false;
  let lastLine = '';
  if (firstLine.trim().slice(-2) === '$$') {
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }
  let next = start;
  while (!found) {
    next += 1;
    if (next >= end) break;
    position = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    if (position < max && state.tShift[next] < state.blkIndent) break;
    if (state.src.slice(position, max).trim().slice(-2) === '$$') {
      const lastPosition = state.src.slice(0, max).lastIndexOf('$$');
      lastLine = state.src.slice(position, lastPosition);
      found = true;
    }
  }
  state.line = next + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = `${firstLine?.trim() ? `${firstLine}\n` : ''}${state.getLines(start + 1, next, state.tShift[start], true)}${lastLine?.trim() ? lastLine : ''}`;
  token.map = [start, state.line];
  token.markup = '$$';
  return true;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function placeholder(content: string, displayMode: boolean) {
  const tag = displayMode ? 'div' : 'span';
  const mode = displayMode ? 'block' : 'inline';
  return `<${tag} class="lynn-math-placeholder" data-lynn-math="${encodeURIComponent(content)}" data-display="${mode}">${escapeHtml(content)}</${tag}>${displayMode ? '\n' : ''}`;
}

export function markdownMathPlaceholders(md: any) {
  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.block.ruler.after('blockquote', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.renderer.rules.math_inline = (tokens: any[], index: number) => placeholder(tokens[index].content, false);
  md.renderer.rules.math_block = (tokens: any[], index: number) => placeholder(tokens[index].content, true);
}
