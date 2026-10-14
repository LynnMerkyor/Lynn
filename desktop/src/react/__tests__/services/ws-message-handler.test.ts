import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleServerMessage, humanizeTurnFailureError } from '../../services/ws-message-handler';
import { useStore } from '../../stores';
import { streamBufferManager } from '../../hooks/use-stream-buffer';
import { injectHandlers, replayStreamResume } from '../../services/stream-resume';

describe('ws-message-handler replay isolation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not render a live chunk twice when an overlapping resume response replays it', () => {
    const sessionPath = '/sessions/replay-overlap';
    useStore.setState({ currentSessionPath: sessionPath });
    const render = vi.spyOn(streamBufferManager, 'handle').mockImplementation(() => {});
    injectHandlers(handleServerMessage, () => {});
    const event = { type: 'text_delta', delta: 'hello' };
    handleServerMessage({ ...event, sessionPath, streamId: 'overlap-stream', seq: 1 });
    replayStreamResume({ sessionPath, streamId: 'overlap-stream', events: [{ seq: 1, event }], isStreaming: true });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('accepts the next sequence and does not deduplicate across different streams', () => {
    const sessionPath = '/sessions/replay-sequences';
    useStore.setState({ currentSessionPath: sessionPath });
    const render = vi.spyOn(streamBufferManager, 'handle').mockImplementation(() => {});
    const event = { type: 'text_delta', delta: 'hello', sessionPath };
    handleServerMessage({ ...event, streamId: 'first-stream', seq: 1 });
    handleServerMessage({ ...event, streamId: 'first-stream', seq: 2 });
    handleServerMessage({ ...event, streamId: 'first-stream', seq: 1 });
    handleServerMessage({ ...event, streamId: 'next-stream', seq: 1 });
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('does not let a stale non-reset replay close the current stream', () => {
    const sessionPath = '/sessions/replay-stale';
    useStore.setState({ currentSessionPath: sessionPath });
    const render = vi.spyOn(streamBufferManager, 'handle').mockImplementation(() => {});
    const applyStatus = vi.fn();
    injectHandlers(handleServerMessage, applyStatus);
    handleServerMessage({ type: 'text_delta', delta: 'new answer', sessionPath, streamId: 'current-stream', seq: 1 });
    replayStreamResume({ sessionPath, streamId: 'old-stream', events: [{ seq: 2, event: { type: 'turn_end' } }], isStreaming: false });
    expect(render).toHaveBeenCalledTimes(1);
    expect(applyStatus).not.toHaveBeenCalled();
  });

  it('keeps unsequenced legacy chunks and independent sessions working', () => {
    const render = vi.spyOn(streamBufferManager, 'handle').mockImplementation(() => {});
    for (const sessionPath of ['/sessions/sequence-a', '/sessions/sequence-b']) {
      handleServerMessage({ type: 'text_delta', delta: 'text', sessionPath, streamId: 'shared-id', seq: 1 });
      handleServerMessage({ type: 'text_delta', delta: 'legacy', sessionPath });
    }
    expect(render).toHaveBeenCalledTimes(4);
  });
});

describe('ws-message-handler turn failure feedback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useStore.setState({
      currentSessionPath: '/sessions/current',
      sessions: [],
      isStreaming: true,
      streamingSessions: ['/sessions/current'],
      inlineError: null,
      inlineNotice: null,
      toasts: [],
    });
  });

  it('humanizes provider and empty-response failures without hiding unknown errors', () => {
    expect(humanizeTurnFailureError('route failed: all providers failed')).toBe('所有模型暂时不可用，请稍后重试或重新开始对话');
    expect(humanizeTurnFailureError('empty response from model')).toBe('模型没有返回内容，请点「编辑重发」重试');
    expect(humanizeTurnFailureError('request timed out after 60s')).toContain('模型请求超时，请重试');
    expect(humanizeTurnFailureError('custom debug error')).toBe('custom debug error');
  });

  it('turn failure errors stay visible until dismissed and stop the streaming state', () => {
    handleServerMessage({
      type: 'error',
      sessionPath: '/sessions/current',
      message: 'route failed: all providers failed',
    });

    const state = useStore.getState();
    expect(state.inlineError).toBe('所有模型暂时不可用，请稍后重试或重新开始对话');
    expect(state.isStreaming).toBe(false);
    expect(state.streamingSessions).not.toContain('/sessions/current');
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]).toMatchObject({
      type: 'error',
      text: '所有模型暂时不可用，请稍后重试或重新开始对话',
      persistent: true,
      dedupeKey: 'ws-error:/sessions/current:route failed: all providers failed',
    });
  });
});
