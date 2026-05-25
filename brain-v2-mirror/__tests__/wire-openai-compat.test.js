// Brain v2 · Generic OpenAI-compat wire adapter tests
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockFetch, ok, fail, makeSSEBody, sseEvent, sseDone, drain } from './helpers.js';
import { call as callOpenAI } from '../wire-adapter/openai-compat.js';

const provider = {
  id: 'deepseek-chat',
  endpoint: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  model: 'deepseek-v4-flash',
  capability: { vision: false, tools: true, thinking: true },
};

describe('OpenAI-compat wire adapter', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sends bearer token + model in body', async () => {
    const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
    await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const init = f.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body).model).toBe('deepseek-v4-flash');
  });

  it('does NOT include tools field when tools is null/empty', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('forwards reasoning + content (DeepSeek thinking mode)', async () => {
    mockFetch(ok(makeSSEBody(
      sseEvent({ reasoning_content: 'reason ' }),
      sseEvent({ content: 'answer' }),
      sseEvent({}, { finishReason: 'stop' }),
      sseDone(),
    )));
    const chunks = await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    expect(chunks.map(c => c.type)).toEqual(['reasoning', 'content', 'finish']);
  });

  it('skips empty content delta (null vs empty string both ignored)', async () => {
    mockFetch(ok(makeSSEBody(
      sseEvent({ content: null }),
      sseEvent({ content: '' }),
      sseEvent({ content: 'real' }),
      sseDone(),
    )));
    const chunks = await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
    expect(chunks.length).toBe(1);
    expect(chunks[0].delta).toBe('real');
  });

  it('respects provider.max_tokens override', async () => {
    const f = mockFetch(ok(makeSSEBody(sseDone())));
    await drain(callOpenAI({ provider: { ...provider, max_tokens: 8192 }, messages: [{ role: 'user', content: 'q' }] }));
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(8192);
  });

  it('throws with provider.id in error message on 401', async () => {
    mockFetch(fail(401, 'invalid key'));
    await expect(drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }))).rejects.toThrow(/deepseek-chat HTTP 401/);
  });

  // ── 2026-05-25 default_thinking flag(Spark APEX-MTP Brain v2 fallback 加固) ──
  describe('provider.default_thinking semantics', () => {
    const sparkProvider = {
      id: 'apex-spark-i-balanced',
      endpoint: 'http://127.0.0.1:18098/v1',
      apiKey: 'none',
      model: 'qwen36-35b-a3b-apex-mtp',
      capability: { vision: false, tools: true, thinking: true },
      default_thinking: false,
    };

    it('default_thinking:false → 注入 chat_template_kwargs.enable_thinking=false', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({ provider: sparkProvider, messages: [{ role: 'user', content: 'q' }] }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    it('default_thinking:false + reasoningEffort=high → opt-in thinking=true', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: 'q' }],
        reasoningEffort: 'high',
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(true);
      expect(body.reasoning_effort).toBe('high');
    });

    it('default_thinking:false + reasoningEffort=off → 保持 thinking=false', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: 'q' }],
        reasoningEffort: 'off',
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(false);
    });

    it('extraBody.chat_template_kwargs.enable_thinking 显式覆盖 default_thinking', async () => {
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({
        provider: sparkProvider,
        messages: [{ role: 'user', content: 'q' }],
        extraBody: { chat_template_kwargs: { enable_thinking: true } },
      }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs.enable_thinking).toBe(true);
    });

    it('未设 default_thinking 的 provider 不注入 chat_template_kwargs(default 行为不变)', async () => {
      // 即 deepseek-chat / glm 等老 provider 不受影响
      const f = mockFetch(ok(makeSSEBody(sseEvent({ content: 'hi' }), sseDone())));
      await drain(callOpenAI({ provider, messages: [{ role: 'user', content: 'q' }] }));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body.chat_template_kwargs).toBeUndefined();
    });
  });
});
