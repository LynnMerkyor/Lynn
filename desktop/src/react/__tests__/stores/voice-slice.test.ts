import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSlice, type VoiceSlice } from '../../stores/voice-slice';

function installLocalStorageMock(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }),
    clear: vi.fn(() => { data.clear(); }),
  };
  vi.stubGlobal('localStorage', storage);
  return storage;
}

function makeSlice(): VoiceSlice {
  let state: VoiceSlice;
  const set = (partial: Partial<VoiceSlice>) => {
    state = { ...state, ...partial };
  };
  state = createVoiceSlice(set);
  return new Proxy({} as VoiceSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('voice-slice', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses safe defaults when localStorage is empty', () => {
    installLocalStorageMock();
    const slice = makeSlice();
    expect(slice.ttsAutoPrefetch).toBe(false);
    expect(slice.ttsStreamingEnabled).toBe(true);
    expect(slice.ttsBrowserFallbackEnabled).toBe(true);
    expect(slice.ttsProviderPreference).toBe(null);
  });

  it('reads persisted preferences', () => {
    installLocalStorageMock({
      'lynn-tts-auto-prefetch': '1',
      'lynn-tts-streaming-enabled': '0',
      'lynn-tts-browser-fallback-enabled': '0',
    });
    const slice = makeSlice();
    expect(slice.ttsAutoPrefetch).toBe(true);
    expect(slice.ttsStreamingEnabled).toBe(false);
    expect(slice.ttsBrowserFallbackEnabled).toBe(false);
  });

  it('persists toggles through setters', () => {
    const storage = installLocalStorageMock();
    const slice = makeSlice();
    slice.setTtsAutoPrefetch(true);
    slice.setTtsStreamingEnabled(false);
    slice.setTtsBrowserFallbackEnabled(false);

    expect(slice.ttsAutoPrefetch).toBe(true);
    expect(slice.ttsStreamingEnabled).toBe(false);
    expect(slice.ttsBrowserFallbackEnabled).toBe(false);
    expect(storage.setItem).toHaveBeenCalledWith('lynn-tts-auto-prefetch', '1');
    expect(storage.setItem).toHaveBeenCalledWith('lynn-tts-streaming-enabled', '0');
    expect(storage.setItem).toHaveBeenCalledWith('lynn-tts-browser-fallback-enabled', '0');
  });
});
