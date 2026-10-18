// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OtherModelsSection } from './OtherModelsSection';
import { hanaFetch } from '../../api';

const mocks = vi.hoisted(() => ({
  state: { globalModelsConfig: { search: { provider: '', api_key: '', base_url: '' } }, showToast: vi.fn() },
  save: vi.fn(),
}));
vi.mock('../../store', () => ({ useSettingsStore: () => mocks.state }));
vi.mock('../../helpers', () => ({ t: (key: string) => key, lookupModelMeta: vi.fn(), formatContext: vi.fn(), autoSaveGlobalModels: mocks.save }));
vi.mock('../../actions', () => ({ loadSettingsConfig: vi.fn() }));
vi.mock('../../api', () => ({ hanaFetch: vi.fn() }));
vi.mock('../../widgets/ModelWidget', () => ({ ModelWidget: () => null }));
vi.mock('../../widgets/SelectWidget', () => ({ SelectWidget: ({ options, value, onChange }: { options: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void }) => <select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.state.globalModelsConfig.search = { provider: '', api_key: '', base_url: '' };
  mocks.save.mockClear();
  vi.mocked(hanaFetch).mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

it('does not save a stale verification after the selected provider changes', async () => {
  mocks.state.globalModelsConfig.search = { provider: 'tavily', api_key: 'test-old', base_url: '' };
  let finish!: (value: Response) => void;
  vi.mocked(hanaFetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<OtherModelsSection providers={{}} />));
  const verify = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'settings.search.verify')!;
  await act(async () => verify.click());
  expect(JSON.parse(String(vi.mocked(hanaFetch).mock.calls[0][1]?.body))).toMatchObject({ provider: 'tavily', save: false });
  expect(verify.disabled).toBe(true);
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = 'deepseek'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => finish(new Response(JSON.stringify({ ok: true }))));
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save).toHaveBeenCalledWith({ search: { provider: 'deepseek', api_key: '', base_url: '' } });
});

it('saves a successful verification only for the unchanged selection', async () => {
  mocks.state.globalModelsConfig.search = { provider: 'deepseek', api_key: 'test-own', base_url: '' };
  vi.mocked(hanaFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  await act(async () => root.render(<OtherModelsSection providers={{}} />));
  const verify = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'settings.search.verify')!;
  await act(async () => verify.click());
  expect(mocks.save).toHaveBeenCalledWith({ search: { provider: 'deepseek', api_key: 'test-own', base_url: '' } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('defaults to cloud search and offers a separate DeepSeek BYOK option', async () => {
  await act(async () => root.render(<OtherModelsSection providers={{ userModel: { models: ['own-model'] } }} />));
  expect(host.querySelector('select')?.value).toBe('');
  expect(host.textContent).toContain('settings.api.searchCloudDefault');
  expect(host.textContent).toContain('DeepSeek Search (BYOK)');
  expect(host.textContent).toContain('settings.api.searchRoutingHint');
  const verify = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'settings.search.verify');
  expect(verify?.disabled).toBe(true);
});

it('clears the old provider key before delayed preference refresh', async () => {
  mocks.state.globalModelsConfig.search = { provider: 'tavily', api_key: 'old-search-secret', base_url: '' };
  await act(async () => root.render(<OtherModelsSection providers={{}} />));
  expect(host.querySelector('input[type="password"]')?.getAttribute('value')).toBe('old-search-secret');
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = 'deepseek'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(mocks.save).toHaveBeenCalledWith({ search: { provider: 'deepseek', api_key: '', base_url: '' } });
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  await act(async () => root.render(<OtherModelsSection providers={{}} />));
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
});
