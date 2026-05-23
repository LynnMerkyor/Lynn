/**
 * ProviderStatusBadge.tsx — Compact model-route chip for the welcome screen.
 *
 * Local 4B state is sourced from the server-side /api/local-qwen35-9b/*
 * route so this chip, Settings, onboarding, and chat routing share the same
 * provider id and setup lifecycle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { useI18n } from '../hooks/use-i18n';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { loadModels } from '../utils/ui-helpers';
import { BRAIN_PROVIDER_ID, BRAIN_DEFAULT_MODEL_ID } from '../../../../shared/brain-provider.js';

const LOCAL_PROVIDER_ID = 'local-qwen3-4b-thinking-2507-q4km-imatrix';
const LOCAL_MODEL_ID = 'qwen3-4b-thinking-2507-q4km-imatrix';

type LocalStatus = {
  ok?: boolean;
  registered_provider?: boolean;
  runtime?: {
    endpoint_running?: boolean;
    endpoint_loading?: boolean;
    process_alive?: boolean;
    base_url?: string;
  };
  plan?: {
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
      gguf?: string | null;
      llama_server?: string | null;
    };
  };
  job?: {
    status?: string;
    progress?: {
      percent?: number | null;
      phase?: string;
    } | null;
  } | null;
};

function providerDisplayLabel(provider: string | null, isZh: boolean): string {
  if (!provider) return isZh ? '未配置' : 'No model';
  if (provider === BRAIN_PROVIDER_ID) return isZh ? '默认模型' : 'Default model';
  if (provider === LOCAL_PROVIDER_ID) return isZh ? '本地 4B' : 'Local 4B';
  return provider;
}

function isLocalReady(status: LocalStatus | null): boolean {
  return status?.runtime?.endpoint_running === true || status?.plan?.observed?.endpoint_running === true;
}

function isLocalBusy(status: LocalStatus | null): boolean {
  return !isLocalReady(status) && (
    status?.runtime?.endpoint_loading === true
      || status?.runtime?.process_alive === true
      || status?.plan?.observed?.endpoint_loading === true
      || status?.job?.status === 'running'
  );
}

function hasLocalAssets(status: LocalStatus | null): boolean {
  return !!(status?.plan?.observed?.gguf && status?.plan?.observed?.llama_server);
}

export function ProviderStatusBadge() {
  const { locale } = useI18n();
  const isZh = (locale || '').startsWith('zh');
  const currentModel = useStore((s) => s.currentModel);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refreshLocal = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 10_000 });
      const data = await res.json();
      setLocalStatus(data);
      if (data?.registered_provider && (data?.runtime?.endpoint_running || data?.plan?.observed?.endpoint_running)) {
        void loadModels();
      }
      return data as LocalStatus;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
    const id = window.setInterval(refreshLocal, 12_000);
    return () => window.clearInterval(id);
  }, [refreshLocal]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const t1 = window.setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    return () => {
      window.clearTimeout(t1);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [menuOpen]);

  const activeProvider = currentModel?.provider || null;
  const isLocalActive = activeProvider === LOCAL_PROVIDER_ID;
  const localReady = isLocalReady(localStatus);
  const localBusy = isLocalBusy(localStatus) || preparing;
  const localAssets = hasLocalAssets(localStatus);

  const { statusText, tone } = useMemo<{ statusText: string; tone: 'ready' | 'busy' | 'standby' | 'error' | 'cloud' }>(() => {
    if (!isLocalActive) {
      return { statusText: providerDisplayLabel(activeProvider, isZh), tone: 'cloud' };
    }
    if (localReady) return { statusText: isZh ? '本地就绪' : 'Local ready', tone: 'ready' };
    if (localBusy) {
      const percent = localStatus?.job?.progress?.percent;
      return {
        statusText: typeof percent === 'number' ? `${Math.round(percent)}%` : (isZh ? '准备中' : 'Preparing'),
        tone: 'busy',
      };
    }
    if (!localAssets) return { statusText: isZh ? '待准备' : 'Needs setup', tone: 'standby' };
    return { statusText: isZh ? '可启动' : 'Ready to start', tone: 'standby' };
  }, [activeProvider, isLocalActive, isZh, localAssets, localBusy, localReady, localStatus?.job?.progress?.percent]);

  const switchToProvider = useCallback(async (targetProvider: typeof BRAIN_PROVIDER_ID | typeof LOCAL_PROVIDER_ID) => {
    if (switching) return;
    setSwitching(true);
    setMenuOpen(false);
    try {
      const modelId = targetProvider === BRAIN_PROVIDER_ID ? BRAIN_DEFAULT_MODEL_ID : LOCAL_MODEL_ID;
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, provider: targetProvider }),
      });
      await loadModels();
    } catch (err) {
      console.warn('[ProviderStatusBadge] switch failed:', err);
    } finally {
      setSwitching(false);
    }
  }, [switching]);

  const prepareAndSwitchLocal = useCallback(async () => {
    if (preparing || switching) return;
    setPreparing(true);
    setMenuOpen(false);
    try {
      const latest = await refreshLocal();
      if (!isLocalReady(latest)) {
        const res = await hanaFetch('/api/local-qwen35-9b/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authorized: true, variant: 'imatrix', start: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.ok === false) throw new Error(data?.message || data?.error || 'setup_failed');
        setLocalStatus((prev) => ({ ...(prev || {}), job: data.job }));
      }
      window.setTimeout(() => void refreshLocal(), 1000);
      await switchToProvider(LOCAL_PROVIDER_ID);
    } catch (err) {
      console.warn('[ProviderStatusBadge] local setup failed:', err);
    } finally {
      setPreparing(false);
    }
  }, [preparing, refreshLocal, switching, switchToProvider]);

  const chipTitle = (() => {
    const provider = providerDisplayLabel(activeProvider, isZh);
    if (!isLocalActive) return `${provider}${currentModel?.id ? ` · ${currentModel.id}` : ''}`;
    const base = localStatus?.runtime?.base_url || 'http://127.0.0.1:18099/v1';
    return `${provider} · ${statusText} · ${base}`;
  })();

  return (
    <div ref={wrapRef} className={`provider-status-badge tone-${tone}`}>
      <button
        type="button"
        className="provider-status-chip"
        title={chipTitle}
        onClick={() => setMenuOpen((v) => !v)}
        disabled={switching || preparing}
      >
        <span className="provider-status-icon" aria-hidden>
          <span className="provider-status-dot" />
        </span>
        <span className="provider-status-label">{providerDisplayLabel(activeProvider, isZh)}</span>
        <span className="provider-status-sep">·</span>
        <span className="provider-status-status">{statusText}</span>
      </button>
      {menuOpen && (
        <div className="provider-status-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeProvider === BRAIN_PROVIDER_ID}
            className={`provider-status-menu-item${activeProvider === BRAIN_PROVIDER_ID ? ' is-active' : ''}`}
            onClick={() => void switchToProvider(BRAIN_PROVIDER_ID)}
            disabled={switching || preparing}
          >
            <span className="provider-status-menu-dot tone-cloud" aria-hidden />
            <span>{isZh ? '默认模型' : 'Default model'}</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeProvider === LOCAL_PROVIDER_ID}
            className={`provider-status-menu-item${activeProvider === LOCAL_PROVIDER_ID ? ' is-active' : ''}`}
            onClick={() => void (localReady ? switchToProvider(LOCAL_PROVIDER_ID) : prepareAndSwitchLocal())}
            disabled={switching || preparing}
          >
            <span className="provider-status-menu-dot tone-local" aria-hidden />
            <span>
              {localReady
                ? (isZh ? '本地 4B' : 'Local 4B')
                : localBusy
                  ? (isZh ? '本地 4B 准备中' : 'Local 4B preparing')
                  : (isZh ? '准备并切换本地 4B' : 'Prepare and switch to Local 4B')}
            </span>
          </button>
          {!localReady && (
            <div className="provider-status-menu-note">
              {isZh
                ? 'Lynn 会在授权后自动准备 llama.cpp、模型文件和本地端点。'
                : 'Lynn will prepare llama.cpp, the model file, and the local endpoint after authorization.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
