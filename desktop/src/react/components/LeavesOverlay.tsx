/**
 * Adapted from liliMozi/openhanako LeavesOverlay (Apache-2.0), commit 1d3ef308.
 * Lynn changes: restrained edge lighting, accessible preferences, theme gating,
 * cross-window synchronization, and visibility-aware playback. See asset NOTICE.
 */
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
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReducedMotion(motion.matches);
    const onTheme = () => setThemeAllowed(themeAllowsLeaves());
    const observer = new MutationObserver(onTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    motion.addEventListener('change', onMotion);
    onMotion();
    onTheme();
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', onMotion);
    };
  }, []);

  useEffect(() => { setFailed(false); }, [enabled]);
  const active = enabled && themeAllowed && !reducedMotion && !failed;

  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video) return;
    const updatePlayback = () => {
      if (document.hidden) video.pause();
      else void video.play().catch(() => { /* Decoration must never interrupt work. */ });
    };
    document.addEventListener('visibilitychange', updatePlayback);
    video.addEventListener('canplay', updatePlayback);
    updatePlayback();
    return () => {
      document.removeEventListener('visibilitychange', updatePlayback);
      video.removeEventListener('canplay', updatePlayback);
      video.pause();
    };
  }, [active]);

  if (!active) return null;
  return (
    <video
      ref={videoRef}
      className={styles.overlay}
      data-lynn-leaves-overlay="true"
      src={leavesSrc}
      loop
      muted
      playsInline
      preload="auto"
      disablePictureInPicture
      tabIndex={-1}
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  );
});
