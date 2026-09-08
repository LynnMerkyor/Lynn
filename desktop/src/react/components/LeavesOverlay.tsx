/** Natural tree-shadow footage from openhanako (Apache-2.0); see asset NOTICE. */
import { memo, useEffect, useRef, useState } from 'react';
import { useLeavesOverlayEnabled } from '../hooks/use-leaves-overlay';
import leavesSrc from '../../assets/textures/leaves-overlay.mp4';
import styles from './LeavesOverlay.module.css';

function themeAllowsLeaves(): boolean {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme !== 'midnight' && theme !== 'high-contrast';
}

export const LeavesOverlay = memo(function LeavesOverlay() {
  const enabled = useLeavesOverlayEnabled();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [themeAllowed, setThemeAllowed] = useState(themeAllowsLeaves);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReducedMotion(motion.matches);
    const onTheme = () => setThemeAllowed(themeAllowsLeaves());
    const onVisibility = () => setHidden(document.hidden);
    const observer = new MutationObserver(onTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    motion.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    onMotion();
    onTheme();
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => { setFailed(false); }, [enabled]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const updatePlayback = () => {
      if (hidden || reducedMotion) video.pause();
      else void video.play().catch(() => { /* A blocked decoration must not interrupt work. */ });
    };
    video.addEventListener('canplay', updatePlayback);
    updatePlayback();
    return () => {
      video.removeEventListener('canplay', updatePlayback);
      video.pause();
    };
  }, [enabled, themeAllowed, hidden, reducedMotion, failed]);

  if (!enabled || !themeAllowed || failed) return null;
  return (
    <div className={styles.overlay} data-lynn-leaves-overlay="true" aria-hidden="true">
      <div className={styles.windowLight} />
      <video
        ref={videoRef}
        className={styles.video}
        src={leavesSrc}
        loop
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        disableRemotePlayback
        tabIndex={-1}
        onError={() => setFailed(true)}
      />
    </div>
  );
});

export function LeavesOverlayHint() {
  const enabled = useLeavesOverlayEnabled();
  if (!enabled) return null;
  const t = (key: string) => window.t?.(key) ?? key;
  return (
    <button
      type="button"
      className={styles.settingsHint}
      data-lynn-leaves-settings="true"
      aria-label={t('settings.appearance.leavesOverlayAction')}
      aria-describedby="leaves-settings-tooltip"
      onClick={() => window.platform?.openSettings?.('interface')}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 4C9 2 3 7 5 14c2 7 12 6 15-10Z" />
        <path d="M4 21C7 14 10 11 15 8" />
      </svg>
      <span className={styles.hintLabel}>{t('settings.appearance.leavesOverlayShort')}</span>
      <span className={styles.tooltip} role="tooltip" id="leaves-settings-tooltip">
        {t('settings.appearance.leavesOverlayCloseHint')}
      </span>
    </button>
  );
}
