/**
 * ProviderStatusBadge.tsx — Compact provider chip rendered next to the
 * welcome focus-hint. Surfaces the active provider plus the live llama.cpp
 * download / health status, and lets the user switch providers (Brain v2 /
 * llamacpp) without entering Settings.
 *
 * Status iconography:
 *   ready                 → 🟢 + provider label
 *   downloading X% / paused / verifying → 📥 X%
 *   needs-model / idle    → 🟡 "standby"
 *   error / failed        → 🔴
 *   cloud (non-llamacpp) → ☁️ provider label
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { useI18n } from '../hooks/use-i18n';
import { useLlamacppState } from '../hooks/use-llamacpp-state';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { loadModels } from '../utils/ui-helpers';
import { BRAIN_PROVIDER_ID, BRAIN_DEFAULT_MODEL_ID } from '../../../../shared/brain-provider.js';

const LLAMACPP_PROVIDER_ID = 'llamacpp';
const LLAMACPP_DEFAULT_MODEL = 'qwen3.5-9b-q4km-imatrix';

function providerDisplayLabel(provider: string | null, isZh: boolean): string {
  if (!provider) return isZh ? '未配置' : 'No provider';
  if (provider === BRAIN_PROVIDER_ID) return isZh ? '默认模型' : 'Brain v2';
  if (provider === LLAMACPP_PROVIDER_ID) return isZh ? '本地 9B' : 'Local 9B';
  return provider;
}

export function ProviderStatusBadge() {
  const { t, locale } = useI18n();
  const isZh = (locale || '').startsWith('zh');
  const currentModel = useStore((s) => s.currentModel);
  const llamacpp = useLlamacppState();
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const t1 = window.setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    return () => { window.clearTimeout(t1); document.removeEventListener('mousedown', onDocClick); };
  }, [menuOpen]);

  const activeProvider = currentModel?.provider || null;
  const isLocalActive = activeProvider === LLAMACPP_PROVIDER_ID;

  // Derive the icon + status text from llama.cpp state when local is active,
  // otherwise treat as a cloud chip.
  const { icon, statusText, tone } = useMemo<{ icon: string; statusText: string; tone: 'ready' | 'busy' | 'standby' | 'error' | 'cloud' }>(() => {
    if (!isLocalActive) {
      return {
        icon: '☁️',
        statusText: providerDisplayLabel(activeProvider, isZh),
        tone: 'cloud',
      };
    }
    // local active → reflect llama.cpp state
    if (llamacpp.download.state === 'downloading' || llamacpp.download.state === 'verifying') {
      return {
        icon: '📥',
        statusText: `${llamacpp.download.percent}%`,
        tone: 'busy',
      };
    }
    if (llamacpp.download.state === 'paused') {
      return {
        icon: '⏸',
        statusText: isZh ? '已暂停' : 'Paused',
        tone: 'busy',
      };
    }
    if (llamacpp.status === 'ready' || llamacpp.status === 'standby') {
      return {
        icon: '🟢',
        statusText: isZh ? '本地就绪' : 'Local ready',
        tone: 'ready',
      };
    }
    if (llamacpp.status === 'crashed' || llamacpp.status === 'failed' || llamacpp.status === 'unhealthy') {
      return {
        icon: '🔴',
        statusText: isZh ? '推理服务异常' : 'Inference error',
        tone: 'error',
      };
    }
    if (llamacpp.status === 'needs-model' || llamacpp.status === 'needs-binary') {
      return {
        icon: '🟡',
        statusText: isZh ? '待安装' : 'Standby',
        tone: 'standby',
      };
    }
    return {
      icon: '🟡',
      statusText: isZh ? '待机' : 'Idle',
      tone: 'standby',
    };
  }, [activeProvider, isLocalActive, isZh, llamacpp.download.percent, llamacpp.download.state, llamacpp.status]);

  const switchToProvider = useCallback(async (targetProvider: 'brain' | 'llamacpp') => {
    if (switching) return;
    setSwitching(true);
    setMenuOpen(false);
    try {
      const modelId = targetProvider === BRAIN_PROVIDER_ID ? BRAIN_DEFAULT_MODEL_ID : LLAMACPP_DEFAULT_MODEL;
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

  const chipTitle = (() => {
    const provider = providerDisplayLabel(activeProvider, isZh);
    if (!isLocalActive) return `${provider}${currentModel?.id ? ` · ${currentModel.id}` : ''}`;
    if (llamacpp.download.state === 'downloading' || llamacpp.download.state === 'verifying') {
      return isZh
        ? `本地模型下载中 · ${llamacpp.download.percent}%`
        : `Local model downloading · ${llamacpp.download.percent}%`;
    }
    return `${provider}${llamacpp.modelPath ? ` · ${llamacpp.modelPath}` : ''}`;
  })();

  return (
    <div ref={wrapRef} className={`provider-status-badge tone-${tone}`}>
      <button
        type="button"
        className="provider-status-chip"
        title={chipTitle}
        onClick={() => setMenuOpen((v) => !v)}
        disabled={switching}
      >
        <span className="provider-status-icon" aria-hidden>{icon}</span>
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
            disabled={switching}
          >
            <span aria-hidden>☁️</span>
            <span>{isZh ? '云端默认 (Brain v2)' : 'Cloud default (Brain v2)'}</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeProvider === LLAMACPP_PROVIDER_ID}
            className={`provider-status-menu-item${activeProvider === LLAMACPP_PROVIDER_ID ? ' is-active' : ''}`}
            onClick={() => void switchToProvider(LLAMACPP_PROVIDER_ID)}
            disabled={switching || llamacpp.needsModel || llamacpp.needsBinary}
          >
            <span aria-hidden>🟢</span>
            <span>{isZh ? '本地 9B 离线模型' : 'Local 9B (offline)'}</span>
          </button>
          {(llamacpp.needsModel || llamacpp.needsBinary) && (
            <div className="provider-status-menu-note">
              {isZh ? '本地模型尚未就绪，请到引导页下载' : 'Local model not ready. Download via onboarding.'}
            </div>
          )}
        </div>
      )}
      {/* unused t to keep linter happy across locale switches */}
      <span style={{ display: 'none' }}>{t('welcome.focusHint')}</span>
    </div>
  );
}
