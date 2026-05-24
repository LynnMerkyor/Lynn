/**
 * LocalModelDownloadStep.tsx — Lynn default local model setup.
 *
 * This step intentionally uses the same server-side /api/local-qwen35-9b/*
 * lifecycle as Settings and chat routing. Keeping onboarding on the same
 * provider id avoids the old split where onboarding saved "llamacpp" while
 * the app routed through the local Qwen provider.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { saveProvider } from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';
import { useOnboardingI18n } from '../use-onboarding-i18n';
import { QUICK_LOCAL_PROVIDER } from '../constants';
import {
  BRAIN_PROVIDER_ID,
  BRAIN_PROVIDER_BASE_URL,
  BRAIN_PROVIDER_API,
  BRAIN_DEFAULT_MODEL_ID,
} from '../../../../../shared/brain-provider.js';

interface LocalModelDownloadStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  onProviderReady: (providerName: string, providerUrl: string, providerApi: string, apiKey: string) => void;
  nextStep: number;
  backStep: number;
}

type LocalSetupStatus = {
  ok?: boolean;
  registered_provider?: boolean;
  error?: string;
  runtime?: {
    endpoint_running?: boolean;
    endpoint_loading?: boolean;
    process_alive?: boolean;
    base_url?: string;
  };
  plan?: {
    base_url?: string;
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
      gguf?: string | null;
      llama_server?: string | null;
    };
    hardware?: {
      can_enable?: boolean;
      warnings?: string[];
      blockers?: string[];
      recommended_runtime?: {
        label?: string;
        ctx_size?: number;
        parallel?: number;
      };
    };
  };
  job?: {
    status?: string;
    log_file?: string;
    progress?: {
      phase?: string;
      percent?: number | null;
      downloaded?: string;
      total?: string;
      eta?: string;
      speed?: string;
      message?: string;
      tail?: string[];
    } | null;
  } | null;
};

function endpointReady(status: LocalSetupStatus | null): boolean {
  return status?.runtime?.endpoint_running === true || status?.plan?.observed?.endpoint_running === true;
}

function endpointLoading(status: LocalSetupStatus | null): boolean {
  return !endpointReady(status) && (
    status?.runtime?.endpoint_loading === true
      || status?.runtime?.process_alive === true
      || status?.plan?.observed?.endpoint_loading === true
      || status?.job?.status === 'running'
  );
}

function hasModelAndRuntime(status: LocalSetupStatus | null): boolean {
  return !!(status?.plan?.observed?.gguf && status?.plan?.observed?.llama_server);
}

export function LocalModelDownloadStep({
  preview, onboardingFetch, goToStep, showError, onProviderReady,
  nextStep, backStep,
}: LocalModelDownloadStepProps) {
  const { t } = useOnboardingI18n();
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [setupStarted, setSetupStarted] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await onboardingFetch('/api/local-qwen35-9b/status');
      const data = await res.json();
      setStatus(data);
      return data as LocalSetupStatus;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    }
  }, [onboardingFetch]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const ready = endpointReady(status);
  const busy = endpointLoading(status);
  const modelPrepared = hasModelAndRuntime(status);
  const jobRunning = status?.job?.status === 'running';
  const jobFailed = status?.job?.status === 'failed';
  const progress = status?.job?.progress || null;
  // #21: keep warnings and blockers visually separate
  const softWarnings: string[] = status?.plan?.hardware?.warnings || [];
  const hardBlockers: string[] = status?.plan?.hardware?.blockers || [];
  const hardwareBlocked = status?.plan?.hardware?.can_enable === false;
  const canStart = !busy && !ready && !hardwareBlocked;
  const progressPercent = typeof progress?.percent === 'number'
    ? Math.max(0, Math.min(100, progress.percent))
    : ready ? 100 : busy ? 45 : 0;

  useEffect(() => {
    if (!busy && !jobRunning) return undefined;
    const id = window.setInterval(() => {
      void refreshStatus();
    }, 1500);
    return () => window.clearInterval(id);
  }, [busy, jobRunning, refreshStatus]);

  const persistAndAdvance = useCallback(async () => {
    if (preview) {
      goToStep(nextStep);
      return;
    }
    if (savingProvider || providerSaved) return;
    setSavingProvider(true);
    try {
      await saveProvider({
        onboardingFetch,
        providerName: QUICK_LOCAL_PROVIDER.providerName,
        providerUrl: QUICK_LOCAL_PROVIDER.providerUrl,
        apiKey: '',
        providerApi: QUICK_LOCAL_PROVIDER.providerApi,
        defaultModelId: QUICK_LOCAL_PROVIDER.defaultModelId,
      });
      onProviderReady(QUICK_LOCAL_PROVIDER.providerName, QUICK_LOCAL_PROVIDER.providerUrl, QUICK_LOCAL_PROVIDER.providerApi, '');
      setProviderSaved(true);
      goToStep(nextStep);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showError(t('onboarding.error'));
    } finally {
      setSavingProvider(false);
    }
  }, [goToStep, nextStep, onProviderReady, onboardingFetch, preview, providerSaved, savingProvider, showError, t]);

  useEffect(() => {
    if (preview) return;
    if (ready && !providerSaved && !savingProvider) {
      void persistAndAdvance();
    }
  }, [persistAndAdvance, preview, providerSaved, ready, savingProvider]);

  const startSetup = useCallback(async () => {
    if (preview) {
      goToStep(nextStep);
      return;
    }
    setLoading(true);
    setSetupStarted(true);
    setError(null);
    try {
      const res = await onboardingFetch('/api/local-qwen35-9b/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorized: true, variant: 'imatrix', start: true }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.message || data?.error || 'setup_failed');
      }
      setStatus((prev) => ({ ...(prev || {}), job: data.job }));
      window.setTimeout(() => void refreshStatus(), 900);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showError(msg);
    } finally {
      setLoading(false);
    }
  }, [goToStep, nextStep, onboardingFetch, preview, refreshStatus, showError]);

  const fallbackToBrain = useCallback(async () => {
    if (preview) { goToStep(nextStep); return; }
    setSavingProvider(true);
    try {
      await saveProvider({
        onboardingFetch,
        providerName: BRAIN_PROVIDER_ID,
        providerUrl: BRAIN_PROVIDER_BASE_URL,
        apiKey: '',
        providerApi: BRAIN_PROVIDER_API,
        defaultModelId: BRAIN_DEFAULT_MODEL_ID,
      });
      onProviderReady(BRAIN_PROVIDER_ID, BRAIN_PROVIDER_BASE_URL, BRAIN_PROVIDER_API, '');
      goToStep(nextStep);
    } catch (err) {
      console.error('[onboarding] brain fallback failed:', err);
      showError(t('onboarding.error'));
    } finally {
      setSavingProvider(false);
    }
  }, [goToStep, nextStep, onProviderReady, onboardingFetch, preview, showError, t]);

  const statusLine = useMemo(() => {
    if (error) return error;
    if (ready) return t('onboarding.localModel.spawnReady');
    if (jobFailed) return t('onboarding.localModel.spawnFailed', { reason: status?.job?.progress?.message || 'setup_failed' });
    if (busy) return progress?.message || progress?.phase || t('onboarding.localModel.spawning');
    if (modelPrepared) return t('onboarding.localModel.modelPreparedHint');
    return t('onboarding.localModel.subtitle');
  }, [busy, error, jobFailed, modelPrepared, progress?.message, progress?.phase, ready, status?.job?.progress?.message, t]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.localModel.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.localModel.subtitle')} />
      <p className="ob-step-note">{t('onboarding.localModel.specsLine')}</p>

      <div className="local-model-progress" role="status" aria-live="polite">
        <div className="local-model-progress-bar">
          <div
            className="local-model-progress-fill"
            style={{ width: `${Math.max(2, progressPercent)}%` }}
          />
        </div>
        <div className="local-model-progress-meta">
          <span>{ready ? '100%' : busy ? `${Math.round(progressPercent)}%` : modelPrepared ? t('onboarding.localModel.statusReady') : t('onboarding.localModel.statusWaiting')}</span>
          <span>{status?.plan?.hardware?.recommended_runtime?.label || t('onboarding.localModel.runtimeLocalDefault')}</span>
        </div>
        <div className={`local-model-progress-substatus${error || jobFailed ? ' is-error' : ''}`}>
          {statusLine}
        </div>
      </div>

      {/* #21+#22: hard blockers (red) get prominent display + actionable hint;
          soft warnings (grey) stay subtle */}
      {hardBlockers.length > 0 && (
        <div className="ob-step-blocker" style={{
          marginTop: 12,
          padding: '10px 12px',
          borderRadius: 8,
          background: 'rgba(255, 78, 78, 0.08)',
          border: '1px solid rgba(255, 78, 78, 0.35)',
          color: '#b73a3a',
          fontSize: 13,
          lineHeight: 1.55,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {hardwareBlocked ? '⚠ ' : ''}{hardBlockers[0]}
          </div>
          {hardBlockers.slice(1).map((b, i) => (
            <div key={i} style={{ marginTop: 4 }}>{b}</div>
          ))}
          {hardwareBlocked && (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
              {t('onboarding.localModel.switchBackBtn')} →
            </div>
          )}
        </div>
      )}
      {softWarnings.length > 0 && (
        <p className="ob-step-note">{softWarnings.join(' ')}</p>
      )}

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(backStep)}>
          {t('onboarding.localModel.back')}
        </button>
        {ready ? (
          <button className="ob-btn ob-btn-primary" disabled={savingProvider} onClick={() => void persistAndAdvance()}>
            {t('onboarding.localModel.next')}
          </button>
        ) : (
          <button className="ob-btn ob-btn-primary" disabled={!canStart || loading} onClick={() => void startSetup()}>
            {busy || loading
              ? t('onboarding.localModel.spawning')
              : setupStarted || jobFailed
                ? t('onboarding.localModel.retryBtn')
                : t('onboarding.localModel.startBtn')}
          </button>
        )}
        {/* #24: download-in-progress cancel UX — if download is busy, allow user to cancel/skip */}
        {busy && !ready && (
          <button
            className="ob-btn ob-btn-secondary"
            onClick={() => {
              const platform = (window as unknown as { platform?: { llamacppCancelDownload?: () => Promise<unknown> } }).platform;
              try {
                void platform?.llamacppCancelDownload?.();
              } catch { /* best-effort */ }
            }}
            title={t('onboarding.localModel.cancelBtn')}
          >
            {t('onboarding.localModel.cancelBtn')}
          </button>
        )}
        <button className="ob-btn ob-btn-secondary" disabled={savingProvider} onClick={() => void fallbackToBrain()}>
          {t('onboarding.localModel.switchBackBtn')}
        </button>
      </div>
    </StepContainer>
  );
}
