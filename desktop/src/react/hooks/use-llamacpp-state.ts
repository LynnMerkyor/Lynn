/**
 * use-llamacpp-state.ts — React hook subscribing to the main process's
 * LlamaCppManager + ModelDownloader state via IPC.
 *
 * Backed by:
 *   - main "llamacpp:state" handler (initial hydrate)
 *   - "llamacpp:state" broadcast on manager state transitions
 *   - "llamacpp:download-state" + "llamacpp:download-progress" broadcasts
 *
 * Surface (consumer-friendly, normalised):
 *   {
 *     status: 'idle' | 'starting' | 'ready' | 'standby' | 'unhealthy' | 'crashed'
 *           | 'failed' | 'disabled' | 'needs-binary' | 'needs-model' | 'stopped';
 *     healthy: boolean;
 *     port: number | null;
 *     binaryPath: string | null;
 *     modelPath: string | null;
 *     reason: string | null;
 *     needsBinary: boolean;
 *     needsModel: boolean;
 *     download: {
 *       state: 'idle' | 'downloading' | 'verifying' | 'done' | 'error' | 'paused';
 *       bytesTransferred: number;
 *       totalBytes: number;
 *       percent: number;
 *       activeSource: string | null;
 *       lastError: string | null;
 *       paused: boolean;
 *     };
 *     // mutators
 *     startDownload: () => Promise<{ ok: boolean }>;
 *     pauseDownload: () => Promise<{ ok: boolean }>;
 *     cancelDownload: () => Promise<{ ok: boolean }>;
 *   }
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ManagerState {
  status: string;
  healthy?: boolean;
  port?: number | null;
  activePort?: number | null;
  binaryPath?: string | null;
  modelPath?: string | null;
  expectedPath?: string | null;
  modelId?: string | null;
  reason?: string | null;
  error?: string | null;
  stopped?: boolean;
}

export interface DownloadState {
  state: string;
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  activeSource: string | null;
  paused: boolean;
  lastError: string | null;
  target?: string | null;
  partPath?: string | null;
  modelId?: string | null;
  modelLabel?: string | null;
  fileName?: string | null;
  parallelSegments?: number | null;
  fileIndex?: number | null;
  fileCount?: number | null;
  overallPercent?: number;
  bytesPerSecond?: number;
  etaSeconds?: number | null;
}

export interface LlamaCppStateSnapshot {
  status: string;
  healthy: boolean;
  port: number | null;
  binaryPath: string | null;
  modelPath: string | null;
  reason: string | null;
  error: string | null;
  needsBinary: boolean;
  needsModel: boolean;
  download: DownloadState;
  startDownload: (payload?: { modelId?: string; startAfterDownload?: boolean }) => Promise<{
    ok: boolean;
    alreadyRunning?: boolean;
    reason?: string;
    detail?: string;
    fileCount?: number;
    parallelSegments?: number;
  }>;
  pauseDownload: () => Promise<{ ok: boolean; reason?: string }>;
  cancelDownload: () => Promise<{ ok: boolean; reason?: string }>;
  removeModel: (payload?: { modelId?: string }) => Promise<{ ok: boolean; reason?: string; bytesFreed?: number }>;
}

const DEFAULT_DOWNLOAD: DownloadState = {
  state: 'idle',
  bytesTransferred: 0,
  totalBytes: 0,
  percent: 0,
  activeSource: null,
  paused: false,
  lastError: null,
};

function normaliseManager(raw: ManagerState | null | undefined): {
  status: string; healthy: boolean; port: number | null;
  binaryPath: string | null; modelPath: string | null; reason: string | null; error: string | null;
  needsBinary: boolean; needsModel: boolean;
} {
  const status = String(raw?.status || 'idle');
  const port = (typeof raw?.port === 'number' ? raw.port : typeof raw?.activePort === 'number' ? raw.activePort : null);
  return {
    status,
    healthy: !!raw?.healthy,
    port,
    binaryPath: raw?.binaryPath ?? null,
    modelPath: raw?.modelPath ?? raw?.expectedPath ?? null,
    reason: raw?.reason ?? null,
    error: raw?.error ?? null,
    needsBinary: status === 'needs-binary',
    needsModel: status === 'needs-model',
  };
}

function normaliseDownload(raw: Partial<DownloadState> | null | undefined): DownloadState {
  if (!raw) return { ...DEFAULT_DOWNLOAD };
  return {
    state: String(raw.state ?? 'idle'),
    bytesTransferred: Number(raw.bytesTransferred || 0),
    totalBytes: Number(raw.totalBytes || 0),
    percent: Number(raw.percent || 0),
    activeSource: raw.activeSource ?? null,
    paused: !!raw.paused,
    lastError: raw.lastError ?? null,
    target: raw.target ?? null,
    partPath: raw.partPath ?? null,
    modelId: raw.modelId ?? null,
    modelLabel: raw.modelLabel ?? null,
    fileName: raw.fileName ?? null,
    parallelSegments: typeof raw.parallelSegments === 'number' ? raw.parallelSegments : null,
    fileIndex: typeof raw.fileIndex === 'number' ? raw.fileIndex : null,
    fileCount: typeof raw.fileCount === 'number' ? raw.fileCount : null,
    overallPercent: typeof raw.overallPercent === 'number' ? raw.overallPercent : Number(raw.percent || 0),
    bytesPerSecond: typeof raw.bytesPerSecond === 'number' ? raw.bytesPerSecond : 0,
    etaSeconds: typeof raw.etaSeconds === 'number' ? raw.etaSeconds : null,
  };
}

export function useLlamacppState(): LlamaCppStateSnapshot {
  const [managerState, setManagerState] = useState<ManagerState>({ status: 'idle' });
  const [downloadState, setDownloadState] = useState<DownloadState>({ ...DEFAULT_DOWNLOAD });
  const progressSampleRef = useRef<{
    at: number;
    bytes: number;
    fileIndex: number | null;
    rate: number;
  } | null>(null);

  const updateDownloadState = useCallback((raw: Partial<DownloadState> | null | undefined) => {
    const next = normaliseDownload(raw);
    const now = Date.now();
    const previous = progressSampleRef.current;
    const sameFile = previous && previous.fileIndex === (next.fileIndex ?? null);
    const elapsedSeconds = sameFile ? Math.max(0.001, (now - previous.at) / 1000) : 0;
    const bytesDelta = sameFile ? Math.max(0, next.bytesTransferred - previous.bytes) : 0;
    const instantRate = elapsedSeconds > 0 ? bytesDelta / elapsedSeconds : 0;
    const rate = instantRate > 0
      ? (previous?.rate ? previous.rate * 0.65 + instantRate * 0.35 : instantRate)
      : (previous?.rate || 0);
    next.bytesPerSecond = rate;
    next.etaSeconds = rate > 0 && next.totalBytes > next.bytesTransferred
      ? Math.ceil((next.totalBytes - next.bytesTransferred) / rate)
      : null;
    const fileCount = Math.max(1, Number(next.fileCount || 1));
    const fileIndex = Math.max(1, Math.min(fileCount, Number(next.fileIndex || 1)));
    next.overallPercent = Math.max(0, Math.min(100,
      ((fileIndex - 1) + Math.max(0, Math.min(100, next.percent)) / 100) / fileCount * 100,
    ));
    progressSampleRef.current = {
      at: now,
      bytes: next.bytesTransferred,
      fileIndex: next.fileIndex ?? null,
      rate,
    };
    setDownloadState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Initial hydrate via IPC.
    (async () => {
      try {
        const platform = (window as unknown as { platform?: { llamacppGetState?: () => Promise<{ manager: ManagerState; download: DownloadState }> } }).platform;
        const snap = await platform?.llamacppGetState?.();
        if (cancelled || !snap) return;
        if (snap.manager) setManagerState(snap.manager);
        if (snap.download) updateDownloadState(snap.download);
      } catch (err) {
        console.warn('[useLlamacppState] hydrate failed:', err);
      }
    })();

    // Live subscriptions.
    const platform = (window as unknown as {
      platform?: {
        onLlamacppState?: (cb: (s: ManagerState) => void) => () => void;
        onLlamacppDownloadProgress?: (cb: (s: DownloadState) => void) => () => void;
        onLlamacppDownloadState?: (cb: (s: DownloadState) => void) => () => void;
      };
    }).platform;

    const offState = platform?.onLlamacppState?.((s) => {
      if (!cancelled) setManagerState(s || { status: 'idle' });
    });
    const offProgress = platform?.onLlamacppDownloadProgress?.((s) => {
      if (!cancelled) updateDownloadState(s);
    });
    const offDlState = platform?.onLlamacppDownloadState?.((s) => {
      if (!cancelled) updateDownloadState(s);
    });

    return () => {
      cancelled = true;
      try { offState?.(); } catch { /* ignore */ }
      try { offProgress?.(); } catch { /* ignore */ }
      try { offDlState?.(); } catch { /* ignore */ }
    };
  }, [updateDownloadState]);

  const startDownload = useCallback(async (payload?: { modelId?: string; startAfterDownload?: boolean }): Promise<{
    ok: boolean;
    alreadyRunning?: boolean;
    reason?: string;
    detail?: string;
    fileCount?: number;
    parallelSegments?: number;
  }> => {
    const platform = (window as unknown as {
      platform?: { llamacppStartDownload?: (payload?: { modelId?: string; startAfterDownload?: boolean }) => Promise<{ ok: boolean; alreadyRunning?: boolean; reason?: string; detail?: string; fileCount?: number; parallelSegments?: number }> }
    }).platform;
    try {
      const result = await platform?.llamacppStartDownload?.(payload);
      return result || { ok: false, reason: 'ipc-unavailable' };
    } catch (err) {
      console.warn('[useLlamacppState] startDownload failed:', err);
      return { ok: false, reason: 'ipc-failed', detail: err instanceof Error ? err.message : String(err) };
    }
  }, []);

  const pauseDownload = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    const platform = (window as unknown as { platform?: { llamacppPauseDownload?: () => Promise<{ ok: boolean; reason?: string }> } }).platform;
    try {
      const result = await platform?.llamacppPauseDownload?.();
      return result || { ok: false, reason: 'ipc-unavailable' };
    } catch (err) {
      console.warn('[useLlamacppState] pauseDownload failed:', err);
      return { ok: false, reason: 'ipc-failed' };
    }
  }, []);

  const cancelDownload = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    const platform = (window as unknown as { platform?: { llamacppCancelDownload?: () => Promise<{ ok: boolean; reason?: string }> } }).platform;
    try {
      const result = await platform?.llamacppCancelDownload?.();
      return result || { ok: false, reason: 'ipc-unavailable' };
    } catch (err) {
      console.warn('[useLlamacppState] cancelDownload failed:', err);
      return { ok: false, reason: 'ipc-failed' };
    }
  }, []);

  const removeModel = useCallback(async (payload?: { modelId?: string }): Promise<{ ok: boolean; reason?: string; bytesFreed?: number }> => {
    const platform = (window as unknown as {
      platform?: { llamacppRemoveModel?: (request?: { modelId?: string }) => Promise<{ ok: boolean; reason?: string; bytesFreed?: number }> }
    }).platform;
    try {
      const result = await platform?.llamacppRemoveModel?.(payload);
      return result || { ok: false, reason: 'ipc-unavailable' };
    } catch (err) {
      console.warn('[useLlamacppState] removeModel failed:', err);
      return { ok: false, reason: 'ipc-failed' };
    }
  }, []);

  const normalised = normaliseManager(managerState);
  return {
    ...normalised,
    download: downloadState,
    startDownload,
    pauseDownload,
    cancelDownload,
    removeModel,
  };
}
