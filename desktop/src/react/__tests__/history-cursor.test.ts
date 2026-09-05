import { expect, it } from 'vitest';
import { createChatSlice, type ChatSlice } from '../stores/chat-slice';
it('advances the server cursor even when all messages in a page are filtered', () => {
  let state: ChatSlice;
  state = createChatSlice((patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; }, () => state);
  state.initSession('/history', [], true, '160');
  expect(state.chatSessions['/history'].oldestId).toBe('160');
  state.prependItems('/history', [], true, '80');
  expect(state.chatSessions['/history'].oldestId).toBe('80');
  state.prependItems('/history', [], false, '0');
  expect(state.chatSessions['/history'].hasMore).toBe(false);
});
