export type ComposerInsertMode = 'insert' | 'replace';

export interface ComposerTextUpdateInput {
  current: string;
  incoming: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  mode?: ComposerInsertMode;
  appendSpacer?: boolean;
}

export interface ComposerTextUpdate {
  next: string;
  caretStart: number;
  caretEnd: number;
}

function clampIndex(value: number | null | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value as number)) return fallback;
  return Math.max(0, Math.min(max, Number(value)));
}

export function computeComposerTextUpdate(input: ComposerTextUpdateInput): ComposerTextUpdate {
  const current = String(input.current || '');
  const incoming = String(input.incoming || '');
  const mode = input.mode || 'insert';
  if (mode === 'replace') {
    return {
      next: incoming,
      caretStart: incoming.length,
      caretEnd: incoming.length,
    };
  }

  const start = clampIndex(input.selectionStart, current.length, current.length);
  const end = clampIndex(input.selectionEnd, start, current.length);
  const normalizedStart = Math.min(start, end);
  const normalizedEnd = Math.max(start, end);
  const needsSpacer = !!input.appendSpacer
    && !!current
    && normalizedStart === current.length
    && !current.endsWith('\n');
  const insert = needsSpacer ? `\n\n${incoming}` : incoming;
  const next = `${current.slice(0, normalizedStart)}${insert}${current.slice(normalizedEnd)}`;
  const caret = normalizedStart + insert.length;
  return {
    next,
    caretStart: caret,
    caretEnd: caret,
  };
}
