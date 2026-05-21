/**
 * LocalModelDownloadStep.tsx — Step 2.5: Download / verify / spawn
 * the Lynn-default local model (Qwen 3.5 9B Q4_K_M-imatrix · 5.3 GB).
 *
 * Triggered when the user picks the 'quick-local' track or selects the
 * llamacpp provider in advanced setup. Owns:
 *   - hydrate llama.cpp manager state via use-llamacpp-state
 *   - render progress / pause / resume / cancel
 *   - on completion: wait for llama-server /health 200, save provider
 *     config, then call goToStep(next)
 *   - on hard failure: offer fallback to Brain v2 default
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLlamacppState } from '../../hooks/use-llamacpp-state';
import { saveProvider } from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';
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
  /** Where to go after success. Quick-local jumps to permissions (5). */
  nextStep: number;
  /** Where the back button goes (0 = locale picker, 2 = provider picker). */
  backStep: number;
}

const LOCAL_PROVIDER = {
  name: 'llamacpp',
  url: 'http://127.0.0.1:18099/v1',
  api: 'openai-completions',
  modelId: 'qwen3.5-9b-q4km-imatrix',
} as const;

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function LocalModelDownloadStep({
  preview, onboardingFetch, goToStep, showError, onProviderReady,
  nextStep, backStep,
}: LocalModelDownloadStepProps) {
  const llamacpp = useLlamacppState();
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  const isZh = (typeof i18n !== 'undefined' && i18n.locale?.startsWith('zh')) || false;
  const copyText = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);

  // ─── derived UI state ───────────────────────────────────────
  // The local-model step has four high-level "screens":
  //   1. needs-binary → guidance to install llama.cpp
  //   2. needs-model + idle → start download
  //   3. needs-model + downloading|verifying|paused → progress + controls
  //   4. ready / healthy → success / next
  const downloadActive = useMemo(() => (
    llamacpp.download.state === 'downloading' || llamacpp.download.state === 'verifying'
  ), [llamacpp.download.state]);

  const downloadPaused = llamacpp.download.state === 'paused' || llamacpp.download.paused;
  const downloadDone = llamacpp.download.state === 'done';
  const downloadError = llamacpp.download.state === 'error';

  // llama-server is up + responsive — proceed.
  const serverReady = (llamacpp.status === 'ready' || llamacpp.status === 'standby') && !!llamacpp.healthy;

  // ─── persist provider + advance once server is ready ────────
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
        providerName: LOCAL_PROVIDER.name,
        providerUrl: LOCAL_PROVIDER.url,
        apiKey: '',
        providerApi: LOCAL_PROVIDER.api,
        defaultModelId: LOCAL_PROVIDER.modelId,
      });
      onProviderReady(LOCAL_PROVIDER.name, LOCAL_PROVIDER.url, LOCAL_PROVIDER.api, '');
      setProviderSaved(true);
      goToStep(nextStep);
    } catch (err) {
      console.error('[onboarding] save llamacpp provider failed:', err);
      const reason = err instanceof Error ? err.message : String(err);
      setAdvanceError(reason);
      showError(t('onboarding.error'));
    } finally {
      setSavingProvider(false);
    }
  }, [goToStep, nextStep, onProviderReady, onboardingFetch, preview, providerSaved, savingProvider, showError]);

  // Auto-advance the first time the server reports ready.
  useEffect(() => {
    if (preview) return;
    if (serverReady && !providerSaved && !savingProvider) {
      void persistAndAdvance();
    }
  }, [preview, persistAndAdvance, providerSaved, savingProvider, serverReady]);

  // ─── handlers ───────────────────────────────────────────────
  const onStart = useCallback(() => {
    setAdvanceError(null);
    void llamacpp.startDownload();
  }, [llamacpp]);

  const onPause = useCallback(() => { void llamacpp.pauseDownload(); }, [llamacpp]);
  const onResume = useCallback(() => { void llamacpp.startDownload(); }, [llamacpp]);
  const onCancel = useCallback(() => { void llamacpp.cancelDownload(); }, [llamacpp]);

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
  }, [goToStep, nextStep, onProviderReady, onboardingFetch, preview, showError]);

  // ─── progress strings ───────────────────────────────────────
  const percent = llamacpp.download.percent;
  const transferred = llamacpp.download.bytesTransferred;
  const total = llamacpp.download.totalBytes;
  const sourceLabel = llamacpp.download.activeSource || '';

  const subStatusText = (() => {
    if (advanceError) return t('onboarding.localModel.spawnFailed', { reason: advanceError });
    if (downloadError) {
      if (llamacpp.download.lastError === 'all-sources-failed') return t('onboarding.localModel.errorAll');
      if (llamacpp.download.lastError === 'checksum-failed') return t('onboarding.localModel.errorChecksum');
      return t('onboarding.localModel.errorGeneric', { reason: llamacpp.download.lastError || 'unknown' });
    }
    if (downloadPaused) return t('onboarding.localModel.paused');
    if (llamacpp.download.state === 'verifying') return t('onboarding.localModel.verifying');
    if (llamacpp.download.state === 'downloading') {
      return t('onboarding.localModel.downloading', { source: sourceLabel || (isZh ? '镜像' : 'mirror') });
    }
    if (downloadDone && !serverReady) return t('onboarding.localModel.spawning');
    if (serverReady) return t('onboarding.localModel.spawnReady');
    return '';
  })();

  // ─── render ─────────────────────────────────────────────────
  // Case A: binary missing — can't proceed via UI download; guide install + offer brain fallback.
  if (llamacpp.needsBinary) {
    return (
      <StepContainer>
        <h1 className="onboarding-title">{t('onboarding.localModel.title')}</h1>
        <Multiline className="onboarding-subtitle" text={t('onboarding.localModel.needsBinary')} />
        <p className="ob-step-note">{t('onboarding.localModel.needsBinaryHint')}</p>

        <div className="onboarding-actions">
          <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(backStep)}>
            {t('onboarding.localModel.back')}
          </button>
          <button className="ob-btn ob-btn-primary" disabled={savingProvider} onClick={() => void fallbackToBrain()}>
            {t('onboarding.localModel.switchBackBtn')}
          </button>
        </div>
      </StepContainer>
    );
  }

  // Case B: model on disk + server already healthy.
  if (serverReady && !llamacpp.needsModel) {
    return (
      <StepContainer>
        <h1 className="onboarding-title">{t('onboarding.localModel.alreadyHave')}</h1>
        <Multiline className="onboarding-subtitle" text={t('onboarding.localModel.alreadyHaveDesc')} />
        <p className="ob-step-note">{t('onboarding.localModel.specsLine')}</p>
        <div className="onboarding-actions">
          <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(backStep)}>
            {t('onboarding.localModel.back')}
          </button>
          <button
            className="ob-btn ob-btn-primary"
            disabled={savingProvider}
            onClick={() => void persistAndAdvance()}
          >
            {t('onboarding.localModel.next')}
          </button>
        </div>
      </StepContainer>
    );
  }

  // Case C: download flow (idle / downloading / verifying / paused / error / done-waiting-spawn).
  const canStart = llamacpp.download.state === 'idle' && !downloadActive;
  const showProgressBar = downloadActive || downloadPaused || downloadDone;

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.localModel.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.localModel.subtitle')} />
      <p className="ob-step-note">{t('onboarding.localModel.specsLine')}</p>

      {showProgressBar && (
        <div className="local-model-progress" role="status" aria-live="polite">
          <div className="local-model-progress-bar">
            <div
              className="local-model-progress-fill"
              style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
            />
          </div>
          <div className="local-model-progress-meta">
            <span>{percent}%</span>
            <span>{formatBytes(transferred)} / {formatBytes(total || 5_300_000_000)}</span>
          </div>
          {subStatusText && (
            <div className={`local-model-progress-substatus${downloadError || advanceError ? ' is-error' : ''}`}>
              {subStatusText}
            </div>
          )}
        </div>
      )}

      {!showProgressBar && subStatusText && (
        <div className={`local-model-substatus${downloadError ? ' is-error' : ''}`}>{subStatusText}</div>
      )}

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(backStep)}>
          {t('onboarding.localModel.back')}
        </button>

        {canStart && (
          <button className="ob-btn ob-btn-primary" onClick={onStart}>
            {t('onboarding.localModel.startBtn')}
          </button>
        )}

        {downloadActive && (
          <>
            <button className="ob-btn ob-btn-secondary" onClick={onPause}>
              {t('onboarding.localModel.pauseBtn')}
            </button>
            <button className="ob-btn ob-btn-secondary" onClick={onCancel}>
              {t('onboarding.localModel.cancelBtn')}
            </button>
          </>
        )}

        {downloadPaused && (
          <>
            <button className="ob-btn ob-btn-primary" onClick={onResume}>
              {t('onboarding.localModel.resumeBtn')}
            </button>
            <button className="ob-btn ob-btn-secondary" onClick={onCancel}>
              {t('onboarding.localModel.cancelBtn')}
            </button>
          </>
        )}

        {downloadError && (
          <>
            <button className="ob-btn ob-btn-primary" onClick={onStart}>
              {t('onboarding.localModel.retryBtn')}
            </button>
            <button className="ob-btn ob-btn-secondary" onClick={() => void fallbackToBrain()}>
              {t('onboarding.localModel.switchBackBtn')}
            </button>
          </>
        )}

        {downloadDone && !serverReady && (
          <button className="ob-btn ob-btn-primary" disabled>
            {t('onboarding.localModel.spawning')}
          </button>
        )}
      </div>

      {!canStart && !downloadActive && !downloadPaused && !downloadDone && !downloadError && llamacpp.status !== 'ready' && llamacpp.status !== 'standby' && (
        <p className="ob-step-note" style={{ marginTop: 12 }}>
          {copyText(
            '尚未开始下载。点击「开始下载」即可。',
            'Click "Start download" to begin.',
          )}
        </p>
      )}
    </StepContainer>
  );
}
