// Brain v2 · Router multi-turn server-side tool execution tests
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  cooldown: new Set(),
  providers: {},
  adapterFn: null,
  adapterCalls: 0,
}));

vi.mock('../provider-registry.js', () => ({
  universalOrder: ['p-mimo', 'p-spark'],
  getProvider: (id) => mockState.providers[id] || null,
  isInCooldown: (id) => mockState.cooldown.has(id),
  markUnhealthy: (id) => mockState.cooldown.add(id),
  clearUnhealthy: (id) => mockState.cooldown.delete(id),
  PROVIDERS: mockState.providers,
}));

vi.mock('../wire-adapter/index.js', () => ({
  getAdapter: () => mockState.adapterFn,
  ADAPTERS: {},
}));

vi.mock('../tool-exec/index.js', () => ({
  isServerTool: (name) => name === 'web_search',
  executeServerTool: vi.fn(async (name, argsStr) => 'mocked-result-for-' + name + ':' + argsStr),
  mergeWithServerTools: (tools) => {
    const list = Array.isArray(tools) ? [...tools] : [];
    const seen = new Set(list.filter(t => t?.function?.name).map(t => t.function.name));
    if (!seen.has('web_search')) list.push({ type: 'function', function: { name: 'web_search', parameters: {} } });
    return list;
  },
}));

import { run, __testing__ } from '../router.js';

function makeProvider(id) {
  return {
    id, wire: 'mock', endpoint: 'http://mock', apiKey: 'k', model: 'm',
    capability: { vision: false, audio: false, tools: true, thinking: true },
  };
}

beforeEach(() => {
  mockState.cooldown.clear();
  mockState.providers = { 'p-mimo': makeProvider('p-mimo'), 'p-spark': makeProvider('p-spark') };
  mockState.adapterCalls = 0;
  mockState.adapterFn = null;
});

