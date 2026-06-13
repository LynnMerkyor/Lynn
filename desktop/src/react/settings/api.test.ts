import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hanaFetch, hanaUrl } from './api';
import { useSettingsStore } from './store';

describe('settings hana api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    useSettingsStore.setState({ serverPort: null, serverToken: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSettingsStore.setState({ serverPort: null, serverToken: null });
  });

  it('does not construct a localhost:null URL while the server port is not ready', async () => {
    expect(() => hanaUrl('/api/providers/summary')).toThrow('settings server is not ready');
    await expect(hanaFetch('/api/providers/summary')).rejects.toThrow('settings server is not ready');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('constructs requests only after the settings server port is ready', async () => {
    useSettingsStore.setState({ serverPort: 3210, serverToken: 'tok' });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    expect(hanaUrl('/api/providers/summary')).toBe('http://127.0.0.1:3210/api/providers/summary');
    await hanaFetch('/api/providers/summary');

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3210/api/providers/summary',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tok' },
      }),
    );
  });
});
