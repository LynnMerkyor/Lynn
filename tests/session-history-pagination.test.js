import { expect, it } from 'vitest';
import { createSessionsRoute } from '../server/routes/sessions.js';

function route(count) {
  return createSessionsRoute({ agentsDir: '/tmp', currentSessionPath: null,
    messages: Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` })),
  });
}
it('starts with the latest 80 messages and pages backwards without gaps', async () => {
  const api = route(140);
  const latest = await (await api.request('/sessions/messages?limit=80')).json();
  expect(latest.messages).toHaveLength(80);
  expect(latest.messages[0].id).toBe('60');
  expect(latest.nextBefore).toBe('60');
  expect(latest.hasMore).toBe(true);
  const older = await (await api.request(`/sessions/messages?limit=80&before=${latest.nextBefore}`)).json();
  expect(older.messages).toHaveLength(60);
  expect(older.messages.at(-1).id).toBe('59');
  expect(older.nextBefore).toBe('0');
  expect(older.hasMore).toBe(false);
});
it('keeps legacy unpaginated callers compatible and clamps explicit limits', async () => {
  const api = route(500);
  expect((await (await api.request('/sessions/messages')).json()).messages).toHaveLength(500);
  expect((await (await api.request('/sessions/messages?limit=9999')).json()).messages).toHaveLength(200);
  expect((await (await api.request('/sessions/messages?limit=80&before=0')).json()).messages).toEqual([]);
});
