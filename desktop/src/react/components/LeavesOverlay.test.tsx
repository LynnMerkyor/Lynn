// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeavesOverlay, LeavesOverlayHint } from './LeavesOverlay';
import { LEAVES_OVERLAY_STORAGE_KEY, setLeavesOverlayEnabled } from '../hooks/use-leaves-overlay';

let host: HTMLDivElement;
let root: Root;
let motion: EventTarget & { matches: boolean };
const render = () => act(async () => { root.render(<><LeavesOverlay /><LeavesOverlayHint /></>); });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'warm-paper');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => motion);
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

describe('Tree-shadow motion and user control', () => {
  it('animates by default and provides a settings shortcut with the off path', async () => {
    await render();
    expect(host.querySelector('img')).not.toBeNull();
    expect(host.querySelector('[data-lynn-leaves-overlay]')?.getAttribute('data-paused')).toBe('false');
    expect(localStorage.getItem(LEAVES_OVERLAY_STORAGE_KEY)).toBeNull();
    const hint = host.querySelector<HTMLButtonElement>('[data-lynn-leaves-settings]')!;
    expect(document.getElementById(hint.getAttribute('aria-describedby')!)?.textContent).toContain('设置 → 界面 → 外观');
    await act(async () => hint.click());
    expect(window.platform.openSettings).toHaveBeenCalledWith('interface');
  });

  it('honors an explicit off choice on mount, across updates, and after remount', async () => {
    localStorage.setItem(LEAVES_OVERLAY_STORAGE_KEY, '0');
    await render();
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[data-lynn-leaves-settings]')).toBeNull();
    await act(async () => setLeavesOverlayEnabled(true));
    expect(host.querySelector('img')).not.toBeNull();
    await act(async () => setLeavesOverlayEnabled(false));
    expect(host.querySelector('img')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(host.querySelector('img')).toBeNull();
  });

  it('updates both decoration and guidance when another window changes the preference', async () => {
    await render();
    await act(async () => {
      localStorage.setItem(LEAVES_OVERLAY_STORAGE_KEY, '0');
      window.dispatchEvent(new StorageEvent('storage', { key: LEAVES_OVERLAY_STORAGE_KEY, newValue: '0' }));
    });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[data-lynn-leaves-settings]')).toBeNull();
  });

  it('pauses in the background and resumes when the document becomes visible', async () => {
    await render();
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(host.querySelector('[data-lynn-leaves-overlay]')?.getAttribute('data-paused')).toBe('true');
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(host.querySelector('[data-lynn-leaves-overlay]')?.getAttribute('data-paused')).toBe('false');
  });

  it('keeps a still frame for reduced motion and responds to live preference changes', async () => {
    motion.matches = true;
    await render();
    expect(host.querySelector('img')).not.toBeNull();
    expect(host.querySelector('[data-lynn-leaves-overlay]')?.getAttribute('data-paused')).toBe('true');
    await act(async () => { motion.matches = false; motion.dispatchEvent(new Event('change')); });
    expect(host.querySelector('[data-lynn-leaves-overlay]')?.getAttribute('data-paused')).toBe('false');
    await act(async () => { motion.matches = true; motion.dispatchEvent(new Event('change')); });
    expect(host.querySelector('[data-lynn-leaves-overlay]')?.getAttribute('data-paused')).toBe('true');
  });

  it.each(['midnight', 'high-contrast'])('removes the texture in the %s theme and recovers in warm paper', async (theme) => {
    await render();
    await act(async () => { document.documentElement.setAttribute('data-theme', theme); });
    expect(host.querySelector('img')).toBeNull();
    await act(async () => { document.documentElement.setAttribute('data-theme', 'warm-paper'); });
    expect(host.querySelector('img')).not.toBeNull();
  });

  it('removes a failed texture, preserves the off switch and allows an explicit retry', async () => {
    await render();
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[data-lynn-leaves-settings]')).not.toBeNull();
    await act(async () => setLeavesOverlayEnabled(false));
    await act(async () => setLeavesOverlayEnabled(true));
    expect(host.querySelector('img')).not.toBeNull();
  });
});
