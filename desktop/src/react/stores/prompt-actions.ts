import { useStore } from './index';
import type { PromptImage, UserAttachment, GitContext } from './chat-types';
import type { ComposerDraft, QuotedSelection } from './input-slice';
import { ensureSession, showSidebarToast } from './session-actions';
import { getWebSocket } from '../services/websocket';
import { getModeById } from '../config/task-modes';

export interface SendPromptOptions {
  mode?: 'prompt' | 'steer';
  text: string;
  displayText?: string;
  requestText?: string;
  quotedText?: string;
  quotedSelection?: QuotedSelection | null;
  retryDraft?: ComposerDraft | null;
  attachments?: UserAttachment[];
  images?: PromptImage[];
  gitContext?: GitContext | null;
}

function canSendPayload(text: string, images?: PromptImage[]): boolean {
  return text.trim().length > 0 || !!images?.length;
}

function syncOptimisticSessionList(displayText: string, sessionPath: string): void {
  const state = useStore.getState();
  const firstMessage = displayText.trim().slice(0, 100);
  const modified = new Date().toISOString();
  const currentModel = state.currentModel;
  const sessions = [...state.sessions];
  const idx = sessions.findIndex((session) => session.path === sessionPath);
  const nextSession = {
    path: sessionPath,
    title: idx >= 0 ? sessions[idx].title || null : null,
    firstMessage,
    modified,
    messageCount: Math.max((idx >= 0 ? sessions[idx].messageCount : 0) || 0, 1),
    cwd: idx >= 0 ? sessions[idx].cwd ?? state.selectedFolder ?? null : state.selectedFolder ?? null,
    agentId: idx >= 0 ? sessions[idx].agentId ?? state.currentAgentId ?? null : state.currentAgentId ?? null,
    agentName: idx >= 0 ? sessions[idx].agentName ?? state.agentName ?? null : state.agentName ?? null,
    modelId: idx >= 0 ? sessions[idx].modelId ?? currentModel?.id ?? null : currentModel?.id ?? null,
    modelProvider: idx >= 0 ? sessions[idx].modelProvider ?? currentModel?.provider ?? null : currentModel?.provider ?? null,
    labels: idx >= 0 ? sessions[idx].labels ?? [] : [],
  };
  if (idx >= 0) {
    sessions.splice(idx, 1);
  }
  useStore.setState({ sessions: [nextSession, ...sessions] });
}

function isCurrentSessionStreaming(state: { currentSessionPath?: string | null; isStreaming?: boolean; streamingSessions?: string[] }): boolean {
  const currentSessionPath = state.currentSessionPath;
  if (state.isStreaming) return true;
  return !!(
    currentSessionPath &&
    Array.isArray(state.streamingSessions) &&
    state.streamingSessions.includes(currentSessionPath)
  );
}

function sendWebSocketJson(payload: Record<string, unknown>): boolean {
  const ws = getWebSocket();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showSidebarToast(window.t?.('chat.needWsConnection') ?? 'Disconnected from assistant', 5000);
    return false;
  }
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    console.warn('[prompt-actions] websocket send failed', error);
    showSidebarToast(window.t?.('chat.needWsConnection') ?? 'Disconnected from assistant', 5000);
    return false;
  }
}

