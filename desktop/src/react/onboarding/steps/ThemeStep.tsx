/**
 * ThemeStep.tsx — Step 4: Theme selection
 */

import { useMemo, useState } from 'react';
import settingsStyles from '../../settings/Settings.module.css';
import { OB_ADVANCED_THEMES, OB_PRIMARY_THEMES, themeKey } from '../constants';
import { StepContainer } from '../onboarding-ui';
import { useOnboardingI18n } from '../use-onboarding-i18n';

interface ThemeStepProps {
  goToStep: (index: number) => void;
  backStep?: number;
}

export function ThemeStep({ goToStep, backStep = 3 }: ThemeStepProps) {
  const { t, locale } = useOnboardingI18n();
  const isZh = (locale || '').startsWith('zh');
  const initialTheme = useMemo(() => localStorage.getItem('hana-theme') || 'warm-paper', []);
  const [activeTheme, setActiveTheme] = useState<string>(initialTheme);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(
    () => (OB_ADVANCED_THEMES as readonly string[]).includes(initialTheme),
  );

  const themes = showAdvanced
    ? [...OB_PRIMARY_THEMES, ...OB_ADVANCED_THEMES]
    : [...OB_PRIMARY_THEMES];

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.theme.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.theme.subtitle')}</p>

      <div className={settingsStyles['theme-options']}>
        {themes.map(theme => {
          const key = themeKey(theme);
          return (
            <button
              key={theme}
              className={`${settingsStyles['theme-card']}${activeTheme === theme ? ' ' + settingsStyles['active'] : ''}`}
              data-theme={theme}
              onClick={() => {
                setActiveTheme(theme);
                setTheme(theme);
              }}
            >
              <div className={settingsStyles['theme-card-name']}>{t(`settings.appearance.${key}`)}</div>
              <div className={settingsStyles['theme-card-mode']}>{t(`settings.appearance.${key}Mode`)}</div>
            </button>
          );
        })}
      </div>

      {!showAdvanced && (
        <button
          type="button"
          className="provider-more-toggle"
          onClick={() => setShowAdvanced(true)}
        >
          {isZh ? `+ 更多主题 (${OB_ADVANCED_THEMES.length})` : `+ More themes (${OB_ADVANCED_THEMES.length})`}
        </button>
      )}
      {showAdvanced && (
        <button
          type="button"
          className="provider-more-toggle"
          onClick={() => setShowAdvanced(false)}
        >
          {isZh ? '收起进阶主题' : 'Collapse advanced themes'}
        </button>
      )}

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(backStep)}>
          {t('onboarding.theme.back')}
        </button>
        <button className="ob-btn ob-btn-primary" onClick={() => goToStep(5)}>
          {t('onboarding.theme.next')}
        </button>
      </div>
    </StepContainer>
  );
}
