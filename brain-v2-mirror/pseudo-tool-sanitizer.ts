import {
  containsPseudoToolSimulation,
  findUnresolvedPseudoToolOpen,
  stripPseudoToolCallMarkup,
} from '../shared/pseudo-tool-call.js';

export interface PseudoToolSanitizerState {
  carry: string;
  suppressed: boolean;
}

const MAX_CARRY = 32 * 1024;
const PIPE_OPEN_RE = /\|\|\d+\s*/gu;

export function createPseudoToolSanitizerState(): PseudoToolSanitizerState {
  return { carry: '', suppressed: false };
}

function unclosedPipeStart(text: string): number {
  let start = -1;
  PIPE_OPEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PIPE_OPEN_RE.exec(text)) !== null) {
    if (!text.slice(match.index + match[0].length).includes('}')) start = match.index;
  }
  return start;
}

function stripComplete(text: string): string {
  return containsPseudoToolSimulation(text) ? stripPseudoToolCallMarkup(text) : text;
}

export function sanitizePseudoToolDelta(state: PseudoToolSanitizerState, delta: unknown): string {
  const combined = state.carry + String(delta || '');
  const cut = Math.max(findUnresolvedPseudoToolOpen(combined), unclosedPipeStart(combined));
  const visible = cut < 0 ? combined : combined.slice(0, cut);
  state.carry = cut < 0 ? '' : combined.slice(cut);
  if (state.carry.length > MAX_CARRY) {
    state.carry = '';
    state.suppressed = true;
  }
  const stripped = stripComplete(visible);
  if (stripped !== visible) state.suppressed = true;
  return stripped;
}

export function flushPseudoToolSanitizer(state: PseudoToolSanitizerState): string {
  const carry = state.carry;
  state.carry = '';
  if (!carry) return '';
  if (findUnresolvedPseudoToolOpen(carry) >= 0 || unclosedPipeStart(carry) >= 0) {
    state.suppressed = true;
    return '';
  }
  const stripped = stripComplete(carry);
  if (stripped !== carry) state.suppressed = true;
  return stripped;
}
