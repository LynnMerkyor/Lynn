import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEvent } from 'react';

const mocks = vi.hoisted(() => ({
  files: [] as Array<{ path: string; uploadId?: string }>,
  fetch: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock('../stores', () => ({ useStore: { getState: () => ({ attachedFiles: mocks.files, addToast: mocks.toast }) } }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.fetch }));

import { useAttachmentHandlers } from '../components/input/useAttachmentHandlers';

function fixture(size = 203, supportsVision = true, name = 'notes.md') {
  const add = vi.fn((file) => mocks.files.push(file));
  const warn = vi.fn();
  const handlers = useAttachmentHandlers({ addAttachedFile: add, setComposerTextFromEvent: vi.fn(), supportsVision,
    t: () => 'Upload failed', warnVisionUnsupported: warn });
  const event = { target: { files: [{ name, size, type: name.endsWith('.png') ? 'image/png' : 'text/markdown' }], value: 'selected' } } as unknown as ChangeEvent<HTMLInputElement>;
  return { ...handlers, event, add, warn };
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.files.length = 0;
  vi.stubGlobal('window', { platform: { getFilePath: vi.fn().mockResolvedValue('/selected/notes.md') } });
});
afterEach(() => vi.unstubAllGlobals());

describe('native attachment selection', () => {
  it('retains the server-issued upload ID for binding to the session at send time', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ uploads: [{ src: '/selected/notes.md', dest: '/staging/notes_1.md', uploadId: 'issued-upload-1' }] }) });
    const f = fixture(); await f.handleFileInputChange(f.event);
    expect(mocks.fetch).toHaveBeenCalledWith('/api/upload', expect.objectContaining({ body: JSON.stringify({ paths: ['/selected/notes.md'] }) }));
    expect(f.add).toHaveBeenCalledWith({ path: '/staging/notes_1.md', name: 'notes.md', uploadId: 'issued-upload-1' });
    expect(f.event.target.value).toBe('');
  });

  it('does not attach an unbound path when staging fails', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'disk unavailable' }) });
    const f = fixture(); await f.handleFileInputChange(f.event);
    expect(f.add).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('disk unavailable', 'error');
  });

  it('requires an upload ID even if a staging path was returned', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ uploads: [{ src: '/selected/notes.md', dest: '/staging/notes_1.md' }] }) });
    const f = fixture(); await f.handleFileInputChange(f.event);
    expect(f.add).not.toHaveBeenCalled(); expect(mocks.toast).toHaveBeenCalled();
  });

  it('keeps oversized native files on the existing local path', async () => {
    const f = fixture(50 * 1024 * 1024 + 1); await f.handleFileInputChange(f.event);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(f.add).toHaveBeenCalledWith({ path: '/selected/notes.md', name: 'notes.md' });
  });

  it('preserves the vision guard before staging images', async () => {
    const f = fixture(203, false, 'image.png'); await f.handleFileInputChange(f.event);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled(); expect(f.warn).toHaveBeenCalledOnce();
  });
});
