import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map();

const { setIpcMainForTests, setIpcSenderValidator, wrapIpcHandler } = await import('../desktop/ipc-wrapper.cjs');

describe('IPC handler error contract', () => {
  beforeEach(() => {
    handlers.clear();
    setIpcMainForTests({
      handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
      on: vi.fn(),
    });
    setIpcSenderValidator(null);
  });

  it('returns successful handler results unchanged', async () => {
    wrapIpcHandler('ok', async (_event, value) => ({ value }));
    await expect(handlers.get('ok')({}, 7)).resolves.toEqual({ value: 7 });
  });

  it('rejects renderer invokes with a trace id instead of returning undefined', async () => {
    wrapIpcHandler('broken', async () => { throw new Error('disk failed'); });
    await expect(handlers.get('broken')({})).rejects.toThrow(/^IPC broken failed \(trace [a-f0-9]{8}\)$/u);
  });

  it('rejects an untrusted sender', async () => {
    setIpcSenderValidator(() => false);
    wrapIpcHandler('private', async () => 'secret');
    await expect(handlers.get('private')({})).rejects.toThrow('IPC request rejected: private');
  });
});
