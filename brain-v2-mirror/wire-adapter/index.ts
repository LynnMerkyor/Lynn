// Brain v2 · wire-adapter dispatch
// 原则:provider.wire string → adapter call function
import { call as callMimo, wireMeta as mimoMeta } from './mimo.js';
import { call as callSGLang, wireMeta as sglangMeta } from './sglang.js';
import { call as callOpenAI, wireMeta as openaiMeta } from './openai-compat.js';
import type { WireAdapter, WireName } from '../types.js';

export const ADAPTERS: Record<WireName, WireAdapter> = {
  mimo: callMimo,
  sglang: callSGLang,
  openai: callOpenAI,
  'openai-compat': callOpenAI,
};

export const WIRE_META = {
  mimo: mimoMeta,
  sglang: sglangMeta,
  openai: openaiMeta,
};

export function getAdapter(wireName: WireName | string): WireAdapter {
  return ADAPTERS[wireName as WireName] || ADAPTERS.openai;
}

export { parseOpenAISSE } from './_sse-parser.js';
