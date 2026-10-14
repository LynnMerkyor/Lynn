// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelTimeoutSettings } from './ModelTimeoutSettings';
import { hanaFetch } from '../api';
import { modelTimeoutDiagnostics } from '../../../../../core/agent-runtime/model-call-timeouts.js';

vi.mock('../api', () => ({ hanaFetch: vi.fn() }));
let host: HTMLDivElement;
let root: Root;
const configured = { firstChunkMs: 300_000, idleMs: 120_000, totalMs: 0 };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(hanaFetch).mockResolvedValue(Response.json({ configured, effective: { ...configured, idleMs: 180_000 }, brainEffective: configured, diagnostics: modelTimeoutDiagnostics(configured) }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('shows saved seconds and effective env overrides and persists edited milliseconds', async () => {
  await act(async () => root.render(<ModelTimeoutSettings />));
  const inputs = host.querySelectorAll('input');
  expect(Array.from(inputs).map(input => input.value)).toEqual(['300', '120', '0']);
  expect(host.textContent).toContain('300 / 180 / 0');
  expect(host.querySelector('details')?.textContent).toContain('cliBrainHeaders');
  expect(host.querySelector('details')?.textContent).toContain('preferences.model_call_timeouts');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[0], '600');
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  });
  vi.mocked(hanaFetch).mockResolvedValueOnce(Response.json({ configured: { ...configured, firstChunkMs: 600_000 }, effective: configured, brainEffective: configured }));
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const request = vi.mocked(hanaFetch).mock.calls.find(([, options]) => options?.method === 'PUT')!;
  expect(JSON.parse(String(request[1]?.body))).toEqual({ ...configured, firstChunkMs: 600_000 });
  expect(host.querySelector('[role="status"]')?.textContent).toContain('已保存');
});

it('does not claim save success on server failure', async () => {
  await act(async () => root.render(<ModelTimeoutSettings />));
  vi.mocked(hanaFetch).mockResolvedValueOnce(Response.json({ error: 'Disk full' }, { status: 500 }));
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Disk full');
  expect(host.textContent).not.toContain('已保存');
});