describe('Router multi-turn server-side tool execution', () => {
  it('executes server-side web_search and continues with same provider', async () => {
    let turn = 0;
    mockState.adapterFn = async function* ({ messages }) {
      turn++;
      mockState.adapterCalls++;
      if (turn === 1) {
        // Turn 1: model emits web_search tool_call
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'call-1', function: { name: 'web_search', arguments: '{\"query\":\"weather\"}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        // Turn 2: with tool result in messages, model produces final answer
        // Verify the messages include the assistant tool_calls + tool result
        expect(messages.find(m => m.role === 'tool')).toBeDefined();
        expect(messages.find(m => m.role === 'assistant' && m.tool_calls)).toBeDefined();
        yield { type: 'content', delta: 'final answer' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.iterations).toBe(2);
    expect(mockState.adapterCalls).toBe(2);
    expect(chunks.find(c => c.type === 'content' && c.delta === 'final answer')).toBeDefined();
    // lynn_tool_progress markers emitted
    const markers = chunks.filter(c => c.type === 'content' && c.delta?.includes('lynn_tool_progress')).map(c => c.delta);
    expect(markers.some(m => m.includes('event=\"start\" name=\"web_search\"'))).toBe(true);
    expect(markers.some(m => m.includes('event=\"end\" name=\"web_search\"'))).toBe(true);
  });

  it('forwards client-side tool_calls and stops loop', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'call-c', function: { name: 'bash', arguments: '{\"cmd\":\"ls\"}' } }] };
      yield { type: 'finish', reason: 'tool_calls' };
    };
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async () => {},
    });
    expect(result.forwardedToClient).toBe(true);
    expect(result.clientToolCalls).toBe(1);
    expect(mockState.adapterCalls).toBe(1);  // only one round
  });

  it('mixed server+client tool_calls: forward to client (no server exec)', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'tool_call_delta', delta: [
        { index: 0, id: 'srv', function: { name: 'web_search', arguments: '{}' } },
        { index: 1, id: 'cli', function: { name: 'bash', arguments: '{}' } },
      ] };
      yield { type: 'finish', reason: 'tool_calls' };
    };
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async () => {},
    });
    expect(result.forwardedToClient).toBe(true);
    expect(mockState.adapterCalls).toBe(1);
  });

  it('stops cleanly without synthetic fallback when iter cap is hit', async () => {
    let lastTools;
    mockState.adapterFn = async function* ({ tools }) {
      mockState.adapterCalls++;
      lastTools = tools;
      yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
      yield { type: 'finish', reason: 'tool_calls' };
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.hitMaxIterations).toBe(true);
    expect(result.synthesisRound).toBeUndefined();
    expect(result.synthesisSkipped).toBe(true);
    expect(result.iterations).toBe(10);
    expect(mockState.adapterCalls).toBe(10);
    expect(lastTools).not.toBeNull();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('[brain]'))).toBeUndefined();
    expect(chunks.find(c => c.type === 'finish' && c.reason === 'stop')).toBeDefined();
  });

  it('injects synthesis instruction into the first system message instead of appending a tail system message', () => {
    const messages = [
      { role: 'system', content: '原始系统约束' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    const next = __testing__.withSynthesisSystemMessage(messages, '合成轮约束');
    expect(next).toHaveLength(3);
    expect(next[0].role).toBe('system');
    expect(next[0].content).toContain('原始系统约束');
    expect(next[0].content).toContain('合成轮约束');
    expect(next.slice(1).some(m => m.role === 'system')).toBe(false);
  });

  it('prepends synthesis instruction when no system message exists', () => {
    const next = __testing__.withSynthesisSystemMessage([{ role: 'user', content: 'q' }], '合成轮约束');
    expect(next[0]).toEqual({ role: 'system', content: '合成轮约束' });
    expect(next[1]).toEqual({ role: 'user', content: 'q' });
  });

  it('does not invoke a synthesis round when the loop guard is reached', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
      yield { type: 'finish', reason: 'tool_calls' };
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.hitMaxIterations).toBe(true);
    expect(result.synthesisSkipped).toBe(true);
    expect(mockState.adapterCalls).toBe(10);
    expect(chunks.find(c => c.type === 'reasoning' && c.delta?.includes('[brain]'))).toBeUndefined();
  });

  it('returns the model output directly after tool rounds without forced synthesis', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'content', delta: '模型自己的最终答案' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBeUndefined();
    expect(result.providerId).toBe('p-mimo');
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('模型自己的最终答案'))).toBeDefined();
    expect(chunks.find(c => c.type === 'finish' && c.reason === 'stop')).toBeDefined();
  });

  it('does not sanitize the model final output after tools', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'content', delta: '<tool_call>\n<function=create_docx>\n<parameter=title>报告</parameter>' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    const visible = chunks.filter(c => c.type === 'content').map(c => c.delta).join('');
    expect(result.synthesisRound).toBeUndefined();
    expect(result.providerId).toBe('p-mimo');
    expect(visible).toContain('<tool_call>');
    expect(visible).toContain('create_docx');
  });

  it('does not emit synthetic progress text between tool rounds', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'content', delta: '最终答案' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBeUndefined();
    expect(chunks.find(c => c.type === 'reasoning' && c.delta?.includes('[brain]'))).toBeUndefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('最终答案'))).toBeDefined();
  });

  it('keeps short model narration as-is after tool rounds', async () => {
    let lastTools;
    mockState.adapterFn = async function* ({ tools }) {
      mockState.adapterCalls++;
      lastTools = tools;
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'content', delta: '搜索结果较简略，继续深挖具体数据。' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBeUndefined();
    expect(result.iterations).toBe(3);
    expect(mockState.adapterCalls).toBe(3);
    expect(lastTools).not.toBeNull();
    expect(chunks.find(c => c.type === 'reasoning' && c.delta?.includes('短进度文字'))).toBeUndefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('搜索结果较简略'))).toBeDefined();
  });

  it('does not rewrite deep research output into a synthesis plan', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{
          index: 0,
          id: 'tc-' + mockState.adapterCalls,
          function: {
            name: 'web_search',
            arguments: mockState.adapterCalls === 1
              ? '{"query":"红松 糖豆 老年 用户画像"}'
              : '{"query":"美篇 App 中老年 受众 调研"}',
          },
        }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (mockState.adapterCalls === 3) {
        yield { type: 'content', delta: '初步搜索拿到了方向，但摘要太粗，继续深挖。' };
        yield { type: 'finish', reason: 'stop' };
      } else {
        yield { type: 'content', delta: '完整调研报告：一、红松与糖豆用户画像... 二、美篇用户画像... 三、交集与差异... 四、内容传播建议...' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: [
        '为我调研：',
        '1. 红松、糖豆的主要老年受众是哪些群体；',
        '2. 美篇等App的受众是哪些群体；',
        '3. 1和2的群体有哪些交集和差异；',
        '基于以上话题，深入调研和分析，形成docx格式的调研报告。',
      ].join('\n') }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBeUndefined();
    expect(mockState.adapterCalls).toBe(3);
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('初步搜索'))).toBeDefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('完整调研报告'))).toBeUndefined();
  });

  it('does not reject a too-short docx research answer after multiple tool rounds', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (mockState.adapterCalls === 3) {
        yield { type: 'content', delta: '报告摘要：中老年用户偏好陪伴、健康和娱乐内容。' };
        yield { type: 'finish', reason: 'stop' };
      } else {
        yield { type: 'content', delta: '最终完整报告正文：'.padEnd(1200, '详') };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '请深入调研中老年互联网内容生态，并形成 docx 格式完整调研报告。' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBeUndefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('报告摘要：'))).toBeDefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('最终完整报告正文'))).toBeUndefined();
  });

  it('does not force synthesis for a legitimate one-round short answer', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'content', delta: '是。' };
      yield { type: 'finish', reason: 'stop' };
    };
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async () => {},
    });
    expect(result.synthesisRound).toBeUndefined();
    expect(result.iterations).toBe(1);
    expect(mockState.adapterCalls).toBe(1);
  });

  it('does not leak pre-tool progress narration from server-side tool rounds', async () => {
    let turn = 0;
    mockState.adapterFn = async function* () {
      turn++;
      if (turn === 1) {
        yield { type: 'content', delta: '我先搜索一下资料，继续深挖。' };
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-progress', function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'content', delta: '最终答案已经整理完成。' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async (c) => chunks.push(c) });
    const visible = chunks.filter(c => c.type === 'content').map(c => c.delta).join('');
    expect(visible).not.toContain('我先搜索一下资料');
    expect(visible).toContain('最终答案已经整理完成');
  });

  it('flushes buffered content when a tool-enabled round ends with a final answer', async () => {
    mockState.adapterFn = async function* () {
      yield { type: 'content', delta: '直接最终回答。' };
      yield { type: 'finish', reason: 'stop' };
    };
    const chunks = [];
    const result = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async (c) => chunks.push(c) });
    expect(result.iterations).toBe(1);
    expect(chunks.find(c => c.type === 'content' && c.delta === '直接最终回答。')).toBeDefined();
    expect(chunks.find(c => c.type === 'finish' && c.reason === 'stop')).toBeDefined();
  });

  it('passes tool result content as role=tool message with correct tool_call_id', async () => {
    let capturedMessages = null;
    let turn = 0;
    mockState.adapterFn = async function* ({ messages }) {
      turn++;
      if (turn === 1) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'specific-id-xyz', function: { name: 'web_search', arguments: '{\"query\":\"hi\"}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        capturedMessages = messages;
        yield { type: 'content', delta: 'done' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });
    const toolMsg = capturedMessages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('specific-id-xyz');
    expect(toolMsg.content).toContain('mocked-result-for-web_search');
  });

  it('plain content (no tool_calls) returns immediately after one round', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'content', delta: 'hi there' };
      yield { type: 'finish', reason: 'stop' };
    };
    const result = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });
    expect(result.iterations).toBe(1);
    expect(mockState.adapterCalls).toBe(1);
    expect(result.hitMaxIterations).toBeUndefined();
    expect(result.forwardedToClient).toBeUndefined();
  });
});
