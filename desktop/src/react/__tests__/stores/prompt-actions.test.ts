import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockState extends Record<string, unknown> {
  appended: Array<{ sessionPath: string; item: { data: Record<string, unknown> } }>;
  chatSessions: Record<string, { items: Array<{ type: string; data: Record<string, unknown> }> }>;
  appendItem: ((sessionPath: string, item: unknown) => void) & { mockClear: () => void };
  addToast: ((...args: unknown[]) => void) & { mockClear: () => void };
}

const mockState: MockState = {
  isStreaming: false,
  pendingNewSession: false,
  sessionCreationPending: false,
  selectedFolder: null,
  homeFolder: '/Users/lynn',
  currentSessionPath: '/sessions/current',
  streamingSessions: [],
  currentAgentId: 'lynn',
  agentName: 'Lynn',
  currentModel: null,
  sessions: [],
  serverReady: true,
  welcomeVisible: true,
  chatSessions: {},
  appended: [],
  appendItem: vi.fn((sessionPath: string, item: unknown) => {
    mockState.appended.push({ sessionPath, item: item as { data: Record<string, unknown> } });
  }),
  setInlineNotice: vi.fn(),
  addToast: vi.fn((..._args: unknown[]) => undefined) as unknown as MockState['addToast'],
};

const setState = vi.fn((patch: Record<string, unknown> | ((state: MockState) => Record<string, unknown>)) => {
  const next = typeof patch === 'function' ? patch(mockState) : patch;
  Object.assign(mockState, next);
});

const ensureSession = vi.fn();
const renderMarkdown = vi.fn(async (text: string) => `<p>${text}</p>`);
let websocketRef: { readyState: number; send: ReturnType<typeof vi.fn> } | null = null;
let windowListeners: Record<string, Array<(event: Event) => void>> = {};

function makeWindowStub() {
  return {
    t: vi.fn((key: string) => key),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      windowListeners[type] = [...(windowListeners[type] || []), listener as (event: Event) => void];
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      windowListeners[type] = (windowListeners[type] || []).filter((fn) => fn !== listener);
    }),
    dispatchEvent: vi.fn((event: Event) => {
      for (const listener of windowListeners[event.type] || []) {
        listener(event);
      }
      return true;
    }),
  };
}

function acknowledgePrompt(payload: string): void {
  const msg = JSON.parse(payload);
  if (msg.type !== 'prompt' || !msg.clientMessageId) return;
  window.dispatchEvent(new CustomEvent('hana-prompt-accepted', {
    detail: {
      clientMessageId: msg.clientMessageId,
      sessionPath: msg.sessionPath,
    },
  }));
}

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mockState,
    setState,
  },
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession,
  showSidebarToast: (text: string, duration = 3000, type = 'info', dedupeKey?: string) => {
    mockState.addToast(text, type, duration, dedupeKey ? { dedupeKey } : undefined);
  },
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: () => websocketRef,
}));

vi.mock('../../utils/markdown', () => ({
  renderMarkdown,
}));