function createClientMessageId(): string {
  return `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function waitForPromptAccepted(clientMessageId: string, sessionPath: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('hana-prompt-accepted', onAccepted as EventListener);
      resolve(accepted);
    };
    const onAccepted = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.clientMessageId !== clientMessageId) return;
      if (detail.sessionPath && detail.sessionPath !== sessionPath) return;
      cleanup(true);
    };
    window.addEventListener('hana-prompt-accepted', onAccepted as EventListener);
    timer = setTimeout(() => cleanup(false), timeoutMs);
  });
}

export async function sendPrompt(options: SendPromptOptions): Promise<boolean> {
  return submitPromptTask({ ...options, mode: options.mode ?? 'prompt' });
}

export async function submitPromptTask(options: SendPromptOptions): Promise<boolean> {
  const mode = options.mode ?? 'prompt';
  const displayText = options.displayText ?? options.text;
  let requestText = options.requestText ?? options.text;

  // ── 任务模式 persona 注入（仅新发 prompt；steer 流中已有上下文，不重复注入）──
  if (mode === 'prompt') {
    const activeModeId = useStore.getState().taskModeId;
    const activeMode = activeModeId ? getModeById(activeModeId) : null;
    const persona = activeMode?.persona;
    if (persona && activeModeId !== 'auto') {
      requestText = `${persona}\n\n${requestText}`;
    }
  }

  if (!canSendPayload(requestText, options.images)) {
    return false;
  }

  const initialState = useStore.getState();
  if (!initialState.serverReady && mode === 'prompt') {
    const stage = initialState.serverStartupStage || 'starting';
    showSidebarToast(window.t?.('chat.serverStarting') ?? `Assistant is still starting (${stage})`, 5000);
    return false;
  }

  if (isCurrentSessionStreaming(initialState) && mode === 'prompt') {
    const message = window.t?.('chat.waitForCurrentReply') ?? '当前回复还没结束，请等本轮结束后再发下一条。';
    initialState.setInlineNotice?.(message);
    return false;
  }

  if (initialState.pendingNewSession && !initialState.selectedFolder && initialState.homeFolder) {
    useStore.setState({ selectedFolder: initialState.homeFolder });
  }

  if (mode === 'prompt' && useStore.getState().pendingNewSession) {
    const ok = await ensureSession();
    if (!ok) return false;
  }

  const sessionPath = useStore.getState().currentSessionPath;
  const ws = getWebSocket();
  if (!sessionPath || !ws || ws.readyState !== WebSocket.OPEN) {
    showSidebarToast(window.t?.('chat.needWsConnection') ?? 'Disconnected from assistant', 5000);
    return false;
  }

  const textHtml = displayText
    ? (await import('../utils/markdown')).renderMarkdown(displayText)
    : undefined;

  const clientMessageId = mode === 'prompt' ? createClientMessageId() : null;
  const promptAccepted = clientMessageId ? waitForPromptAccepted(clientMessageId, sessionPath) : null;
  const sent = mode === 'steer'
    ? sendWebSocketJson({ type: 'steer', text: requestText, sessionPath })
    : resendPromptRequest(requestText, options.images, sessionPath, clientMessageId);
  if (!sent) {
    return false;
  }
  if (promptAccepted) {
    const accepted = await promptAccepted;
    if (!accepted) {
      showSidebarToast(window.t?.('chat.sendNotConfirmed') ?? '发送没有得到服务端确认，Lynn 正在重连，请再试一次。', 5000);
      try { getWebSocket()?.close(); } catch { /* trigger reconnect */ }
      return false;
    }
  }

  useStore.getState().appendItem(sessionPath, {
    type: 'message',
    data: {
      id: `user-${Date.now()}`,
      role: 'user',
      taskMode: mode,
      text: displayText || undefined,
      textHtml,
      quotedText: options.quotedText,
      quotedSelection: options.quotedSelection ?? null,
      attachments: options.attachments,
      gitContext: options.gitContext ?? undefined,
      requestText,
      requestImages: options.images,
      retryDraft: options.retryDraft ?? null,
    },
  });
  syncOptimisticSessionList(displayText || requestText, sessionPath);
  useStore.setState({ welcomeVisible: false });
  return true;
}

export function resendPromptRequest(
  requestText: string,
  images?: PromptImage[],
  sessionPath?: string | null,
  clientMessageId?: string | null,
): boolean {
  if (!canSendPayload(requestText, images)) {
    return false;
  }

  const state = useStore.getState();
  if (isCurrentSessionStreaming(state)) {
    const message = window.t?.('chat.waitForCurrentReply') ?? '当前回复还没结束，请等本轮结束后再发下一条。';
    state.setInlineNotice?.(message);
    return false;
  }

  const targetSession = sessionPath ?? state.currentSessionPath;
  const ws = getWebSocket();
  if (!targetSession || !ws || ws.readyState !== WebSocket.OPEN) {
    showSidebarToast(window.t?.('chat.needWsConnection') ?? 'Disconnected from assistant', 5000);
    return false;
  }

  const payload: Record<string, unknown> = {
    type: 'prompt',
    text: requestText,
    sessionPath: targetSession,
  };
  if (clientMessageId) {
    payload.clientMessageId = clientMessageId;
  }
  if (images?.length) {
    payload.images = images;
  }
  return sendWebSocketJson(payload);
}
