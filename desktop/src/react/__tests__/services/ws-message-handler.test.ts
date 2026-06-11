import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleServerMessage, humanizeTurnFailureError } from '../../services/ws-message-handler';
import { useStore } from '../../stores';

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
