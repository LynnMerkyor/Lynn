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

import { useCallback, useEffect, useState } from 'react';

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
}

export interface LlamaCppStateSnapshot {
  status: string;
  healthy: boolean;
  port: number | null;
  binaryPath: string | null;
  modelPath: string | null;
  reason: string | null;
  needsBinary: boolean;
  needsModel: boolean;
  download: DownloadState;
  startDownload: () => Promise<{ ok: boolean; alreadyRunning?: boolean }>;
  pauseDownload: () => Promise<{ ok: boolean }>;
  cancelDownload: () => Promise<{ ok: boolean }>;
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
  binaryPath: string | null; modelPath: string | null; reason: string | null;
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
  };
}

export function useLlamacppState(): LlamaCppStateSnapshot {
  const [managerState, setManagerState] = useState<ManagerState>({ status: 'idle' });
  const [downloadState, setDownloadState] = useState<DownloadState>({ ...DEFAULT_DOWNLOAD });

  useEffect(() => {
    let cancelled = false;

    // Initial hydrate via IPC.
    (async () => {
      try {
        const platform = (window as unknown as { platform?: { llamacppGetState?: () => Promise<{ manager: ManagerState; download: DownloadState }> } }).platform;
        const snap = await platform?.llamacppGetState?.();
        if (cancelled || !snap) return;
        if (snap.manager) setManagerState(snap.manager);
        if (snap.download) setDownloadState(normaliseDownload(snap.download));
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
      if (!cancelled) setDownloadState(normaliseDownload(s));
    });
    const offDlState = platform?.onLlamacppDownloadState?.((s) => {
      if (!cancelled) setDownloadState(normaliseDownload(s));
    });

    return () => {
      cancelled = true;
      try { offState?.(); } catch { /* ignore */ }
      try { offProgress?.(); } catch { /* ignore */ }
      try { offDlState?.(); } catch { /* ignore */ }
    };
  }, []);

  const startDownload = useCallback(async (): Promise<{ ok: boolean; alreadyRunning?: boolean }> => {
    const platform = (window as unknown as { platform?: { llamacppStartDownload?: () => Promise<{ ok: boolean; alreadyRunning?: boolean }> } }).platform;
    try {
      const result = await platform?.llamacppStartDownload?.();
      return result || { ok: false };
    } catch (err) {
      console.warn('[useLlamacppState] startDownload failed:', err);
      return { ok: false };
    }
  }, []);

  const pauseDownload = useCallback(async (): Promise<{ ok: boolean }> => {
    const platform = (window as unknown as { platform?: { llamacppPauseDownload?: () => Promise<{ ok: boolean }> } }).platform;
    try {
      const result = await platform?.llamacppPauseDownload?.();
      return result || { ok: false };
    } catch (err) {
      console.warn('[useLlamacppState] pauseDownload failed:', err);
      return { ok: false };
    }
  }, []);

  const cancelDownload = useCallback(async (): Promise<{ ok: boolean }> => {
    const platform = (window as unknown as { platform?: { llamacppCancelDownload?: () => Promise<{ ok: boolean }> } }).platform;
    try {
      const result = await platform?.llamacppCancelDownload?.();
      return result || { ok: false };
    } catch (err) {
      console.warn('[useLlamacppState] cancelDownload failed:', err);
      return { ok: false };
    }
  }, []);

  const normalised = normaliseManager(managerState);
  return {
    ...normalised,
    download: downloadState,
    startDownload,
    pauseDownload,
    cancelDownload,
  };
}
