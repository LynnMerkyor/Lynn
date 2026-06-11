// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtsControlButton } from './TtsControlButton';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { playTtsSpeechStream } from '../../services/tts-stream-playback';
import { createVoiceWsClientFromPlatform } from '../../services/voice-ws-client';

const voiceWsMock = vi.hoisted(() => ({
  create: vi.fn(),
  speakText: vi.fn(),
  interrupt: vi.fn(),
  destroy: vi.fn(),
}));

const addToast = vi.fn();
const storeState = {
  addToast,
  ttsAutoPrefetch: false,
  ttsStreamingEnabled: true,
  ttsBrowserFallbackEnabled: true,
};

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../services/tts-stream-playback', () => ({
  playTtsSpeechStream: vi.fn(),
}));

vi.mock('../../services/voice-ws-client', () => ({
  VOICE_STATE: { IDLE: 'idle' },
  createVoiceWsClientFromPlatform: voiceWsMock.create,
}));

vi.mock('../../stores', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

function deferredSpeech() {
  let end: (() => void) | null = null;
  const speak = vi.fn((utterance: SpeechSynthesisUtterance) => {
    end = () => utterance.onend?.(new Event('end') as SpeechSynthesisEvent);
  });
  return {
    speechSynthesis: {
      speaking: false,
      cancel: vi.fn(),
      speak,
    },
    finish: () => end?.(),
  };
}

describe('TtsControlButton fallback playback', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    addToast.mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(playTtsSpeechStream).mockReset();
    vi.mocked(createVoiceWsClientFromPlatform).mockReset();
    voiceWsMock.speakText.mockReset();
    voiceWsMock.interrupt.mockReset();
    voiceWsMock.destroy.mockReset();
    voiceWsMock.speakText.mockResolvedValue(true);
    voiceWsMock.interrupt.mockResolvedValue(true);
    voiceWsMock.create.mockResolvedValue({
      speakText: voiceWsMock.speakText,
      interrupt: voiceWsMock.interrupt,
      destroy: voiceWsMock.destroy,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    storeState.ttsStreamingEnabled = true;
    storeState.ttsBrowserFallbackEnabled = true;
    (window as unknown as { SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance = class {
      text: string;
      lang = '';
      rate = 1;
      onend: ((event: SpeechSynthesisEvent) => void) | null = null;
      onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
      constructor(text: string) { this.text = text; }
    } as typeof SpeechSynthesisUtterance;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('uses StepFun Realtime voice-ws before the legacy tts bridge', async () => {
    await act(async () => {
      root.render(<TtsControlButton plainText="你好,这是 StepFun Realtime 朗读主链测试" isStreamingMessage={false} />);
    });

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createVoiceWsClientFromPlatform).toHaveBeenCalledTimes(1);
    expect(voiceWsMock.speakText).toHaveBeenCalledWith('你好,这是 StepFun Realtime 朗读主链测试');
    expect(playTtsSpeechStream).not.toHaveBeenCalled();
    expect(hanaFetch).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('StepFun Realtime'), 'success');
  });

  it('falls back to browser speech on a normal click when service TTS has no playable audio', async () => {
    const browser = deferredSpeech();
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: browser.speechSynthesis });
    vi.mocked(createVoiceWsClientFromPlatform).mockRejectedValueOnce(new Error('voice ws unavailable'));
    vi.mocked(playTtsSpeechStream).mockRejectedValueOnce(new Error('stream unavailable'));
    vi.mocked(hanaFetch).mockResolvedValueOnce({ json: async () => ({ details: { ok: false } }) } as Response);

    await act(async () => {
      root.render(<TtsControlButton plainText="你好,这是朗读回退测试" isStreamingMessage={false} />);
    });
    const button = container.querySelector('button');
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(playTtsSpeechStream).toHaveBeenCalledTimes(1);
    expect(hanaFetch).toHaveBeenCalledWith('/api/tools/tts-bridge.tts_speak', expect.objectContaining({ method: 'POST' }));
    expect(browser.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('浏览器朗读'), 'info');
  });

  it('keeps browser speech disabled when the fallback preference is off', async () => {
    const browser = deferredSpeech();
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: browser.speechSynthesis });
    storeState.ttsBrowserFallbackEnabled = false;
    vi.mocked(createVoiceWsClientFromPlatform).mockRejectedValueOnce(new Error('voice ws unavailable'));
    vi.mocked(playTtsSpeechStream).mockRejectedValueOnce(new Error('stream unavailable'));
    vi.mocked(hanaFetch).mockResolvedValueOnce({ json: async () => ({ details: { ok: false } }) } as Response);

    await act(async () => {
      root.render(<TtsControlButton plainText="你好,这是朗读回退测试" isStreamingMessage={false} />);
    });

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(browser.speechSynthesis.speak).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('TTS 返回缺失 path', 'error');
  });
});
