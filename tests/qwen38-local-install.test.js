import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const catalog = require('../shared/qwen38-local-models.json');
const { recommendLocalModel } = require('../shared/local-model-hardware.cjs');
const { resolveLlamacppDownloadProfile, buildLlamacppArgsForAlias } = require('../desktop/llamacpp-profiles.cjs');
const { runtimeUsesProfile, createLocalModelController } = require('../desktop/local-model-controller.cjs');
const { selectRuntimeAsset, safeArchiveEntry } = require('../desktop/llamacpp-runtime-installer.cjs');
const { LlamaCppManager } = require('../desktop/llamacpp-manager.cjs');
const { ModelDownloader } = require('../desktop/model-downloader.cjs');
const dedicated = (memory, totalMemoryGib = 64) => recommendLocalModel({ platform: 'win32', arch: 'x64', totalMemoryGib, gpus: memory.map(memory_gib => ({ memory_gib })) });
const temporaryHomes = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function installationHarness(installRuntime = async () => '/test/runtime') {
  const handlers = new Map();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-install-control-'));
  temporaryHomes.push(home);
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 1024 ** 3, bsize: 4096 });
  vi.spyOn(LlamaCppManager.prototype, 'resolveBinaryPath').mockReturnValue(null);
  const onModelReady = vi.fn();
  createLocalModelController({
    BrowserWindow: { getAllWindows: () => [] }, shell: {}, lynnHome: home, installRuntime, onModelReady,
    wrapIpcHandler: (name, handler) => handlers.set(name, handler),
  });
  return { handlers, onModelReady, state: () => handlers.get('llamacpp:state')().download };
}

