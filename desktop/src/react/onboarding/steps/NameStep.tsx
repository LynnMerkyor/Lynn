/**
 * NameStep.tsx — Name input for quick start / advanced setup
 */

import { useState, useCallback } from 'react';
import { saveUserName } from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer } from '../onboarding-ui';
import { useOnboardingI18n } from '../use-onboarding-i18n';

type OnboardingTrack = 'quick' | 'quick-local' | 'advanced';

interface NameStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  track: OnboardingTrack;
}

const LOCAL_MODEL_DOWNLOAD_STEP = 8;

function nextStepForTrack(track: OnboardingTrack): number {
  if (track === 'quick-local') return LOCAL_MODEL_DOWNLOAD_STEP;
  if (track === 'advanced') return 2;
  return 5;
}

export function NameStep({ preview, onboardingFetch, goToStep, showError, track }: NameStepProps) {
  const { t } = useOnboardingI18n();
  const [userName, setUserName] = useState('');
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const isQuickFlow = track === 'quick' || track === 'quick-local';

  const handleUploadAvatar = useCallback(async () => {
    if (uploadingAvatar) return;
    setUploadingAvatar(true);
    try {
      const platform = (window as unknown as { platform?: { uploadAvatar?: (role: string) => Promise<{ ok: boolean; path?: string; reason?: string }> } }).platform;
      const result = await platform?.uploadAvatar?.('user');
      if (result?.ok && result.path) {
        // Append a cache-busting query so the preview refreshes.
        setAvatarSrc(`file://${encodeURI(result.path)}?t=${Date.now()}`);
      } else if (result && !result.ok && result.reason !== 'cancelled') {
        showError(t('onboarding.error'));
      }
    } catch (err) {
      console.error('[onboarding] avatar upload failed:', err);
      showError(t('onboarding.error'));
    } finally {
      setUploadingAvatar(false);
    }
  }, [showError, t, uploadingAvatar]);

  const onNext = useCallback(async () => {
    const target = nextStepForTrack(track);
    if (preview) {
      goToStep(target);
      return;
    }

    const trimmed = userName.trim();
    try {
      if (trimmed) {
        await saveUserName(onboardingFetch, trimmed);
      }
      goToStep(target);
    } catch (err) {
      console.error('[onboarding] save name failed:', err);
      showError(t('onboarding.error'));
    }
  }, [goToStep, onboardingFetch, preview, showError, t, track, userName]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.name.title')}</h1>
      <p className="onboarding-subtitle">{t(isQuickFlow ? 'onboarding.name.quickSubtitle' : 'onboarding.name.subtitle')}</p>

      <div className="ob-avatar-upload-row">
        {avatarSrc && (
          <img
            className="ob-avatar-upload-preview"
            src={avatarSrc}
            alt=""
            draggable={false}
          />
        )}
        <button
          type="button"
          className="ob-btn ob-btn-secondary ob-avatar-upload-btn"
          disabled={uploadingAvatar}
          onClick={() => void handleUploadAvatar()}
        >
          {avatarSrc
            ? (uploadingAvatar ? t('onboarding.name.avatarUploading') : t('onboarding.name.avatarChange'))
            : (uploadingAvatar ? t('onboarding.name.avatarUploading') : t('onboarding.name.avatarUpload'))}
        </button>
      </div>

      <input
        className="ob-input"
        type="text"
        style={{ textAlign: 'center', maxWidth: 260 }}
        placeholder={t('onboarding.name.placeholder')}
        value={userName}
        onChange={e => setUserName(e.target.value)}
        autoComplete="off"
      />
      {isQuickFlow && <p className="ob-step-note">{t('onboarding.name.quickHint')}</p>}
      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(0)}>
          {t('onboarding.name.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          onClick={onNext}
        >
          {t(isQuickFlow ? 'onboarding.name.quickNext' : 'onboarding.name.next')}
        </button>
      </div>
    </StepContainer>
  );
}
