import { expect, it } from 'vitest';
import { streamRenderInterval } from '../utils/stream-render-budget';
it('keeps short answers fast and bounds full-text parsing for large responses', () => {
  expect([1000, 12000, 40000, 100000, 500000].map(streamRenderInterval)).toEqual([32, 100, 200, 400, 400]);
});
