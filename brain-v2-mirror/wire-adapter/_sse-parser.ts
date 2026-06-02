// Brain v2 · Shared OpenAI-compat SSE parser
// 原则:wire-format 事实层(SSE chunk → 标准 Chunk),不做内容判断
//
// 标准 Chunk:
//   { type: 'reasoning', delta: string }
//   { type: 'content',   delta: string }
//   { type: 'tool_call_delta', delta: Array<{index, id?, function?: {name?, arguments?}}> }
//   { type: 'usage',     usage: unknown }
//   { type: 'finish',    reason: string }

import type { StreamChunk, ToolCallDelta } from '../types.js';

// Guard against pathological upstreams that stream MB of data with no '\n' delimiter.
// 4MB is far above any sane single-line SSE event; trip → abort the stream.
const MAX_BUFFER = 4 * 1024 * 1024;

type SSEBody = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;

function isAsyncIterable(body: NonNullable<SSEBody>): body is AsyncIterable<Uint8Array> {
  return typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

async function* iterateSSEBytes(body: SSEBody): AsyncGenerator<Uint8Array> {
  if (!body) return;
  if (isAsyncIterable(body)) {
    yield* body;
    return;
  }

  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* parseOpenAISSE(body: SSEBody): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of iterateSSEBytes(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_BUFFER) {
      throw new Error(`SSE parser buffer overflow (>${MAX_BUFFER} bytes without newline) — upstream likely sending non-SSE garbage`);
    }
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { continue; }
      const record = asRecord(parsed);
      if (record && 'usage' in record && record.usage) {
        yield { type: 'usage', usage: record.usage };
      }
      const choices = record?.choices;
      const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
      if (!choice) continue;
      const delta = asRecord(choice.delta) || {};
      // reasoning_content (thinking 模型) — 兼容多种字段名
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning != null && reasoning !== '') {
        yield { type: 'reasoning', delta: String(reasoning) };
      }
      if (delta.content != null && delta.content !== '') {
        yield { type: 'content', delta: String(delta.content) };
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        yield { type: 'tool_call_delta', delta: delta.tool_calls as ToolCallDelta[] };
      }
      if (choice.finish_reason) {
        yield { type: 'finish', reason: String(choice.finish_reason) };
      }
    }
  }
}
