import { describe, expect, it } from 'vitest';
import {
  normalizeResponsesRequest,
  ResponsesCompatEmitter,
  responsesInputToChatMessages,
} from '../responses-compat.js';

describe('Responses compatibility bridge', () => {
  it('converts response history and function outputs to chat messages', () => {
    const messages = responsesInputToChatMessages([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
    ], 'system rule');

    expect(messages).toEqual([
      { role: 'system', content: 'system rule' },
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'contents' },
    ]);
  });

  it('normalizes top-level Responses function tools', () => {
    const request = normalizeResponsesRequest({
      model: 'byok-model',
      input: 'hello',
      tools: [{ type: 'function', name: 'grep', description: 'search', parameters: { type: 'object' } }],
      reasoning: { effort: 'high' },
      max_output_tokens: 4096,
      stream: true,
    });
    expect(request).toMatchObject({
      model: 'byok-model',
      messages: [{ role: 'user', content: 'hello' }],
      reasoningEffort: 'high',
      extraBody: { max_output_tokens: 4096, max_tokens: 4096 },
      tools: [{ type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } }],
    });
  });

  it('flattens namespace functions for Chat and restores namespaced history', () => {
    const request = normalizeResponsesRequest({
      input: [
        { type: 'function_call', call_id: 'call-1', namespace: 'mcp__calendar', name: 'list_events', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: '[]' },
      ],
      tools: [{
        type: 'namespace',
        name: 'mcp__calendar',
        description: 'Calendar tools',
        tools: [{ type: 'function', name: 'list_events', parameters: { type: 'object', properties: {} } }],
      }],
    });

    expect(request.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: 'mcp__calendar__list_events' }) }),
    ]);
    expect(request.messages[0]).toMatchObject({
      tool_calls: [{ function: { name: 'mcp__calendar__list_events', arguments: '{}' } }],
    });
    expect(request.toolNameMap.mcp__calendar__list_events).toEqual({
      namespace: 'mcp__calendar',
      name: 'list_events',
      kind: 'function',
    });
  });

  it('restores namespace custom tools as custom_tool_call output items', () => {
    const request = normalizeResponsesRequest({
      input: 'run',
      tools: [{
        type: 'namespace',
        name: 'functions',
        description: 'Code-mode tools',
        tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript' }],
      }],
    });
    const events = [];
    const emitter = new ResponsesCompatEmitter('model', true, (event) => events.push(event), 'resp-custom', request.toolNameMap);
    emitter.onChunk({
      type: 'tool_call_delta',
      delta: [{ index: 0, id: 'call-exec', function: { name: 'functions__exec', arguments: '{"input":"text(42)"}' } }],
    });
    const response = emitter.complete();

    expect(request.tools[0]).toMatchObject({
      function: {
        name: 'functions__exec',
        parameters: expect.objectContaining({ required: ['input'] }),
      },
    });
    expect(response.output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'custom_tool_call',
        namespace: 'functions',
        name: 'exec',
        input: 'text(42)',
        call_id: 'call-exec',
      }),
    ]));
    expect(events.filter((event) => event.type === 'response.output_item.done')).toHaveLength(1);
  });

  it('emits Responses text and function-call events with one terminal event', () => {
    const events = [];
    const emitter = new ResponsesCompatEmitter('model', true, (event) => events.push(event), 'resp-test');
    emitter.start();
    emitter.onChunk({ type: 'content', delta: 'hello' });
    emitter.onChunk({ type: 'tool_call_delta', delta: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":' } }] });
    emitter.onChunk({ type: 'tool_call_delta', delta: [{ index: 0, function: { arguments: '"README.md"}' } }] });
    emitter.onChunk({ type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    const response = emitter.complete();
    emitter.complete();

    expect(events.filter((event) => event.type === 'response.completed')).toHaveLength(1);
    expect(events.some((event) => event.type === 'response.output_text.delta' && event.delta === 'hello')).toBe(true);
    expect(events.filter((event) => event.type === 'response.function_call_arguments.delta')).toHaveLength(2);
    expect(response).toMatchObject({
      id: 'resp-test',
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      output: expect.arrayContaining([
        expect.objectContaining({ type: 'message', status: 'completed' }),
        expect.objectContaining({ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}', status: 'completed' }),
      ]),
    });
  });

  it('keeps the first terminal result when completion is attempted after failure', () => {
    const events = [];
    const emitter = new ResponsesCompatEmitter('model', true, (event) => events.push(event), 'resp-failed');
    const failed = emitter.fail('provider disconnected');
    const repeated = emitter.complete();

    expect(failed).toMatchObject({ status: 'failed', error: { message: 'provider disconnected' } });
    expect(repeated).toMatchObject({ status: 'failed', error: { message: 'provider disconnected' } });
    expect(events.filter((event) => event.type === 'response.failed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'response.completed')).toHaveLength(0);
  });

  it('rejects tool types that cannot be represented by a chat backend', () => {
    expect(() => normalizeResponsesRequest({ input: 'x', tools: [{ type: 'unknown_future_tool' }] }))
      .toThrow('Unsupported Responses tool type');
  });

  it('drops known provider-hosted tools with an explicit model-facing capability note', () => {
    const request = normalizeResponsesRequest({ input: 'x', tools: [{ type: 'web_search' }] });
    expect(request.tools).toEqual([]);
    expect(request.droppedToolTypes).toEqual(['web_search']);
    expect(request.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('does not provide') });
  });
});