describe('hardware-adaptive EfficientThink installation', () => {
  it.each([24, 32, 48, 80])('recommends Q3 for a %s GiB card', memory => {
    expect(dedicated([memory]).recommended_model_id).toBe(catalog.defaultModelId);
  });
  it('recommends Q2 for a 16 GiB card', () => expect(dedicated([16]).recommended_model_id).toBe(catalog.q2ModelId));
  it('does not mistake host RAM or summed cards for VRAM', () => {
    expect(dedicated([8], 128).can_enable).toBe(false);
    expect(dedicated([8, 8], 128).can_enable).toBe(false);
    expect(dedicated([], 128).recommended_model_id).toBeNull();
  });
  it('recognizes Apple unified memory, not Intel Mac host RAM', () => {
    expect(recommendLocalModel({ platform: 'darwin', arch: 'arm64', totalMemoryGib: 16 }).can_enable).toBe(false);
    expect(recommendLocalModel({ platform: 'darwin', arch: 'arm64', totalMemoryGib: 24 }).recommended_model_id).toBe(catalog.defaultModelId);
    expect(recommendLocalModel({ platform: 'darwin', arch: 'x64', totalMemoryGib: 64 }).can_enable).toBe(false);
  });
  it.each(catalog.tiers)('pairs $quantization with a separately verified Q4 DFlash2 file', tier => {
    const { profile } = resolveLlamacppDownloadProfile(tier.modelId);
    expect(profile.files).toHaveLength(2);
    expect(profile.files[0]).toMatchObject({ role: 'main', expectedSize: tier.expectedSize, expectedSha256: tier.expectedSha256 });
    expect(profile.files[1]).toMatchObject({ role: 'draft', expectedSize: 1143006720, expectedSha256: 'e83676f81b6604331d02e004a50689eded7fa905c7e83468e5a376cc27abcad4' });
    for (const file of profile.files) {
      expect(file.sources[0].url).toBe(`${catalog.modelCardUrl}/resolve/${catalog.revision}/${file.fileName}`);
      expect(file.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const modelsRoot = path.join(os.tmpdir(), '模型 空间');
    const launch = buildLlamacppArgsForAlias(tier.modelId, path.join(modelsRoot, tier.fileName));
    expect(launch.alias).toBe(tier.modelId);
    const value = flag => launch.args[launch.args.indexOf(flag) + 1];
    expect(value('--ctx-size')).toBe(String(tier.contextSize));
    expect(value('--parallel')).toBe('1');
    expect(value('--spec-type')).toBe('draft-dflash');
    expect(value('--model-draft')).toBe(path.join(modelsRoot, tier.directory, catalog.draft.fileName));
    expect(launch.args).not.toContain('draft-mtp');
    expect(runtimeUsesProfile({ modelPath: value('--model-draft') }, modelsRoot, profile)).toBe(false);
  });
  it('does not relabel legacy Q4 as the new Q3', () => {
    const id = 'qwen36-27b-dsv4pro-coding-q4-mtp';
    expect(resolveLlamacppDownloadProfile(id).profile.modelId).toBe(id);
    const launch = buildLlamacppArgsForAlias(id, '/models/Q4-imatrix-MTP-00001-of-00004.gguf');
    expect(launch.alias).toBe(id);
    expect(launch.args).toContain('draft-mtp');
    expect(launch.args).not.toContain('draft-dflash');
  });
  it.each([['darwin','arm64'],['darwin','x64'],['win32','x64'],['linux','x64'],['linux','arm64']])('pins verified runtime metadata for %s/%s', (platform, arch) => {
    const asset = selectRuntimeAsset(platform, arch);
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(asset.size).toBeGreaterThan(0);
    expect(asset.url).toMatch(/^https:\/\/github.com\/ggml-org\/llama\.cpp\/releases\/download\/b10809\//);
  });
  it('rejects unsupported runtime targets and archive traversal', () => {
    expect(selectRuntimeAsset('win32', 'ia32')).toBeNull();
    for (const entry of ['../evil', '/etc/passwd', 'C:\\evil', 'bin/../../evil']) expect(safeArchiveEntry(entry)).toBe(false);
    expect(safeArchiveEntry('build/bin/llama-server')).toBe(true);
  });
  it('hands off a bounded, redacted draft without sending a conversation', async () => {
    const handlers = new Map();
    const events = [];
    const main = { isDestroyed: () => false, show() { events.push('show'); }, focus() {}, webContents: { send(channel) { events.push(channel); } } };
    createLocalModelController({
      BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
      getMainWindow: () => main, shell: {}, lynnHome: '/unused-test-home',
      wrapIpcHandler: (name, handler) => handlers.set(name, handler),
    });
    expect(await handlers.get('local-model:request-help')({}, { modelId: catalog.q2ModelId, hardware: { accelerator_memory_gib: 16 }, error: 'Bearer secret-token' })).toEqual({ ok: true });
    const result = await handlers.get('local-model:consume-help')();
    expect(result.prompt).toContain('Q2 + Q4 DFlash2');
    expect(result.prompt).toContain('16.0 GiB');
    expect(result.prompt).not.toContain('secret-token');
    expect(result.prompt).toContain('先说明用途并征得确认');
    expect(events).toEqual(['show', 'local-model:help-ready']);
    expect(await handlers.get('local-model:consume-help')()).toEqual({ prompt: null });
    expect(await handlers.get('llamacpp:start-custom-model')({}, { modelPath: '/models/dflash2-qwen38-27b-Q4_K_M.gguf' })).toMatchObject({ ok: false, reason: 'not-main-model' });
  });
  it('does not download weights when compatible runtime preparation fails', async () => {
    const start = vi.spyOn(ModelDownloader.prototype, 'start');
    const h = installationHarness(async () => { throw new Error('runtime-checksum-mismatch'); });
    await h.handlers.get('llamacpp:start-download')({}, { modelId: catalog.q2ModelId, startAfterDownload: true });
    await vi.waitFor(() => expect(h.state().state).toBe('error'));
    expect(h.state().lastError).toBe('runtime-checksum-mismatch');
    expect(start).not.toHaveBeenCalled();
    expect(h.onModelReady).not.toHaveBeenCalled();
  });
  it('does not launch or switch models after a draft-file checksum failure', async () => {
    const download = vi.spyOn(ModelDownloader.prototype, 'start').mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'checksum-mismatch' });
    const launch = vi.spyOn(LlamaCppManager.prototype, 'start');
    const h = installationHarness();
    await h.handlers.get('llamacpp:start-download')({}, { modelId: catalog.defaultModelId, startAfterDownload: true });
    await vi.waitFor(() => expect(h.state().state).toBe('error'));
    expect(download).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
    expect(h.onModelReady).not.toHaveBeenCalled();
  });
  it('stops the active download immediately and never starts the next file', async () => {
    let finish;
    const download = vi.spyOn(ModelDownloader.prototype, 'start').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const cancel = vi.spyOn(ModelDownloader.prototype, 'cancel').mockImplementation(() => finish({ ok: false, reason: 'cancelled' }));
    const h = installationHarness();
    await h.handlers.get('llamacpp:start-download')({}, { modelId: catalog.q2ModelId, startAfterDownload: true });
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    await h.handlers.get('llamacpp:stop')();
    expect(cancel).toHaveBeenCalledOnce();
    await new Promise(resolve => setImmediate(resolve));
    expect(download).toHaveBeenCalledOnce();
    expect(h.onModelReady).not.toHaveBeenCalled();
  });
});
