// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeavesOverlay, LeavesOverlayHint } from './LeavesOverlay';
import { LEAVES_OVERLAY_STORAGE_KEY, setLeavesOverlayEnabled } from '../hooks/use-leaves-overlay';

let host: HTMLDivElement;
let root: Root;
let motion: EventTarget & { matches: boolean };
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
const render = () => act(async () => { root.render(<><LeavesOverlay /><LeavesOverlayHint /></>); });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'warm-paper');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => motion);
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  window.t = ((key: string) => key.endsWith('CloseHint') ? '设置 → 界面 → 外观 → 窗边树影' : key) as typeof window.t;
  window.platform = { openSettings: vi.fn() } as unknown as typeof window.platform;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Tree-shadow playback and user control', () => {
  it('plays silently by default and provides a settings shortcut with the off path', async () => {
    await render();
    const video = host.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.muted && video.loop && video.playsInline).toBe(true);
    expect(play).toHaveBeenCalled();
    expect(localStorage.getItem(LEAVES_OVERLAY_STORAGE_KEY)).toBeNull();
    const hint = host.querySelector<HTMLButtonElement>('[data-lynn-leaves-settings]')!;
    expect(document.getElementById(hint.getAttribute('aria-describedby')!)?.textContent).toContain('设置 → 界面 → 外观');
    await act(async () => hint.click());
    expect(window.platform.openSettings).toHaveBeenCalledWith('interface');
  });

  it('honors an explicit off choice on mount, across updates, and after remount', async () => {
    localStorage.setItem(LEAVES_OVERLAY_STORAGE_KEY, '0');
    await render();
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('[data-lynn-leaves-settings]')).toBeNull();
    expect(play).not.toHaveBeenCalled();
    await act(async () => setLeavesOverlayEnabled(true));
    expect(host.querySelector('video')).not.toBeNull();
    await act(async () => setLeavesOverlayEnabled(false));
    expect(host.querySelector('video')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(host.querySelector('video')).toBeNull();
  });

  it('updates both decoration and guidance when another window changes the preference', async () => {
    await render();
    await act(async () => {
      localStorage.setItem(LEAVES_OVERLAY_STORAGE_KEY, '0');
      window.dispatchEvent(new StorageEvent('storage', { key: LEAVES_OVERLAY_STORAGE_KEY, newValue: '0' }));
    });
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('[data-lynn-leaves-settings]')).toBeNull();
  });

  it('pauses in the background and resumes when the document becomes visible', async () => {
    await render();
    play.mockClear(); pause.mockClear();
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(pause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(play).toHaveBeenCalled();
  });

  it('keeps a still frame for reduced motion and responds to live preference changes', async () => {
    motion.matches = true;
    await render();
    expect(host.querySelector('video')).not.toBeNull();
    expect(play).not.toHaveBeenCalled();
    await act(async () => { motion.matches = false; motion.dispatchEvent(new Event('change')); });
    expect(play).toHaveBeenCalled();
    pause.mockClear(); play.mockClear();
    await act(async () => { motion.matches = true; motion.dispatchEvent(new Event('change')); });
    expect(pause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it.each(['midnight', 'high-contrast'])('stops video decoding in the %s theme and recovers in warm paper', async (theme) => {
    await render();
    await act(async () => { document.documentElement.setAttribute('data-theme', theme); });
    expect(host.querySelector('video')).toBeNull();
    expect(pause).toHaveBeenCalled();
    await act(async () => { document.documentElement.setAttribute('data-theme', 'warm-paper'); });
    expect(host.querySelector('video')).not.toBeNull();
  });

  it('contains autoplay rejection and lets users still reach the off switch', async () => {
    play.mockRejectedValue(new DOMException('Autoplay blocked', 'NotAllowedError'));
    await render();
    expect(host.querySelector('[data-lynn-leaves-settings]')).not.toBeNull();
  });

  it('removes an undecodable video and allows a later explicit retry', async () => {
    await render();
    await act(async () => { host.querySelector('video')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('video')).toBeNull();
    await act(async () => setLeavesOverlayEnabled(false));
    await act(async () => setLeavesOverlayEnabled(true));
    expect(host.querySelector('video')).not.toBeNull();
  });
});