describe('prompt-actions', () => {
  beforeEach(() => {
    mockState.isStreaming = false;
    mockState.pendingNewSession = false;
    mockState.sessionCreationPending = false;
    mockState.selectedFolder = null;
    mockState.homeFolder = '/Users/lynn';
    mockState.currentSessionPath = '/sessions/current';
    mockState.streamingSessions = [];
    mockState.currentAgentId = 'lynn';
    mockState.agentName = 'Lynn';
    mockState.currentModel = null;
    mockState.sessions = [];
    mockState.chatSessions = {};
    mockState.welcomeVisible = true;
    mockState.appended = [];
    mockState.appendItem.mockClear();
    (mockState.setInlineNotice as ReturnType<typeof vi.fn>).mockClear();
    mockState.addToast.mockClear();
    setState.mockClear();
    ensureSession.mockReset();
    ensureSession.mockResolvedValue(true);
    renderMarkdown.mockClear();
    windowListeners = {};
    websocketRef = { readyState: 1, send: vi.fn((payload: string) => acknowledgePrompt(payload)) };
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    vi.stubGlobal('window', makeWindowStub());
  });

  it('sendPrompt 默认按 prompt 发送', async () => {
    const { sendPrompt } = await import('../../stores/prompt-actions');

    const sent = await sendPrompt({ text: 'hello' });

    expect(sent).toBe(true);
    expect(mockState.appendItem).toHaveBeenCalledOnce();
    const appended = mockState.appended[0].item.data;
    expect(appended.taskMode).toBe('prompt');
    expect(websocketRef?.send).toHaveBeenCalledWith(expect.stringContaining('"type":"prompt"'));
    expect(JSON.parse(websocketRef?.send.mock.calls[0][0])).toMatchObject({
      type: 'prompt',
      text: 'hello',
      sessionPath: '/sessions/current',
    });
  });

  it('submitPromptTask 在流式中阻止新的 prompt', async () => {
    mockState.isStreaming = true;
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'prompt', text: '继续' });

    expect(sent).toBe(false);
    expect(mockState.appendItem).not.toHaveBeenCalled();
    expect(websocketRef?.send).not.toHaveBeenCalled();
  });

  it('submitPromptTask 在当前 session 标记流式时阻止新的 prompt', async () => {
    mockState.isStreaming = false;
    mockState.currentSessionPath = '/sessions/current';
    mockState.streamingSessions = ['/sessions/current'];
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'prompt', text: '周日广州会下雨吗？' });

    expect(sent).toBe(false);
    expect(mockState.appendItem).not.toHaveBeenCalled();
    expect(websocketRef?.send).not.toHaveBeenCalled();
    expect(mockState.setInlineNotice).toHaveBeenCalledWith('chat.waitForCurrentReply');
  });

  it('submitPromptTask 在流式中允许 steer 并发送 steer 事件', async () => {
    mockState.isStreaming = true;
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'steer', text: '只补最后一步' });

    expect(sent).toBe(true);
    expect(mockState.appendItem).toHaveBeenCalledOnce();
    expect(websocketRef?.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'steer',
      text: '只补最后一步',
      sessionPath: '/sessions/current',
    }));
  });

  it('pending new session 时先回填 homeFolder 并 ensureSession', async () => {
    mockState.pendingNewSession = true;
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'prompt', text: '新会话第一条' });

    expect(sent).toBe(true);
    expect(setState).toHaveBeenCalledWith({ selectedFolder: '/Users/lynn' });
    expect(ensureSession).toHaveBeenCalledOnce();
  });

  it('pending new session 创建完成后使用最新 sessionPath 发送，避免落到旧会话', async () => {
    mockState.pendingNewSession = true;
    mockState.currentSessionPath = '/sessions/old';
    ensureSession.mockImplementationOnce(async () => {
      mockState.pendingNewSession = false;
      mockState.currentSessionPath = '/sessions/new';
      return true;
    });
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'prompt', text: '广州天气' });

    expect(sent).toBe(true);
    expect(mockState.appended[0].sessionPath).toBe('/sessions/new');
    expect(JSON.parse(websocketRef?.send.mock.calls[0][0])).toMatchObject({
      type: 'prompt',
      text: '广州天气',
      sessionPath: '/sessions/new',
    });
  });

  it('append user message 时保留 gitContext 摘要', async () => {
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    await submitPromptTask({
      mode: 'prompt',
      text: '显示文本',
      requestText: '真实请求',
      gitContext: { repoName: 'openhanako', branch: 'main', changedCount: 4 },
    });

    const appended = mockState.appended[0].item.data;
    expect(appended.gitContext).toEqual({ repoName: 'openhanako', branch: 'main', changedCount: 4 });
    expect(JSON.parse(websocketRef?.send.mock.calls[0][0])).toMatchObject({
      type: 'prompt',
      text: '真实请求',
      sessionPath: '/sessions/current',
    });
  });

  it('append user message 时保留 requestText、images 和 retryDraft', async () => {
    const { submitPromptTask } = await import('../../stores/prompt-actions');
    const retryDraft = {
      text: 'draft',
      attachedFiles: [{ path: '/repo/a.ts', name: 'a.ts' }],
      quotedSelection: null,
      docContextFile: null,
      workingSet: [{ path: '/repo/a.ts', name: 'a.ts', source: 'recent' as const }],
    };

    await submitPromptTask({
      mode: 'prompt',
      text: '显示文本',
      displayText: '显示文本',
      requestText: '真实请求',
      attachments: [{ path: '/repo/a.ts', name: 'a.ts', isDir: false }],
      images: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      retryDraft,
    });

    const appended = mockState.appended[0].item.data;
    expect(appended).toMatchObject({
      role: 'user',
      taskMode: 'prompt',
      text: '显示文本',
      requestText: '真实请求',
      requestImages: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      retryDraft,
    });
    expect(appended.attachments).toEqual([{ path: '/repo/a.ts', name: 'a.ts', isDir: false }]);
    expect(renderMarkdown).toHaveBeenCalledWith('显示文本');
    expect(setState).toHaveBeenCalledWith({ welcomeVisible: false });
  });

  it('编辑重发会把 replaceFromMessageId 发给服务端并裁掉本地旧分支', async () => {
    mockState.chatSessions = {
      '/sessions/current': {
        items: [
          { type: 'message', data: { id: '0', visibleIndex: 0, role: 'user', text: '旧问题' } },
          { type: 'message', data: { id: '1', visibleIndex: 1, role: 'assistant', text: '旧回答' } },
          { type: 'message', data: { id: 'user-1718000000000', role: 'user', text: '后续问题' } },
        ],
      },
    };
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({
      mode: 'prompt',
      text: '改后的问题',
      replaceFromMessageId: 'user-1718000000000',
    });

    expect(sent).toBe(true);
    expect(JSON.parse(websocketRef?.send.mock.calls[0][0])).toMatchObject({
      type: 'prompt',
      text: '改后的问题',
      sessionPath: '/sessions/current',
      replaceFromMessageId: 'user-1718000000000',
      replaceFromMessageIndex: 2,
    });
    expect(mockState.chatSessions['/sessions/current'].items.map(item => item.data.id)).toEqual(['0', '1']);
    expect(mockState.appendItem).toHaveBeenCalledOnce();
  });

  it('websocket send 抛错时不乐观上屏，避免假消息卡住会话', async () => {
    websocketRef = {
      readyState: 1,
      send: vi.fn(() => {
        throw new Error('socket closed');
      }),
    };
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'prompt', text: '默认模型门禁：请只回复 OK。' });

    expect(sent).toBe(false);
    expect(mockState.appendItem).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalledWith({ welcomeVisible: false });
    expect(mockState.addToast).toHaveBeenCalledWith('chat.needWsConnection', 'info', 5000, undefined);
  });

  it('steer 发送失败时同样不乐观上屏', async () => {
    mockState.isStreaming = true;
    websocketRef = {
      readyState: 1,
      send: vi.fn(() => {
        throw new Error('socket closed');
      }),
    };
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'steer', text: '只补最后一步' });

    expect(sent).toBe(false);
    expect(mockState.appendItem).not.toHaveBeenCalled();
    expect(mockState.addToast).toHaveBeenCalledWith('chat.needWsConnection', 'info', 5000, undefined);
  });

  it('首条用户消息会乐观加入侧边栏 session 列表', async () => {
    mockState.sessions = [];
    mockState.currentSessionPath = '/sessions/new';
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    await submitPromptTask({
      mode: 'prompt',
      text: '帮我检查 App.tsx',
    });

    const sessionPatch = setState.mock.calls.find(
      ([patch]) => Array.isArray((patch as { sessions?: unknown[] }).sessions),
    )?.[0] as { sessions: Array<Record<string, unknown>> } | undefined;
    expect(sessionPatch?.sessions?.[0]).toMatchObject({
      path: '/sessions/new',
      firstMessage: '帮我检查 App.tsx',
      agentId: 'lynn',
      agentName: 'Lynn',
      messageCount: 1,
    });
  });

  it('resendPromptRequest 在空内容或 streaming 时阻止发送', async () => {
    const { resendPromptRequest } = await import('../../stores/prompt-actions');

    expect(resendPromptRequest('   ')).toBe(false);

    mockState.isStreaming = true;
    expect(resendPromptRequest('hello')).toBe(false);
    expect(websocketRef?.send).not.toHaveBeenCalled();
  });

  it('resendPromptRequest 断开连接时提示 toast', async () => {
    websocketRef = { readyState: 0, send: vi.fn() };
    const { resendPromptRequest } = await import('../../stores/prompt-actions');

    const sent = resendPromptRequest('hello');

    expect(sent).toBe(false);
    expect(mockState.addToast).toHaveBeenCalledWith('chat.needWsConnection', 'info', 5000, undefined);
  });
});
