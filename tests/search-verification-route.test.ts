import { afterEach, expect, it, vi } from 'vitest';
import { createConfigRoute } from '../server/routes/config.js';

vi.mock('../lib/tools/web-search.js', () => ({ verifySearchKey: vi.fn().mockResolvedValue(true) }));
afterEach(() => vi.clearAllMocks());

it.each([false, true])('verification save=%s controls persistence', async save => {
  const engine = { setSearchConfig: vi.fn(), updateConfig: vi.fn().mockResolvedValue(undefined) };
  const route = createConfigRoute(engine as unknown as Parameters<typeof createConfigRoute>[0]);
  const response = await route.request('/search/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek', api_key: 'test-placeholder', save }),
  });
  expect(await response.json()).toMatchObject({ ok: true });
  expect(engine.setSearchConfig).toHaveBeenCalledTimes(save ? 1 : 0);
  expect(engine.updateConfig).toHaveBeenCalledTimes(save ? 1 : 0);
});
