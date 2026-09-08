/** Lynn's window-side canopy. Code-native decoration; no video or avatar assets. */
import { memo, useEffect, useState } from 'react';
import { useLeavesOverlayEnabled } from '../hooks/use-leaves-overlay';
import styles from './LeavesOverlay.module.css';

function themeAllowsLeaves(): boolean {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme !== 'midnight' && theme !== 'high-contrast';
}

// Asymmetric branches leave the centre of the page open for reading.
const branches = [
  { x: 980, y: -50, angle: 33, scale: 1.35 },
  { x: 1240, y: 70, angle: 71, scale: 1.15 },
  { x: 1150, y: -100, angle: -12, scale: 1.2 },
  { x: -100, y: 200, angle: -62, scale: 0.85 },
];
const leaves = [
  [4, 46, -54, 0.7], [-10, 84, 52, 0.95], [0, 130, -60, 1],
  [-18, 169, 49, 1.1], [-12, 218, -56, 1.05], [-29, 263, 51, 0.9],
  [-30, 311, -39, 0.75], [-44, 351, 18, 0.6],
];

export const LeavesOverlay = memo(function LeavesOverlay() {
  const enabled = useLeavesOverlayEnabled();
  const [themeAllowed, setThemeAllowed] = useState(themeAllowsLeaves);
  const [hidden, setHidden] = useState(() => document.hidden);

  useEffect(() => {
    const onTheme = () => setThemeAllowed(themeAllowsLeaves());
    const onVisibility = () => setHidden(document.hidden);
    const observer = new MutationObserver(onTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('visibilitychange', onVisibility);
    onTheme();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!enabled || !themeAllowed) return null;
  return (
    <div className={styles.overlay} data-lynn-leaves-overlay="true" data-paused={hidden} aria-hidden="true">
      <div className={styles.windowLight} />
      <svg className={styles.canopy} viewBox="0 0 1440 900" preserveAspectRatio="xMidYMin slice" focusable="false">
        {branches.map((branch, index) => (
          <g key={index} transform={`translate(${branch.x} ${branch.y}) rotate(${branch.angle}) scale(${branch.scale})`}>
            <g className={styles.branch} style={{ animationDelay: `${index * -7}s`, animationDuration: `${28 + index * 5}s` }}>
              <path className={styles.stem} d="M0 0 C12 96 -2 185 -23 272 Q-31 328 -46 372" />
              {leaves.map(([x, y, angle, scale], leaf) => (
                <path key={leaf} className={styles.leaf} transform={`translate(${x} ${y}) rotate(${angle}) scale(${scale})`}
                  d="M0 0 C-22 12 -27 44 -5 77 C15 62 28 30 0 0Z" />
              ))}
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
});
