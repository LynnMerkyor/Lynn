/**
 * use-onboarding-i18n.ts — hook-shaped wrapper around the global onboarding
 * i18n module (`window.i18n` + `window.t`).
 *
 * The main renderer's `useI18n` lives in `hooks/use-i18n` and reads from
 * the zustand store; that store isn't mounted in the onboarding window
 * (separate Electron BrowserWindow loads `onboarding.html` without the
 * full app store). To keep the API shape consistent across the codebase
 * we expose the same `{ t, locale, i18n }` triple but subscribe to a
 * lightweight pub-sub that OnboardingApp pokes whenever the locale
 * changes (via `setOnboardingLocale`).
 *
 * Callers in the onboarding steps can swap their direct `t(...)` calls
 * for `const { t } = useOnboardingI18n();` to get reactive rerenders
 * without depending on the OnboardingApp re-mounting the subtree.
 */
import { useEffect, useState, useCallback } from 'react';

type Listener = (locale: string) => void;

const listeners = new Set<Listener>();
let currentLocale = '';

export function setOnboardingLocale(locale: string): void {
  currentLocale = locale;
  for (const fn of listeners) {
    try { fn(locale); } catch { /* ignore */ }
  }
}

export function getOnboardingLocale(): string {
  if (currentLocale) return currentLocale;
  try {
    if (typeof i18n !== 'undefined' && i18n.locale) return i18n.locale;
  } catch { /* not available */ }
  return '';
}

export interface OnboardingI18n {
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
  i18n: typeof i18n;
}

export function useOnboardingI18n(): OnboardingI18n {
  const [locale, setLocale] = useState<string>(() => getOnboardingLocale());

  useEffect(() => {
    const listener: Listener = (next) => setLocale(next);
    listeners.add(listener);
    // Also resync against any locale that was set before mount.
    const current = getOnboardingLocale();
    if (current && current !== locale) setLocale(current);
    return () => { listeners.delete(listener); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translate = useCallback(
    (path: string, vars?: Record<string, string | number>): string => {
      // referenced locale to ensure rerenders rebind translate identity
      void locale;
      try {
        if (typeof t === 'function') return t(path, vars);
      } catch { /* fall through */ }
      return path;
    },
    [locale],
  );

  // `i18n` global is declared via onboarding-env.d.ts.
  return {
    t: translate,
    locale,
    i18n: (typeof i18n !== 'undefined' ? i18n : ({ locale: '', defaultName: '', load: async () => {} } as typeof i18n)),
  };
}
